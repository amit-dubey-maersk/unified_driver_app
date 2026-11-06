import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.DB_DIR = 'memory://';
const { initDb, db } = await import('../src/db/index.js');
const { processFile } = await import('../src/pipeline/processor.js');
const { GeoStore } = await import('../src/geo.js');
const { parse204, versionKey } = await import('../src/edi/parser.js');
const { iso6346CheckDigit, tzOffset } = await import('../src/transform.js');

const here = dirname(fileURLToPath(import.meta.url));
const fx = n => readFileSync(join(here, 'fixtures', n), 'latin1');
const geo = GeoStore.fromCsvFile(join(here, '..', 'data', 'Geo.csv'));
const topic = 't';

/** Re-stamp a fixture as a different interchange (time/control) and purpose code. */
const variant = (raw, { time = '0731', control = '002266186', purpose, replace = [] } = {}) => {
  let s = raw.replace(/(\*\d{6}\*)\d{4}(\*U\*00401\*)\d{9}/, `$1${time}$2${control}`);
  if (purpose) s = s.replace(/^B2A\*\d\d/m, `B2A*${purpose}`);
  for (const [a, b] of replace) s = s.replace(a, b);
  return s;
};
const run = (raw, name = 'f.txt') => processFile({ fileName: name, raw, geo, topic }).then(r => r[0]);

before(() => initDb());

test('parser extracts leg keys and stop appointment window', () => {
  const { isa, transactions: [tx] } = parse204(fx('amend_with_appt.txt'));
  assert.equal(tx.dispatchSeq, '4746919');
  assert.equal(tx.txnType, '04');
  assert.equal(tx.l11.SS[0], 'MEDUPN902655');
  assert.equal(tx.csnSeq, '2411901');
  assert.equal(tx.stops.length, 2);
  assert.deepEqual(tx.stops[0].appointments.map(a => a.kind), ['U', 'LP']);
  assert.equal(versionKey(isa), '2026-09-21T07:31|000002266186');
});

test('amendment before create is upserted and published as NEW with geofence + appointment', async () => {
  const r = await run(fx('amend_with_appt.txt'));
  assert.equal(r.outcome, 'CREATED');
  assert.equal(r.payload.status, 'NEW');
  assert.equal(r.payload.orderNumber, '4746919');
  const [pick, drop] = r.payload.routes;
  assert.equal(pick.addressName, 'TRM T140');
  assert.equal(pick.plannedArrivalDateTimeLocal, '2026-08-21T08:00:00');
  assert.equal(pick.plannedDepartureDateTimeLocal, '2026-08-21T08:30:00');
  assert.match(pick.location, /^33\.\d{12} : -118\.\d{12}$/);
  assert.equal(pick.activityType, 'PICK_UP');
  assert.equal(drop.activityType, 'DROP_OFF');
  assert.equal(drop.isCustomerLocation, true);
  assert.equal(r.payload.orderDetails.containerNumber, 'MSMU1974881');
  assert.equal(r.published, true);
});

test('identical re-drop is a NOOP and queues nothing', async () => {
  const r = await run(fx('amend_with_appt.txt'));
  assert.equal(r.outcome, 'NOOP');
  assert.equal(r.published, false);
});

test('newer change publishes UPDATED; older interchange is STALE and ignored', async () => {
  const upd = await run(variant(fx('amend_with_appt.txt'), { time: '0900', control: '002266999', replace: [['L11*FCL*LT', 'L11*FCL*LT\nL11*TRKX123456*CH']] }));
  assert.equal(upd.outcome, 'UPDATED');
  assert.equal(upd.payload.status, 'UPDATED');
  assert.equal(upd.payload.orderDetails.chassisNumber, 'TRKX123456');

  const stale = await run(variant(fx('amend_with_appt.txt'), { time: '0800', control: '002266500' }));
  assert.equal(stale.outcome, 'STALE');
  assert.equal(stale.published, false);
  const { rows } = await db().query("SELECT last_chassis FROM trinium_legs WHERE dispatch_seq='4746919'");
  assert.equal(rows[0].last_chassis, 'TRKX123456');
});

test('cancel publishes CANCELLED once; later newer create reactivates as NEW', async () => {
  const c = await run(variant(fx('amend_with_appt.txt'), { time: '1000', control: '002267000', purpose: '01' }));
  assert.equal(c.outcome, 'CANCELLED');
  assert.equal(c.payload.status, 'CANCELLED');
  const again = await run(variant(fx('amend_with_appt.txt'), { time: '1001', control: '002267001', purpose: '01' }));
  assert.equal(again.outcome, 'NOOP');
  const back = await run(variant(fx('amend_with_appt.txt'), { time: '1100', control: '002267100', purpose: '00' }));
  assert.equal(back.outcome, 'REACTIVATED');
  assert.equal(back.payload.status, 'NEW');
});

test('ECL leg: empty load, pickup at customer, drop at terminal', async () => {
  const r = await run(fx('create_ecl.txt'));
  assert.equal(r.outcome, 'CREATED');
  assert.equal(r.payload.loadType, 'Empty');
  assert.equal(r.payload.routes[1].isCustomerLocation, false);
  assert.equal(r.payload.orderDetails.legType, 'ECL');
});

test('outbox row written for each publish, none for NOOP/STALE', async () => {
  const { rows } = await db().query("SELECT status, count(*)::int AS n FROM outbound_messages GROUP BY status");
  assert.deepEqual(rows, [{ status: 'PENDING', n: 5 }]);
  const audit = await db().query("SELECT outcome FROM order_messages WHERE dispatch_seq='4746919' ORDER BY id");
  assert.deepEqual(audit.rows.map(x => x.outcome), ['CREATED', 'NOOP', 'UPDATED', 'STALE', 'CANCELLED', 'NOOP', 'REACTIVATED']);
});

test('ISO 6346 check digit and timezone offsets', () => {
  assert.equal(iso6346CheckDigit('CAAU627987'), 0);
  assert.equal(tzOffset('America/Los_Angeles', '2026-09-11T00:00:00'), '-07:00:00');
  assert.equal(tzOffset('America/Los_Angeles', '2026-12-11T00:00:00'), '-08:00:00');
  assert.equal(tzOffset('America/New_York', '2026-11-06T17:01:53'), '-05:00:00');
});

test('TB code: carrier id -> vendorCode only; any other code -> driverId', async () => {
  const carrierOnly = parse204(fx('create_ecl.txt'));
  const { buildOrderPayload } = await import('../src/transform.js');
  const a = buildOrderPayload(carrierOnly.transactions[0], 'NEW', geo).payload;
  assert.equal(a.vendorCode, 'OALM');
  assert.equal(a.driverId, undefined);

  const withDriver = parse204(fx('create_ecl.txt').replace('L11*OALM*TB', 'L11*D-SAV2260*TB'));
  const b = buildOrderPayload(withDriver.transactions[0], 'NEW', geo).payload;
  assert.equal(b.vendorCode, 'OALM');
  assert.equal(b.driverId, 'D-SAV2260');
  assert.equal(b.orderDetails.moveType, 'DROP');
});

test('separate driver element: TB stays carrier, DR is driverId', async () => {
  const { buildOrderPayload } = await import('../src/transform.js');
  const raw = fx('create_ecl.txt').replace('L11*OALM*TB', 'L11*OALM*TB\nL11*D-SAV2260*DR');
  const p = buildOrderPayload(parse204(raw).transactions[0], 'NEW', geo).payload;
  assert.equal(p.vendorCode, 'OALM');
  assert.equal(p.driverId, 'D-SAV2260');
});

// ---- DrayApp feed (204_New): shapes not present in the first OALM samples ----
const DRAYAPP = [
  'ISA*00*          *00*          *ZZ*HDDR           *ZZ*hddr           *261102*0238*U*00401*002408958*0*P*>',
  'GS*SM*HDDR*HDDR*20261102*0238*002408958*X*004010', 'ST*204*002408958', 'B2**GLTN**4832263**CC', 'B2A*00',
  'L11*ID002362306/001*TO', 'L11*ECL*LT', 'L11*2*LN', 'L11*30900045*TB',
  'G62*10*20261030*0420',
  'NTE*ZZZ*csn_seq: 2464660', 'NTE*ZZZ*<: 10/31/2026 12:16:00 AM>', 'TRCPLACEDAT: Y-BPT-6K74F.3', '</>', '<POH PIN FCL: 24482181', 'NTE*ZZZ*>',
  'N1*BN*HP Transload', 'N3*1209 Orange Street', 'N4*Wilmington*DE*19801*US',
  'N7***54013*********MAEU*DRY**40H',
  'S5*1*LD', 'G62*69*20261101*U*0001*LT', 'G62*69*20261101*LP*0001*LT', 'N1*SF*MSKW-KEA*25*54408', 'N3*36 N. Hackensack Avenue', 'N4*KEARNY*NJ*07032*US',
  'S5*2*UL', 'G62*70*20261101*X*1500*LT', 'G62*70*20261101*LD*1700*LT', 'N1*ST*TERMINAL PNCT - NJ', 'N3*241 CALCUTTA ST', 'N4*NEWARK*NJ*07114*US',
  'L3*19421*G', 'SE*30*002408958', 'GE*1*002408958', 'IEA*1*002408958', '',
].join('\r\n');

test('DrayApp 204: multi-line NTE folded back, G62*70 delivery window used, container-less N7, ISA receiver case-normalised', async () => {
  const { buildOrderPayload } = await import('../src/transform.js');
  const { transactions: [tx] } = parse204(DRAYAPP);
  assert.equal(tx.dispatchSeq, '4832263');
  assert.ok(tx.nte.some(n => n.includes('TRCPLACEDAT') && n.includes('</>') && n.includes('24482181')), 'continuation lines must stay inside the NTE');
  assert.deepEqual(tx.stops[1].appointments.map(a => [a.kind, a.time]), [['U', '1500'], ['LP', '1700']]);
  assert.ok(!tx.n7.number);
  const p = buildOrderPayload(tx, 'NEW', geo).payload;
  assert.equal(p.routes[1].plannedArrivalDateTimeLocal, '2026-11-01T15:00:00', 'appointment must beat G62*10');
  assert.equal(p.routes[1].plannedDepartureDateTimeLocal, '2026-11-01T17:00:00');
  assert.equal(p.vendorCode, 'HDDR');
});

test('pickup with no appointment falls back to L11*IT; L11*AT becomes pickupNumber', async () => {
  const { buildOrderPayload } = await import('../src/transform.js');
  const raw = DRAYAPP.replace('G62*69*20261101*U*0001*LT\r\n', '').replace('G62*69*20261101*LP*0001*LT\r\n', '').replace('L11*30900045*TB', 'L11*30900045*TB\r\nL11*10/7/2026*IT\r\nL11*81B60F*AT');
  const { transactions: [tx] } = parse204(raw);
  const p = buildOrderPayload(tx, 'NEW', geo).payload;
  assert.equal(p.routes[0].plannedArrivalDateTimeLocal, '2026-10-07T00:00:00');
  assert.equal(p.orderDetails.pickupNumber, '81B60F');
});
