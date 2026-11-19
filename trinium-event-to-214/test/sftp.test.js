import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.DB_DIR = 'memory://';
process.env.PROCESSING_MODE = 'kafka';
const { initDb, db } = await import('../src/db/index.js');
const { flushFiles, loadConfig } = await import('../src/processor.js');
const { consumerEnabled } = await import('../src/kafka/consumer.js');

const quiet = { log() {}, error() {} };
const fake = { files: {}, failPut: false,
  put: async (buf, p) => { if (fake.failPut) throw new Error('permission denied'); fake.files[p] = Buffer.from(buf); },
  rename: async (a, b) => { fake.files[b] = fake.files[a]; delete fake.files[a]; } };

before(async () => {
  await initDb();
  await db().query(`INSERT INTO edi214_sent (dispatch_seq, at7_code, event_time_local, idempotency_key, isa_control, file_name, content, sftp_status)
    VALUES ('900','AF','202611041300','k1','000000001','214_test.edi','ISA*00~','PENDING')`);
});

test('kafka mode config: SFTP delivery on, consumer on', () => {
  assert.equal(loadConfig().sftpOut, true);
  assert.equal(consumerEnabled(), true);
  assert.equal(loadConfig({ PROCESSING_MODE: 'local' }).sftpOut, false);
});

test('214 is written locally, uploaded to the SFTP 214 folder, and a failed upload is retried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'edi214-'));
  fake.failPut = true;
  await flushFiles(dir, { sftpClient: fake });
  assert.deepEqual(readdirSync(dir), ['214_test.edi']);                          // local copy always written first
  assert.equal(readFileSync(join(dir, '214_test.edi'), 'latin1'), 'ISA*00~');
  let r = (await db().query(`SELECT status, sftp_status, sftp_error FROM edi214_sent`)).rows[0];
  assert.deepEqual([r.status, r.sftp_status], ['WRITTEN', 'PENDING']);          // upload failed -> stays pending
  assert.match(r.sftp_error, /permission denied/);

  fake.failPut = false;
  await flushFiles(dir, { sftpClient: fake });
  assert.equal(fake.files['214in/214_test.edi'].toString('latin1'), 'ISA*00~');  // atomic: temp name renamed into place
  assert.deepEqual(Object.keys(fake.files), ['214in/214_test.edi']);
  r = (await db().query(`SELECT sftp_status, sftp_sent_at FROM edi214_sent`)).rows[0];
  assert.equal(r.sftp_status, 'SENT');
  assert.ok(r.sftp_sent_at);
});
