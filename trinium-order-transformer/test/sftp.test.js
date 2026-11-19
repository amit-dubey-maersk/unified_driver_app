import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const base = mkdtempSync(join(tmpdir(), 'edi-'));
process.env.DB_DIR = 'memory://';
process.env.EDI_BASE_DIR = base;
process.env.EDI_STABLE_MS = '0';
process.env.PROCESSING_MODE = 'kafka';
process.env.KAFKA_ENABLED = 'false'; // no broker in tests: messages stay PENDING in the outbox
const { initDb, db } = await import('../src/db/index.js');
const { scanOnce } = await import('../src/pipeline/watcher.js');
const { GeoStore } = await import('../src/geo.js');
const { processingMode } = await import('../src/mode.js');

const here = dirname(fileURLToPath(import.meta.url));
const geo = GeoStore.fromCsvFile(join(here, '..', 'data', 'Geo.csv'));
const fx = n => readFileSync(join(here, 'fixtures', n));

/** In-memory stand-in for ssh2-sftp-client (paths are 'dir/name'). */
const fakeSftp = files => ({
  files,
  moves: [],
  list: async d => Object.entries(files).filter(([p]) => p.startsWith(`${d}/`))
    .map(([p]) => ({ name: p.slice(d.length + 1), type: '-', modifyTime: 1 })),
  get: async p => files[p],
  exists: async p => (p in files ? '-' : false),
  rename: async (a, b) => { files[b] = files[a]; delete files[a]; },
});

before(() => initDb());

test('mode defaults to local and rejects junk', () => {
  assert.equal(processingMode({}), 'local');
  assert.equal(processingMode({ PROCESSING_MODE: ' KAFKA ' }), 'kafka');
  assert.throws(() => processingMode({ PROCESSING_MODE: 'sftp' }), /local.*kafka/);
});

test('kafka mode: 204 read from SFTP, archived on SFTP, copies kept locally, payload queued for Kafka', async () => {
  const c = fakeSftp({ '204out/a.txt': fx('create_fcl.txt'), '204out/bad.txt': Buffer.from('not edi') });
  const r = await scanOnce({ geo, topic: 't', sftpClient: c, log: { log() {}, error() {} } });

  assert.equal(r.find(x => x.file === 'a.txt').results[0].outcome, 'CREATED');
  assert.ok(r.find(x => x.file === 'bad.txt').error);
  // nothing left in 204out; good file in 204archive, bad one parked there as REJECTED_*
  assert.deepEqual(Object.keys(c.files).filter(k => k.startsWith('204out/')), []);
  assert.ok(c.files['204archive/a.txt']);
  assert.ok(Object.keys(c.files).some(k => /^204archive\/REJECTED_.*_bad\.txt$/.test(k)));
  // our layer keeps raw copy + processed JSON (+ error reason)
  assert.deepEqual(readdirSync(join(base, 'archive')), ['a.txt']);
  assert.deepEqual(readdirSync(join(base, 'processed')).length, 1);
  assert.ok(readdirSync(join(base, 'error')).includes('bad.txt.error.txt'));
  // and the order message is in the outbox for Kafka
  const q = await db().query(`SELECT status FROM outbound_messages`);
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].status, 'PENDING');
});

test('SFTP move failure leaves the file for the next pass (idempotent re-processing)', async () => {
  const c = fakeSftp({ '204out/b.txt': fx('create_ecl.txt') });
  const real = c.rename;
  c.rename = async () => { throw new Error('permission denied'); };
  const r1 = await scanOnce({ geo, topic: 't', sftpClient: c, log: { log() {}, error() {} } });
  assert.equal(r1[0].retry, true);
  assert.ok(c.files['204out/b.txt']);
  c.rename = real;
  const r2 = await scanOnce({ geo, topic: 't', sftpClient: c, log: { log() {}, error() {} } });
  // the DB write of pass 1 persisted, so the retry is a NOOP: it only completes the archive move, nothing is queued twice
  assert.equal(r2[0].results[0].outcome, 'NOOP');
  assert.ok(c.files['204archive/b.txt']);
  assert.equal((await db().query(`SELECT 1 FROM outbound_messages`)).rows.length, 2); // a.txt + b.txt, once each
});
