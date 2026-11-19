import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.DB_DIR = 'memory://';
const { initDb, db } = await import('../src/db/index.js');
const { processFile } = await import('../src/pipeline/processor.js');
const { GeoStore } = await import('../src/geo.js');
const { ourDriverFor, triniumDriverFor } = await import('../src/drivers.js');
const { summarize204, summarizeOrder, compareOrder } = await import('../src/pipeline/compare.js');
const { parse204 } = await import('../src/edi/parser.js');

const here = dirname(fileURLToPath(import.meta.url));
const raw0 = readFileSync(join(here, 'fixtures', 'create_ecl.txt'), 'latin1');
const geo = GeoStore.fromCsvFile(join(here, '..', 'data', 'Geo.csv'));
const withDriver = id => raw0.replace('L11*OALM*TB', `L11*OALM*TB\nL11*${id}*DR`);
const run = raw => processFile({ fileName: 'f.txt', raw, geo, topic: 't' }).then(r => r[0]);

before(async () => {
  await initDb();
  await db().query(`INSERT INTO driver_mapping (trinium_driver_id, driver_id, driver_name) VALUES ('AMIT','D-SAV2260','Amit')`);
});

test('lookups are case-insensitive, both directions; inactive rows are ignored', async () => {
  assert.equal(await ourDriverFor(db(), ' amit '), 'D-SAV2260');
  assert.equal(await triniumDriverFor(db(), 'd-sav2260'), 'AMIT');
  assert.equal(await ourDriverFor(db(), 'NOBODY'), null);
  assert.equal(await ourDriverFor(db(), ''), null);
  await db().query(`INSERT INTO driver_mapping (trinium_driver_id, driver_id, active) VALUES ('OLD','D-OLD',false)`);
  assert.equal(await ourDriverFor(db(), 'OLD'), null);
});

test('204 driver AMIT -> Kafka payload carries D-SAV2260; the leg keeps the Trinium id', async () => {
  const r = await run(withDriver('AMIT'));
  assert.equal(r.payload.driverId, 'D-SAV2260');
  const leg = (await db().query('SELECT driver_code, payload FROM trinium_legs')).rows[0];
  assert.equal(leg.driver_code, 'AMIT');
  assert.equal(leg.payload.driverId, 'D-SAV2260');
  const queued = (await db().query('SELECT payload FROM outbound_messages ORDER BY id DESC LIMIT 1')).rows[0].payload;
  assert.equal(queued.driverId, 'D-SAV2260');
});

test('unmapped driver is passed through unchanged and flagged DRIVER_UNMAPPED; mapped one is DRIVER_MAPPED', async () => {
  const codes = async (id, rawIn) => {
    const r = await run(rawIn);
    const tx = parse204(rawIn).transactions[0];
    return { r, codes: compareOrder(summarize204(parse204(rawIn).isa, tx), summarizeOrder(r), r.warnings).map(i => i.code) };
  };
  const u = await codes('ZZZ', withDriver('ZZZ').replace(/\*\d{6}\*\d{4}\*U\*00401\*\d{9}/, '*261102*0900*U*00401*000000777'));
  assert.equal(u.r.payload.driverId, 'ZZZ');
  assert.ok(u.codes.includes('DRIVER_UNMAPPED'));
  const m = await codes('AMIT', withDriver('AMIT').replace(/\*\d{6}\*\d{4}\*U\*00401\*\d{9}/, '*261102*0901*U*00401*000000778'));
  assert.equal(m.r.payload.driverId, 'D-SAV2260');
  assert.ok(m.codes.includes('DRIVER_MAPPED'));
});
