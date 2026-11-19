import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import * as Q from '../src/queries.js';
import { readLogs, fileStats } from '../src/sources.js';

const db = new PGlite('memory://');
const q = async (sql, p) => (await db.query(sql, p)).rows;
const schema = f => readFileSync(new URL(`../../${f}/src/db/schema.sql`, import.meta.url), 'utf8');

before(async () => {
  await db.exec(schema('trinium-order-transformer')); // the dashboard reads tables owned by both services
  await db.exec(schema('trinium-event-to-214'));
  await db.exec(`
    INSERT INTO trinium_legs (dispatch_seq, trinium_order_no, bol, container_number, leg_type, status, version_key, payload) VALUES ('100','TO1','BOL1','MSKU1234567','FCL','ACTIVE','v1','{}'), ('200','TO2','BOL2',NULL,'ECL','CANCELLED','v1','{}');
    INSERT INTO trinium_leg_stops (dispatch_seq, seq, location_name, city, state, geo_matched) VALUES ('100',1,'TRM','LB','CA',true);
    INSERT INTO order_messages (dispatch_seq, file_name, isa_control, txn_type, outcome) VALUES ('100','a.txt','1','00','CREATED'), ('100','b.txt','2','04','NOOP'), ('200','c.txt','3','01','CANCELLED');
    INSERT INTO outbound_messages (dispatch_seq, topic, msg_key, payload, status, sent_at, kafka_partition, kafka_offset) VALUES ('100','t','100','{"x":1}','SENT',now(),0,'7'), ('200','t','200','{}','PENDING',NULL,NULL,NULL), ('200','t','200','{}','FAILED',NULL,NULL,NULL);
    INSERT INTO inbound_events (event_id, dispatch_seq, event_type, event_status, outcome, detail) VALUES ('e1','100','ORDER_EVENT','ARRIVAL','SENT_214','ok'), ('e2','100','ORDER_EVENT','POD','HELD','later'), ('e3','999','ORDER_EVENT','ARRIVAL','ERROR','unknown order');
    INSERT INTO edi214_sent (dispatch_seq, at7_code, event_time_local, event_id, idempotency_key, isa_control, file_name, content, status, sftp_status) VALUES ('100','X1','202611150800','e1','k1','1','f.edi','AT7*X1~','WRITTEN','PENDING');
    INSERT INTO processing_trace (service, kind, ref, source, outcome, issues, incoming, outgoing) VALUES
      ('order','order_204','100','a.txt','CREATED','[{"level":"warn","code":"GEO_UNMATCHED","message":"m"}]','{"a":1}','{"b":2}'),
      ('events','driver_event','999','e3','ERROR','[{"level":"error","code":"UNKNOWN_ORDER","message":"x"}]','{}','{}');
  `);
});

test('summary counts both flows and what is stuck', async () => {
  const s = await Q.summary(q, 24);
  assert.equal(s.flowA.received, 3);
  assert.equal(s.flowA.distinctOrders, 2);
  assert.equal(s.flowA.converted, 2); // CREATED + CANCELLED (NOOP is not a conversion)
  assert.deepEqual(s.flowA.kafka, { SENT: 1, PENDING: 1, FAILED: 1 });
  assert.equal(s.flowB.received, 3);
  assert.equal(s.flowB.outcomes.SENT_214, 1);
  assert.equal(s.flowB.sftp.PENDING, 1);
  assert.equal(s.stuck.kafkaPending, 1);
  assert.equal(s.stuck.kafkaFailed, 1);
  assert.equal(s.stuck.sftp_pending, 1);
  assert.equal(s.trace.errors, 1);
  assert.equal(s.trace.warns, 1);
});

test('orders list shows every stage and search works', async () => {
  const all = await Q.orders(q, {});
  const o = all.find(r => r.dispatch_seq === '100');
  assert.equal(o.msgs, 2);
  assert.equal(o.last_outcome, 'NOOP');
  assert.equal(o.kafka_status, 'SENT');
  assert.equal(o.events, 2);
  assert.equal(o.edi214, 1);
  assert.equal(o.warns, 1);
  assert.equal((await Q.orders(q, { search: 'BOL2' })).map(r => r.dispatch_seq).join(), '200');
  assert.equal((await Q.orders(q, { hours: 1 })).length, 2);
});

test('order detail merges both flows into one timeline', async () => {
  const d = await Q.orderDetail(q, '100');
  const stages = d.timeline.map(t => t.stage);
  for (const s of ['204 received & converted', 'Published to Kafka', 'App event received', '214 generated', '214 to SFTP', 'Check']) assert.ok(stages.includes(s), s);
  assert.ok(d.timeline.some(t => t.flow === 'A') && d.timeline.some(t => t.flow === 'B'));
  assert.equal(d.rawChars, 0);
  assert.equal(await Q.orderDetail(q, 'nope'), null);
});

test('events join their 214 and filter by outcome', async () => {
  const ev = await Q.events(q, {});
  assert.equal(ev.find(e => e.event_id === 'e1').file_name, 'f.edi');
  assert.equal(ev.find(e => e.event_id === 'e3').errors, 1);
  assert.equal((await Q.events(q, { outcome: 'HELD' })).length, 1);
});

test('issues lists findings and stuck items; trace by id', async () => {
  const i = await Q.issues(q, {});
  assert.equal(i.trace.length, 2);
  assert.equal((await Q.issues(q, { level: 'error' })).trace.length, 1);
  assert.ok(i.stuck.some(s => s.channel === 'kafka' && s.status === 'FAILED'));
  assert.ok(i.stuck.some(s => s.channel === 'sftp-214'));
  assert.ok(i.stuck.some(s => s.channel === 'event' && s.status === 'ERROR'));
  assert.ok((await Q.traceById(q, i.trace[0].id)).incoming !== undefined);
});

test('log reader returns newest first, filters, drops full bodies by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logs-'));
  const rec = (ts, ref, level) => JSON.stringify({ ts, kind: 'order_204', ref, issues: level ? [{ level, code: 'X' }] : [], full: { big: 1 } });
  writeFileSync(join(dir, 'trace-20261115.jsonl'), [rec('2026-11-15T10:00:00Z', '1'), rec('2026-11-15T11:00:00Z', '2', 'error'), 'not json'].join('\n') + '\n');
  const all = await readLogs({ dirs: [dir] });
  assert.deepEqual(all.map(r => r.ref), ['2', '1']);
  assert.equal(all[0].full, undefined);
  assert.equal((await readLogs({ dirs: [dir], level: 'error' })).length, 1);
  assert.equal((await readLogs({ dirs: [dir], ref: '1', full: true }))[0].full.big, 1);
  assert.deepEqual(await readLogs({ dirs: ['/nonexistent'] }), []);
  const f = await fileStats({ ediDir: dir, eventsDir: dir, edi214Dir: dir });
  assert.equal(f.counts['204 input'], null);
});
