import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

process.env.DB_DIR = 'memory://';
const { initDb, db } = await import('../src/db/index.js');
const { handleEvent, resolveStop, loadConfig, toEvents } = await import('../src/processor.js');
const { build214, splitContainer, appSizeToN7, utcToLocal, fileName214 } = await import('../src/edi214.js');
const { mapEvent } = await import('../src/mapping.js');

const here = dirname(fileURLToPath(import.meta.url));
const examples = JSON.parse(readFileSync(join(here, 'fixtures', 'examples.json'), 'utf8'));
const cfg = loadConfig({ EDI_PROFILE: 'OALM', SEND_XB: 'false' }); // the older tests below were written against the OALM format
const NOW = new Date('2026-11-04T01:05:08Z');

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const RP1 = '22222222-2222-4222-8222-222222222221';
const RP2 = '22222222-2222-4222-8222-222222222222';

before(async () => {
  await initDb();
  // minimal stand-ins for the order service's tables
  await db().exec(`
    CREATE TABLE trinium_legs (dispatch_seq TEXT PRIMARY KEY, booking_ref TEXT, bol TEXT, container_number TEXT, leg_type TEXT, leg_number TEXT,
      last_chassis TEXT, status TEXT, order_id TEXT, payload JSONB);
    CREATE TABLE trinium_leg_stops (dispatch_seq TEXT, seq INT, location_name TEXT, site_code TEXT, time_zone_offset TEXT, route_point_id TEXT, state TEXT);
  `);
  const payload = { orderDetails: { triniumOrderNumber: 'OWF1/001', grossWeight: '8115.2', containerType: '40 DRY', containerHeight: '8 6' } };
  await db().query(`INSERT INTO trinium_legs VALUES ('900','COSU1','COSU1','OOCU4739582','FCL','1',NULL,'ACTIVE',$1,$2::jsonb)`, [ORDER_ID, JSON.stringify(payload)]);
  await db().query(`INSERT INTO trinium_legs VALUES ('901','B','B','OOCU4739582','ECL','1',NULL,'CANCELLED',$1,$2::jsonb)`, [ORDER_ID, JSON.stringify(payload)]);
  await db().query(`INSERT INTO trinium_leg_stops VALUES ('900',1,'TRM E010','44064','-07:00:00',$1,'CA'),('900',2,'ROSS- SHAFTER',NULL,'-07:00:00',$2,'CA')`, [RP1, RP2]);
});

let n = 0;
const ev = (over, event) => ({
  eventId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, eventType: 'ORDER_EVENT',
  occurredAt: '2026-11-04T16:00:00Z', source: 'GEOFENCE', actor: { userId: 'D-SAV2260', vendorCode: 'OALM' },
  order: { orderNumber: '900', orderId: ORDER_ID, sourceSystem: 'TRINIUM' }, event, ...over,
});
const arrival = (rp, local, extra = {}) => ({ eventStatus: 'ARRIVAL', transactionType: 'ADD',
  routePoint: { routePointId: rp, timeZoneOffset: '-08:00', actualArrivalDateTimeUTC: '2026-11-04T16:00:00Z', actualArrivalDateTimeLocal: local }, ...extra });

test('build214 reproduces a real OALM sample 214 byte for byte', () => {
  // OALM 214_20260914_075.._000000304_af.txt (leg 4768020)
  const out = build214({
    isaControl: 304, now: new Date('2026-09-14T07:53:00Z'), sender: 'OALM', receiver: 'HDDR', scac: 'OALM',
    b10_01: 'COSU6509977140', dispatchSeq: '4768020', to: 'OWE000023039/001', legType: 'ECL', legNumber: '1', chassis: 'PTAZ402150',
    container: { prefix: 'CSGU', number: '781610', weight: '6239', size: '40H', check: '5' }, code: 'AF', local: { date: '20260911', time: '1300' },
  });
  const expected = [
    'ISA*00*          *00*          *02*OALM           *02*HDDR           *260914*0753*U*00401*000000304*0*P*>', 'GS*QM*OALM*HDDR*20260914*0753*304*X*004010',
    'ST*214*0001', 'B10*COSU6509977140*4768020*OALM', 'L11*OWE000023039/001*TO', 'L11*ECL*LT', 'L11*1*LN', 'L11*PTAZ402150*CH',
    'N7*CSGU*781610*6239************40H***5', 'AT7*AF*NS***20260911*1300*LT', 'SE*9*0001', 'GE*1*304', 'IEA*1*000000304',
  ].join('~\r\n') + '~\r\n';
  assert.equal(out, expected);
});

test('container / size helpers', () => {
  assert.deepEqual(splitContainer('MSMU1974881'), { prefix: 'MSMU', number: '197488', check: '1' });
  assert.equal(splitContainer('BAD'), null);
  assert.equal(appSizeToN7('40HC'), '40H'); assert.equal(appSizeToN7('40DV'), '40'); assert.equal(appSizeToN7('20DV'), '20'); assert.equal(appSizeToN7('45HC'), '45H');
  assert.equal(utcToLocal('2026-11-04T23:00:00Z', '-08:00'), '2026-11-04T15:00:00');
});

test('mapping: app events -> AT7; AA/AB, POD, GPS, delay are not 214s from the app', () => {
  const m = (s, seq, tt = 'ADD') => mapEvent({ event: { eventStatus: s, transactionType: tt } }, seq, cfg);
  assert.equal(m('ARRIVAL', 1).code, 'X3'); assert.equal(m('DEPARTURE', 1).code, 'AF');
  assert.equal(m('ARRIVAL', 2).code, 'X1'); assert.equal(m('DEPARTURE', 2).code, 'CD');
  for (const s of ['CUSTOMER_APPOINTMENT|PICKUP', 'CUSTOMER_APPOINTMENT|DROPOFF', 'PROOF_OF_DELIVERY', 'GPS_UPDATE', 'DELAY', 'FUTILE_TRIP']) assert.ok(m(s, 1).skip, s);
  assert.ok(m('ARRIVAL', 2, 'DELETE').skip);
  assert.equal(mapEvent({ event: { eventStatus: 'CUSTOMER_APPOINTMENT|PICKUP', transactionType: 'ADD' } }, 1, { appointment214: true }).code, 'AA');
});

test('route point resolved from our data only; ambiguity is an error', () => {
  const stops = [{ seq: 1, route_point_id: RP1, site_code: '44064', location_name: 'TRM E010' }, { seq: 2, route_point_id: RP2, site_code: null, location_name: 'ROSS- SHAFTER' }];
  assert.equal(resolveStop({ routePointId: RP2 }, stops).stop.seq, 2);
  assert.equal(resolveStop({ routePointId: 'x', siteCode: 'TRM E010' }, stops).stop.seq, 1);
  assert.equal(resolveStop({ routePointId: 'x', siteCode: 'ROSS-SHAFTER' }, stops).stop.seq, 2);
  assert.ok(resolveStop({ routePointId: 'x', siteCode: 'NOWHERE' }, stops).error);
  const same = [{ seq: 1, route_point_id: 'a', location_name: 'TRM E010' }, { seq: 2, route_point_id: 'b', location_name: 'TRM E010' }];
  assert.match(resolveStop({ routePointId: 'x', siteCode: 'TRM E010' }, same).error, /both stops/);
});

test('arrival -> X3 214 generated once; same eventId = DUPLICATE; same status+time = SKIPPED; correction = new 214', async () => {
  const e1 = ev({}, arrival(RP1, '2026-11-04T08:00:00'));
  const r1 = await handleEvent(e1, cfg, NOW);
  assert.equal(r1.outcome, 'SENT_214'); assert.equal(r1.code, 'X3');
  assert.equal((await handleEvent(e1, cfg, NOW)).outcome, 'DUPLICATE');
  assert.equal((await handleEvent(ev({}, arrival(RP1, '2026-11-04T08:00:00')), cfg, NOW)).outcome, 'SKIPPED');
  const fix = await handleEvent(ev({}, { ...arrival(RP1, '2026-11-04T08:05:00'), transactionType: 'UPDATE', correctionOf: e1.eventId }), cfg, NOW);
  assert.equal(fix.outcome, 'SENT_214');
  const { rows } = await db().query(`SELECT content FROM edi214_sent WHERE dispatch_seq='900' ORDER BY id`);
  assert.equal(rows.length, 2);
  assert.match(rows[0].content, /AT7\*X3\*NS\*\*\*20261104\*0800\*LT/); assert.match(rows[1].content, /AT7\*X3\*NS\*\*\*20261104\*0805\*LT/);
  assert.match(rows[0].content, /B10\*COSU1\*900\*OALM/);
  assert.match(rows[0].content, /N7\*OOCU\*473958\*8115\*{12}40\*{3}2/);
});

test('app equipment is held and rides on the next 214 (chassis, container change)', async () => {
  const up = ev({ eventType: 'ORDER_UPDATE', source: 'DRIVER_APP' }, undefined);
  delete up.event; up.updates = { chassis: { chassisNumber: 'FLKZ600139' }, container: { containerNumber: 'OOCU4739582', containerSizeType: '40HC' } };
  assert.equal((await handleEvent(up, cfg, NOW)).outcome, 'HELD');
  const r = await handleEvent(ev({}, { eventStatus: 'DEPARTURE', transactionType: 'ADD',
    routePoint: { routePointId: RP1, timeZoneOffset: '-08:00', actualDepartureDateTimeUTC: '2026-11-04T17:30:00Z', actualDepartureDateTimeLocal: '2026-11-04T09:30:00' } }), cfg, NOW);
  assert.equal(r.code, 'AF');
  const { rows } = await db().query(`SELECT content FROM edi214_sent WHERE at7_code='AF'`);
  assert.match(rows[0].content, /L11\*FLKZ600139\*CH/); assert.match(rows[0].content, /N7\*OOCU\*473958\*8115\*{12}40H\*{3}2/);
});

test('errors: unknown order, cancelled leg, bad schema, unresolvable stop, non-Trinium order', async () => {
  const unknown = await handleEvent(ev({ order: { orderNumber: '999', orderId: ORDER_ID, sourceSystem: 'TRINIUM' } }, arrival(RP1, '2026-11-04T08:00:00')), cfg, NOW);
  assert.equal(unknown.outcome, 'ERROR'); assert.match(unknown.detail, /unknown order/);
  const cancelled = await handleEvent(ev({ order: { orderNumber: '901', orderId: ORDER_ID, sourceSystem: 'TRINIUM' } }, arrival(RP1, '2026-11-04T08:00:00')), cfg, NOW);
  assert.equal(cancelled.outcome, 'SKIPPED');
  const bad = await handleEvent({ eventId: 'bad-1', eventType: 'ORDER_EVENT' }, cfg, NOW);
  assert.equal(bad.outcome, 'ERROR'); assert.match(bad.detail, /schema/);
  const lost = await handleEvent(ev({}, arrival('33333333-3333-4333-8333-333333333333', '2026-11-04T08:00:00')), cfg, NOW);
  assert.equal(lost.outcome, 'ERROR'); assert.match(lost.detail, /not found on this leg/);
  const sap = await handleEvent(ev({ order: { orderNumber: '900', orderId: ORDER_ID, sourceSystem: 'SAP_TM' } }, arrival(RP1, '2026-11-04T08:00:00')), cfg, NOW);
  assert.equal(sap.outcome, 'SKIPPED');
});

test('the agreed example payloads pass the schema (unknown orders then fail on lookup, not on shape)', async () => {
  for (const x of examples) {
    const r = await handleEvent(x.payload, cfg, NOW);
    assert.ok(!/schema:/.test(r.detail || ''), `${x.description}: ${r.detail}`);
  }
});

// ---- Maersk Supplier Order Update contract (TransportDocument / TransportOrderEvent) ----
const sup = (over = {}) => ({ uniqueIdentifier: '000D3A46-A684-1EEF-83DA-7229F0DF6501', createTimestamp: '2026-11-04T16:00:00Z',
  parties: [{ partyFunction: 'Carrier', partyCode: 'OALM' }], carrierBooking: { carrierBookingNumber: '900' }, ...over });
const supEvent = (uid, status, rp, ts) => sup({ uniqueIdentifier: uid, transportOrder: { transportPlan: { transportLeg: [{ event: {
  timestamp: ts, eventStatus: status, transactionType: 'ADD', eventType: [{ eventTypeName: 'LOC_GUID', eventTypeCode: rp }] } }] } } });

test('supplier API: reportEvent normalises to ORDER_EVENT and yields the same 214 as the internal format', async () => {
  const [e] = toEvents(supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6502', 'ARRIVAL', RP2, '2026-11-04T23:00:00Z'));
  assert.equal(e.eventType, 'ORDER_EVENT'); assert.equal(e.order.orderNumber, '900'); assert.equal(e.event.routePoint.routePointId, RP2);
  const r = await handleEvent(e, cfg, NOW);
  assert.equal(r.outcome, 'SENT_214'); assert.equal(r.code, 'X1');
  const { rows } = await db().query(`SELECT content FROM edi214_sent WHERE at7_code='X1' ORDER BY id DESC LIMIT 1`);
  assert.match(rows[0].content, /AT7\*X1\*NS\*\*\*20261104\*1500\*LT/); // 23:00Z in California on 4 Nov = PST (-08:00) even though the stored 204-time offset is -07:00 (DST ended 1 Nov)
});

test('supplier API: updateTransportOrder -> held equipment/driver/decision; accept alone is HELD', async () => {
  const [acc] = toEvents(sup({ uniqueIdentifier: '000D3A46-A684-1EEF-83DA-7229F0DF6503', carrierBooking: { carrierBookingNumber: '900', carrierBookingStatus: 'CARRIER_ACCEPTED' } }));
  assert.equal(acc.updates.decision.decision, 'CARRIER_ACCEPTED'); assert.equal((await handleEvent(acc, cfg, NOW)).outcome, 'HELD');
  const evs = toEvents(sup({ uniqueIdentifier: '000D3A46-A684-1EEF-83DA-7229F0DF6504', transportOrder: {
    cargoStuffing: [{ containerNumber: 'OOCU4739582', seals: [{ sealNumber: 'S1', sealType: 'CARRIER_SEAL' }] }],
    transportPlan: { carriage: { truck: { truckIdentifier: 'T1' }, trailer: { trailerIdentifier: 'FLKZ600139' } }, party: [{ partyName: 'Drv', badgeNumber: 'D-SAV2260' }] } } }));
  assert.equal(evs.length, 1); assert.equal(evs[0].updates.chassis.chassisNumber, 'FLKZ600139'); assert.equal(evs[0].actor.userId, 'D-SAV2260');
  assert.equal((await handleEvent(evs[0], cfg, NOW)).outcome, 'HELD');
});

test('supplier API: POD / delay are SKIPPED, bad enum / missing required are ERROR, length overrun is only a warning', async () => {
  const pod = toEvents(supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6505', 'PROOF_OF_DELIVERY', RP2, '2026-11-04T23:20:00Z'));
  assert.equal((await handleEvent(pod[0], cfg, NOW)).outcome, 'SKIPPED');
  const bad = toEvents(supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6506', 'TELEPORTED', RP2, '2026-11-04T23:20:00Z'));
  const rb = await handleEvent(bad[0], cfg, NOW); assert.equal(rb.outcome, 'ERROR'); assert.match(rb.detail, /supplier API/);
  const noBooking = toEvents({ uniqueIdentifier: '000D3A46-A684-1EEF-83DA-7229F0DF6507', parties: [{ partyCode: 'X', partyFunction: 'Carrier' }] });
  assert.equal((await handleEvent(noBooking[0], cfg, NOW)).outcome, 'ERROR');
  const long = supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6508', 'DEPARTURE', RP1, '2026-11-04T17:31:00Z');
  long.transportOrder.transportPlan.transportLeg[0].event.eventIdentifier = 'X'.repeat(40);
  const rl = await handleEvent(toEvents(long)[0], cfg, NOW);
  assert.equal(rl.outcome, 'SENT_214'); assert.match(rl.detail, /schema warning/);
});

test('supplier API: internal-format messages pass through toEvents untouched', () => {
  const x = { eventId: 'e', eventType: 'ORDER_EVENT' };
  assert.deepEqual(toEvents(x), [x]);
});

test('supplier API: a bad communicationMediaType value is a warning, not a rejection', async () => {
  const m = supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6509', 'DEPARTURE', RP1, '2026-11-04T18:00:00Z');
  m.communicationMediaType = { communicationMediaTypeName: 'KAFKA' };
  const evs = toEvents(m);
  assert.ok(!evs[0]._invalid); assert.match(evs[0]._warnings[0], /communicationMediaType/);
  assert.equal((await handleEvent(evs[0], cfg, NOW)).outcome, 'SENT_214');
});

test('supplier API: real app statuses ORDER_STARTED/COMPLETED are skipped; ACTUAL_* sanity warnings', async () => {
  const st = toEvents(supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6510', 'ORDER_STARTED', RP1, '2026-11-04T21:34:06Z'));
  assert.ok(!st[0]._invalid); assert.equal((await handleEvent(st[0], cfg, NOW)).outcome, 'SKIPPED');
  const a = supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6511', 'ARRIVAL', RP1, '2026-11-04T21:34:22Z');
  a.transportOrder.transportPlan.transportLeg[0].event.eventType.push({ eventTypeName: 'ACTUAL_ARRIVAL', eventTypeCode: '2026-11-05T04:34:00Z' });
  assert.match(toEvents(a)[0]._warnings.join(' '), /AFTER the message timestamp/);
  const b = supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6512', 'ARRIVAL', RP1, '2026-11-04T21:34:22Z');
  b.transportOrder.transportPlan.transportLeg[0].event.eventType.push({ eventTypeName: 'ACTUAL_ARRIVAL', eventTypeCode: '2026-11-04T13:30:00' });
  const eb = toEvents(b)[0];
  assert.match(eb._warnings.join(' '), /no time zone/); assert.equal(eb.event.routePoint.actualArrivalDateTimeUTC, '2026-11-04T21:34:22Z');
});

// ---- DRAYAPP profile (existing DrayApp -> Trinium 214 format, from 214_New) ----
const real = n => readFileSync(join(here, 'fixtures', 'drayapp_214', n), 'utf8');
const isaNow = raw => { const i = raw.split('*'); return new Date(`20${i[9].slice(0, 2)}-${i[9].slice(2, 4)}-${i[9].slice(4, 6)}T${i[10].slice(0, 2)}:${i[10].slice(2)}:00Z`); };

test('DRAYAPP profile reproduces three real DrayApp 214s byte for byte (container+WO+CH, container-less XB, container-less X3 with CH)', () => {
  const base = { profile: 'DRAYAPP', sender: 'HDDR', receiver: 'HDDR', scac: 'HDDR' };
  const a = real('with_container_wo_ch_af.edi');
  assert.equal(build214({ ...base, isaControl: 4453052, now: isaNow(a), b10_01: 'CMDUQGD3506331', bol: 'CMDUQGD3506331', dispatchSeq: '4922339',
    wo: 'CDA_HDDRAPHU7351600CMDUQGD3506331', // 204 value is 33 chars: L11-01 is cut at 30
    to: 'OWF002412735/001', legType: 'FCL', legNumber: '2', chassis: 'AIMZ403911',
    container: { prefix: 'APHU', number: '735160', check: '0', weight: '24261.84' }, code: 'AF', local: { date: '20261102', time: '1347' } }), a);
  const b = real('xb_no_container_wo.edi');
  assert.equal(build214({ ...base, isaControl: 4448448, now: isaNow(b), b10_01: '276223255', bol: '276223255', dispatchSeq: '4933576', wo: '27099751',
    to: 'ID002420631/001', legType: 'CHS', legNumber: '4', container: { weight: '11959.00' }, code: 'XB', local: { date: '20261102', time: '0558' } }), b);
  const c = real('no_container_ch_x3.edi');
  assert.equal(build214({ ...base, isaControl: 4449818, now: isaNow(c), b10_01: 'MAEU276317860', bol: 'MAEU276317860', dispatchSeq: '4933591',
    to: 'ID002369078/001', legType: 'CHS', legNumber: '4', chassis: 'GLTN413996', container: { weight: '11564.91' }, code: 'X3', local: { date: '20261102', time: '0800' } }), c);
});

test('DRAYAPP profile through the service: B10-01 = SS, WO, LX, no CRLF, 2-decimal weight, XB on accept, container-less leg is not an error', async () => {
  const c = loadConfig({ EDI_PROFILE: 'DRAYAPP' });
  assert.equal(c.sender, 'HDDR'); assert.equal(c.sendXB, true); assert.equal(loadConfig({ EDI_PROFILE: 'DRAYAPP', SEND_XB: 'false' }).sendXB, false);
  const payload = { orderDetails: { triniumOrderNumber: 'ID1/001', grossWeight: '12627.2', workOrder: '67012030688' } };
  await db().query(`INSERT INTO trinium_legs VALUES ('950','MAEU1','MAEU274689461','','CHS','5',NULL,'ACTIVE',$1,$2::jsonb)`, [ORDER_ID, JSON.stringify(payload)]);
  await db().query(`INSERT INTO trinium_leg_stops VALUES ('950',1,'TRM E010','44064','-07:00:00',$1,'CA'),('950',2,'ROSS- SHAFTER',NULL,'-07:00:00',$2,'CA')`, ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']);
  const accept = { eventId: '00000000-0000-4000-8000-0000000009a1', eventType: 'ORDER_UPDATE', occurredAt: '2026-11-04T16:05:00Z', source: 'DRIVER_APP',
    actor: { userId: 'D-1', vendorCode: 'HDDR' }, order: { orderNumber: '950', orderId: ORDER_ID, sourceSystem: 'TRINIUM' }, updates: { decision: { decision: 'CARRIER_ACCEPTED' } } };
  const r = await handleEvent(accept, c, NOW);
  assert.equal(r.outcome, 'SENT_214'); assert.equal(r.code, 'XB');
  const { rows } = await db().query(`SELECT content FROM edi214_sent WHERE dispatch_seq='950'`);
  const x = rows[0].content;
  assert.ok(!x.includes('\n')); assert.match(x, /B10\*MAEU274689461\*950\*HDDR~L11\*67012030688\*WO~L11\*MAEU274689461\*SS~L11\*ID1\/001\*TO~L11\*CHS\*LT~L11\*5\*LN~N7\*{3}12627\.20\*{15}~LX\*1~AT7\*XB\*NS\*{3}20261104\*0805\*LT~SE\*11\*/);
  assert.match(x, /ST\*214\*(\d+)~.*SE\*11\*\1~GE\*1\*\1~IEA\*1\*0*\1~$/); // ST02 = SE02 = GS06 = ISA13
});

test('defaults: DrayApp mode, XB on accept, own control-number range with a step of 7, DrayApp file names', async () => {
  const d = loadConfig({});
  assert.equal(d.profile, 'DRAYAPP'); assert.equal(d.sender, 'HDDR'); assert.equal(d.sendXB, true);
  assert.equal(d.controlStart, 50000000); assert.equal(d.controlStep, 7);
  const e = n => ({ eventId: `00000000-0000-4000-8000-0000000008${n}`, eventType: 'ORDER_UPDATE', occurredAt: '2026-11-04T16:05:00Z', source: 'DRIVER_APP',
    actor: { userId: 'D-1', vendorCode: 'HDDR' }, order: { orderNumber: '950', orderId: ORDER_ID, sourceSystem: 'TRINIUM' }, updates: { decision: { decision: 'CARRIER_ACCEPTED' } } });
  await db().query(`DELETE FROM edi214_sent WHERE dispatch_seq='950'`);
  const r1 = await handleEvent(e('01'), d, NOW); assert.equal(r1.code, 'XB');
  const r2 = await handleEvent({ ...e('02'), occurredAt: '2026-11-04T16:09:00Z' }, d, NOW);
  const { rows } = await db().query(`SELECT isa_control, file_name FROM edi214_sent WHERE dispatch_seq='950' ORDER BY id`);
  const [c1, c2] = rows.map(r => Number(r.isa_control));
  assert.ok(c1 >= 50000000 && (c1 - 50000000) % 7 === 0, 'in our range, on our step'); assert.equal(c2 - c1, 7);
  assert.match(rows[0].file_name, new RegExp(`^hddr\\d{8}\\d{6}\\d{4}${String(c1).padStart(12, '0')}\\.edi$`));
  assert.equal(fileName214(new Date('2026-11-02T12:23:40.778Z'), 4450258, 'AF', { profile: 'DRAYAPP', container: 'FFAU8840181' }), 'hddrffau88401812026110212234077 80000004450258.edi'.replace(' ', ''));
});

test('supplier API: ACTUAL_* is the milestone time (timestamp is only the send time); ACTUAL_TIME_MODE=timestamp reverses it', () => {
  const mk = uid => { const m = supEvent(uid, 'ARRIVAL', RP1, '2026-11-04T23:09:43Z');
    m.transportOrder.transportPlan.transportLeg[0].event.eventType.push({ eventTypeName: 'ACTUAL_ARRIVAL', eventTypeCode: '2026-11-05T05:09:00Z' }); return m; };
  const e = toEvents(mk('000D3A46-A684-1EEF-83DA-7229F0DF6520'))[0];
  assert.equal(e.event.routePoint.actualArrivalDateTimeUTC, '2026-11-05T05:09:00Z');
  assert.equal(e.occurredAt, '2026-11-05T05:09:00Z', 'batches are ordered by milestone time');
  assert.match(e._warnings.join(' '), /6\.0 h AFTER the message timestamp/);
  // offline burst: milestone EARLIER than the send time is normal, no warning
  const off = supEvent('000D3A46-A684-1EEF-83DA-7229F0DF6522', 'DEPARTURE', RP1, '2026-11-04T23:09:43Z');
  off.transportOrder.transportPlan.transportLeg[0].event.eventType.push({ eventTypeName: 'ACTUAL_DEPARTURE', eventTypeCode: '2026-11-04T15:00:00Z' });
  const eo = toEvents(off)[0]; assert.equal(eo.event.routePoint.actualDepartureDateTimeUTC, '2026-11-04T15:00:00Z'); assert.ok(!eo._warnings);
  process.env.ACTUAL_TIME_MODE = 'timestamp';
  try { assert.equal(toEvents(mk('000D3A46-A684-1EEF-83DA-7229F0DF6521'))[0].event.routePoint.actualArrivalDateTimeUTC, '2026-11-04T23:09:43Z'); }
  finally { delete process.env.ACTUAL_TIME_MODE; }
});

test('supplier API: ORDER_STARTED / ORDER_COMPLETED without any route point are SKIPPED, not errors (as the real app sends them)', async () => {
  for (const st of ['ORDER_STARTED', 'ORDER_COMPLETED']) {
    const m = supEvent(`000D3A46-A684-1EEF-83DA-7229F0DF65${st === 'ORDER_STARTED' ? '30' : '31'}`, st, RP1, '2026-11-04T23:09:31Z');
    m.transportOrder.transportPlan.transportLeg[0].event.eventType = [{ eventTypeName: 'USER_ID', eventTypeCode: 'D-SAV2260' }]; // no LOC_GUID
    const r = await handleEvent(toEvents(m)[0], cfg, NOW);
    assert.equal(r.outcome, 'SKIPPED', st + ': ' + r.detail);
  }
});
