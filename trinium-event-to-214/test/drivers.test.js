import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_DIR = 'memory://';
const { initDb, db } = await import('../src/db/index.js');
const { handleEvent, loadConfig } = await import('../src/processor.js');
const { triniumDriverFor } = await import('../src/drivers.js');
const { build214 } = await import('../src/edi214.js');

const cfg = loadConfig({ EDI_PROFILE: 'OALM', SEND_XB: 'false' });
const NOW = new Date('2026-11-04T01:05:08Z');
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const RP = n => `22222222-2222-4222-8222-22222222222${n}`;

before(async () => {
  await initDb();
  await db().exec(`
    CREATE TABLE trinium_legs (dispatch_seq TEXT PRIMARY KEY, booking_ref TEXT, bol TEXT, container_number TEXT, leg_type TEXT, leg_number TEXT,
      last_chassis TEXT, status TEXT, order_id TEXT, payload JSONB, driver_code TEXT);
    CREATE TABLE trinium_leg_stops (dispatch_seq TEXT, seq INT, location_name TEXT, site_code TEXT, time_zone_offset TEXT, route_point_id TEXT, state TEXT);
  `);
  const p = JSON.stringify({ orderDetails: { triniumOrderNumber: 'OWF1/001', grossWeight: '8115.2', containerType: '40 DRY', containerHeight: '8 6' } });
  // 910: driver assigned by Trinium in the 204 (AMIT); 911: app reports driver D-SAV2260; 912: app reports an unmapped driver
  for (const [d, drv] of [['910', 'AMIT'], ['911', null], ['912', null]]) {
    await db().query(`INSERT INTO trinium_legs VALUES ($1,'B','B','OOCU4739582','FCL','1',NULL,'ACTIVE',$2,$3::jsonb,$4)`, [d, ORDER_ID, p, drv]);
    await db().query(`INSERT INTO trinium_leg_stops VALUES ($1,1,'TRM E010','44064','-07:00:00',$2,'CA')`, [d, RP(d.slice(-1))]);
  }
  await db().query(`INSERT INTO leg_equipment (dispatch_seq, driver) VALUES ('911','{"driverId":"D-SAV2260"}'), ('912','{"driverId":"D-NOPE"}')`);
  await db().query(`INSERT INTO driver_mapping (trinium_driver_id, driver_id) VALUES ('AMIT','D-SAV2260')`);
});

let n = 0;
const arrival = d => ({
  eventId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, eventType: 'ORDER_EVENT', occurredAt: '2026-11-04T16:00:00Z', source: 'GEOFENCE',
  actor: { userId: 'D-SAV2260', vendorCode: 'OALM' }, order: { orderNumber: d, orderId: ORDER_ID, sourceSystem: 'TRINIUM' },
  event: { eventStatus: 'ARRIVAL', transactionType: 'ADD', routePoint: { routePointId: RP(d.slice(-1)), timeZoneOffset: '-08:00',
    actualArrivalDateTimeUTC: '2026-11-04T16:00:00Z', actualArrivalDateTimeLocal: '2026-11-04T08:00:00' } },
});
const content = async d => (await db().query(`SELECT content FROM edi214_sent WHERE dispatch_seq=$1`, [d])).rows[0]?.content;

test('app driver D-SAV2260 -> 214 carries Trinium id AMIT', async () => {
  assert.equal(await triniumDriverFor(db(), 'D-SAV2260'), 'AMIT');
  const r = await handleEvent(arrival('911'), cfg, NOW);
  assert.equal(r.outcome, 'SENT_214', r.detail);
  assert.match(await content('911'), /L11\*AMIT\*DR~/);
});

test('no driver in the app data: falls back to the driver Trinium assigned in the 204', async () => {
  assert.equal((await handleEvent(arrival('910'), cfg, NOW)).outcome, 'SENT_214');
  assert.match(await content('910'), /L11\*AMIT\*DR~/);
});

test('unmapped app driver: 214 still goes out, without a driver, with a warning', async () => {
  const r = await handleEvent(arrival('912'), cfg, NOW);
  assert.equal(r.outcome, 'SENT_214');
  assert.match(r.detail, /D-NOPE has no row in driver_mapping/);
  assert.doesNotMatch(await content('912'), /\*DR~/);
});

test('driver segment is omitted when DRIVER_IN_214=false and absent from build214 by default', () => {
  assert.equal(loadConfig({ DRIVER_IN_214: 'false' }).driverIn214, false);
  const base = { isaControl: 1, now: NOW, sender: 'A', receiver: 'B', scac: 'A', b10_01: 'X', dispatchSeq: '1', legType: 'FCL', legNumber: '1', container: {}, code: 'AF', local: { date: '20261104', time: '0800' } };
  assert.doesNotMatch(build214(base), /\*DR~/);
  assert.match(build214({ ...base, driver: 'AMIT' }), /L11\*AMIT\*DR~/);
});
