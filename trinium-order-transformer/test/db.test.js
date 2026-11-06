import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.DB_DIR = 'memory://';
const { initDb, db, classify } = await import('../src/db/index.js');
const { GeoStore } = await import('../src/geo.js');
const { saveGeoRows, GeoCache } = await import('../src/geoDb.js');
const { loadRefData, tzForState } = await import('../src/refdata.js');

const here = dirname(fileURLToPath(import.meta.url));
before(() => initDb());

test('retry classification: connection loss vs. server rollback vs. bug', () => {
  assert.equal(classify({ code: 'ECONNREFUSED' }), 'safe');
  assert.equal(classify({ message: 'timeout exceeded when trying to connect' }), 'safe');
  assert.equal(classify({ code: '40P01' }), 'rolled-back');
  assert.equal(classify({ code: '57P01' }), 'rolled-back');
  assert.equal(classify({ message: 'Connection terminated unexpectedly' }), 'ambiguous');
  assert.equal(classify({ code: '23505' }), 'fatal'); // unique violation is never retried
  assert.equal(classify({ code: '42P01' }), 'fatal'); // missing table is never retried
});

test('geo: CSV -> table is idempotent, and lookups from the table equal lookups from the CSV', async () => {
  const csv = join(here, '..', 'data', 'Geo.csv');
  const rows = GeoStore.readCsvRows(csv);
  const a = await saveGeoRows(db(), rows, { source: 'test' });
  const n1 = (await db().query('SELECT COUNT(*)::int n FROM ref_geo_location')).rows[0].n;
  const b = await saveGeoRows(db(), rows, { source: 'test' }); // again: no duplicates
  const n2 = (await db().query('SELECT COUNT(*)::int n FROM ref_geo_location')).rows[0].n;
  assert.equal(n1, n2);
  assert.equal(b.removed, 0);
  assert.ok(a.rows >= n1 - 0 && n1 > 100);

  const cache = await GeoCache.create(db(), { refreshMs: 0 });
  const mem = new GeoStore(rows);
  assert.equal(cache.size, n1);
  let compared = 0;
  for (const r of rows.slice(0, 400)) {
    const x = cache.find(r.name, r.address1, r.zip), y = mem.find(r.name, r.address1, r.zip);
    assert.deepEqual({ ...x }, { ...y }, `same match for "${r.name}"`);
    compared++;
  }
  assert.ok(compared > 0);
});

test('geo: a load that would wipe most of the table is refused and changes nothing', async () => {
  const before = (await db().query('SELECT COUNT(*)::int n FROM ref_geo_location')).rows[0].n;
  const tiny = GeoStore.readCsvRows(join(here, '..', 'data', 'Geo.csv')).slice(0, 3);
  await assert.rejects(() => saveGeoRows(db(), tiny, { source: 'bad' }), /would remove/);
  assert.equal((await db().query('SELECT COUNT(*)::int n FROM ref_geo_location')).rows[0].n, before);
});

test('geo cache notices a change made in the table', async () => {
  const cache = await GeoCache.create(db(), { refreshMs: 0 });
  assert.equal(await cache.refresh(), false); // nothing changed
  await db().query(`INSERT INTO ref_geo_location (row_key, name, name_norm, active) VALUES ('t1', 'Zzz New Yard', 'ZZZ NEW YARD', true)`);
  assert.equal(await cache.refresh(), true);
  assert.ok(cache.find('zzz new yard'));
});

test('reference data: seeded, ops edit wins over the default, bad zone is ignored', async () => {
  const r = await loadRefData(db());
  assert.ok(r.states >= 50);
  assert.equal(tzForState('ca'), 'America/Los_Angeles');
  await db().query(`UPDATE ref_state_timezone SET tz='America/Phoenix' WHERE state='NV'`);
  await db().query(`UPDATE ref_state_timezone SET tz='Mars/Olympus' WHERE state='UT'`);
  await loadRefData(db()); // re-seed must not overwrite the edit
  assert.equal(tzForState('NV'), 'America/Phoenix');
  assert.equal(tzForState('UT'), 'America/Denver', 'invalid zone ignored: previous/default value kept?');
});

test('tx rolls back as a unit', async () => {
  await assert.rejects(() => db().tx(async t => {
    await t.query(`INSERT INTO ref_state_timezone (state, tz) VALUES ('ZZ', 'UTC')`);
    throw new Error('boom');
  }), /boom/);
  assert.equal((await db().query(`SELECT 1 FROM ref_state_timezone WHERE state='ZZ'`)).rows.length, 0);
});
