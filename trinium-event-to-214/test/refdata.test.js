import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_DIR = 'memory://';
const { initDb, db } = await import('../src/db/index.js');
const { loadRefData } = await import('../src/refdata.js');
const { mapEvent } = await import('../src/mapping.js');
const { utcToLocalInState } = await import('../src/tz.js');

before(() => initDb());
const ev = status => ({ event: { eventStatus: status, transactionType: 'ADD' } });

test('event -> AT7 map is seeded from the defaults and driven by the table', async () => {
  const r = await loadRefData(db());
  assert.ok(r.eventCodes >= 6);
  assert.equal(mapEvent(ev('ARRIVAL'), 1, {}).code, 'X3');
  assert.equal(mapEvent(ev('DEPARTURE'), 2, {}).code, 'CD');
  assert.ok(mapEvent(ev('ARRIVAL'), 3, {}).skip, 'no mapping for a third stop');
  assert.ok(mapEvent(ev('CUSTOMER_APPOINTMENT|PICKUP'), 1, { appointment214: false }).skip, 'flag off: skipped');
  assert.equal(mapEvent(ev('CUSTOMER_APPOINTMENT|PICKUP'), 1, { appointment214: true }).code, 'AA');

  await db().query(`UPDATE ref_event_code_map SET at7_code='XX' WHERE event_key='ARRIVAL' AND route_seq=1`); // ops change, no deploy
  await loadRefData(db());
  assert.equal(mapEvent(ev('ARRIVAL'), 1, {}).code, 'XX');
  await db().query(`UPDATE ref_event_code_map SET active=false WHERE event_key='DEPARTURE' AND route_seq=2`);
  await loadRefData(db());
  assert.ok(mapEvent(ev('DEPARTURE'), 2, {}).skip, 'deactivated row: no 214');
});

test('state time zone comes from the table', async () => {
  await db().query(`UPDATE ref_state_timezone SET tz='America/New_York' WHERE state='CA'`);
  await loadRefData(db());
  assert.equal(utcToLocalInState('2026-11-04T12:00:00Z', 'CA'), '2026-11-04T07:00:00');
});
