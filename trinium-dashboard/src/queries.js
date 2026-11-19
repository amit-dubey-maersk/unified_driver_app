// All dashboard SQL. `q(sql, params) -> rows`. Read-only. Tables belong to the two services (trinium-order-transformer, trinium-event-to-214).
const W = 'make_interval(hours => $1::int)'; // time window helper, $1 = hours
const HAS = lvl => `issues @> '[{"level":"${lvl}"}]'::jsonb`;

/** Headline numbers for both flows within the last `hours`, plus what is stuck right now (all time). */
export async function summary(q, hours) {
  const w = [hours];
  // ONE round trip (the link to MDP costs ~100 ms per query): every block is a json aggregate computed server-side.
  const [r] = await q(`
    SELECT
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome', outcome, 'n', n)), '[]') FROM (SELECT outcome, count(*)::int n FROM order_messages WHERE created_at >= now() - ${W} GROUP BY 1) x) msgs,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'n', n)), '[]') FROM (SELECT status, count(*)::int n FROM outbound_messages WHERE created_at >= now() - ${W} GROUP BY 1) x) ob,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'n', n, 'oldest', oldest)), '[]') FROM (SELECT status, count(*)::int n, min(created_at) oldest FROM outbound_messages WHERE status <> 'SENT' GROUP BY 1) x) "obOpen",
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('outcome', outcome, 'n', n)), '[]') FROM (SELECT outcome, count(*)::int n FROM inbound_events WHERE received_at >= now() - ${W} GROUP BY 1) x) ev,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('status', status, 'sftp', sftp, 'n', n)), '[]') FROM (SELECT status, COALESCE(sftp_status, 'N/A') sftp, count(*)::int n FROM edi214_sent WHERE created_at >= now() - ${W} GROUP BY 1, 2) x) edi,
      (SELECT to_jsonb(x) FROM (SELECT count(*) FILTER (WHERE status = 'PENDING')::int file_pending, count(*) FILTER (WHERE sftp_status = 'PENDING')::int sftp_pending,
              count(*) FILTER (WHERE sftp_status = 'PENDING' AND sftp_error IS NOT NULL)::int sftp_failing FROM edi214_sent WHERE status = 'PENDING' OR sftp_status = 'PENDING') x) "ediOpen",
      (SELECT to_jsonb(x) FROM (SELECT count(*) FILTER (WHERE ${HAS('error')})::int errors, count(*) FILTER (WHERE ${HAS('warn')} AND NOT ${HAS('error')})::int warns, count(*)::int total
         FROM processing_trace WHERE created_at >= now() - ${W}) x) tr,
      (SELECT to_jsonb(x) FROM (SELECT (SELECT max(created_at) FROM order_messages) last_204, (SELECT max(sent_at) FROM outbound_messages) last_kafka_out,
              (SELECT max(received_at) FROM inbound_events) last_event, (SELECT max(written_at) FROM edi214_sent) last_214, (SELECT max(sftp_sent_at) FROM edi214_sent) last_sftp) x) last,
      (SELECT count(DISTINCT dispatch_seq)::int FROM order_messages WHERE created_at >= now() - ${W}) orders`, w);
  const { msgs, ob, obOpen, ev, edi, ediOpen, tr, last } = r, orders = [{ n: r.orders }], ediOpenRow = ediOpen;
  const by = (rows, k) => Object.fromEntries(rows.map(r => [r[k], r.n]));
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  const m = by(msgs, 'outcome'), o = by(ob, 'status'), e = by(ev, 'outcome');
  const sftp = {}, file = {};
  for (const r of edi) { sftp[r.sftp] = (sftp[r.sftp] || 0) + r.n; file[r.status] = (file[r.status] || 0) + r.n; }
  return {
    hours,
    flowA: { // Trinium 204 -> app
      received: sum(m), distinctOrders: orders[0].n, outcomes: m,
      converted: (m.CREATED || 0) + (m.UPDATED || 0) + (m.CANCELLED || 0) + (m.REACTIVATED || 0),
      kafka: o, queued: sum(o),
    },
    flowB: { // app events -> 214 -> Trinium
      received: sum(e), outcomes: e, edi214: sum(file), fileWritten: file.WRITTEN || 0, sftp,
    },
    stuck: {
      kafkaPending: obOpen.find(r => r.status === 'PENDING')?.n || 0, kafkaFailed: obOpen.find(r => r.status === 'FAILED')?.n || 0,
      kafkaOldest: obOpen.map(r => r.oldest).sort()[0] || null, ...ediOpenRow,
    },
    trace: tr, last,
  };
}

/** One row per Trinium leg with the state of every stage: 204 received -> converted -> Kafka, and the reverse flow counts. */
export async function orders(q, { limit = 100, search = '', hours = null } = {}) {
  const like = search ? `%${search}%` : null;
  return q(`
    SELECT l.dispatch_seq, l.trinium_order_no, l.bol, l.container_number, l.leg_type, l.status leg_status, l.driver_code, l.publish_count,
           l.created_at, l.updated_at,
           om.file_name, om.outcome last_outcome, om.txn_type, om.created_at received_at, om.warnings,
           (SELECT count(*)::int FROM order_messages x WHERE x.dispatch_seq = l.dispatch_seq) msgs,
           ob.status kafka_status, ob.attempts kafka_attempts, ob.last_error kafka_error, ob.sent_at kafka_sent_at, ob.created_at kafka_queued_at,
           ob.kafka_partition, ob.kafka_offset, ob.topic kafka_topic,
           (SELECT count(*)::int FROM outbound_messages x WHERE x.dispatch_seq = l.dispatch_seq) kafka_total,
           (SELECT count(*)::int FROM outbound_messages x WHERE x.dispatch_seq = l.dispatch_seq AND x.status <> 'SENT') kafka_open,
           (SELECT count(*)::int FROM inbound_events e WHERE e.dispatch_seq = l.dispatch_seq) events,
           (SELECT e.outcome FROM inbound_events e WHERE e.dispatch_seq = l.dispatch_seq ORDER BY e.received_at DESC LIMIT 1) last_event_outcome,
           (SELECT count(*)::int FROM edi214_sent s WHERE s.dispatch_seq = l.dispatch_seq) edi214,
           (SELECT count(*)::int FROM edi214_sent s WHERE s.dispatch_seq = l.dispatch_seq AND s.sftp_status = 'SENT') edi214_sftp,
           (SELECT count(*)::int FROM edi214_sent s WHERE s.dispatch_seq = l.dispatch_seq AND s.sftp_status = 'PENDING') edi214_sftp_pending,
           (SELECT count(*)::int FROM processing_trace t WHERE t.ref = l.dispatch_seq AND ${HAS('error').replace('issues', 't.issues')}) errors,
           (SELECT count(*)::int FROM processing_trace t WHERE t.ref = l.dispatch_seq AND ${HAS('warn').replace('issues', 't.issues')}) warns
      FROM trinium_legs l
      LEFT JOIN LATERAL (SELECT * FROM order_messages WHERE dispatch_seq = l.dispatch_seq ORDER BY id DESC LIMIT 1) om ON true
      LEFT JOIN LATERAL (SELECT * FROM outbound_messages WHERE dispatch_seq = l.dispatch_seq ORDER BY id DESC LIMIT 1) ob ON true
     WHERE ($1::text IS NULL OR l.dispatch_seq ILIKE $1 OR l.bol ILIKE $1 OR l.container_number ILIKE $1 OR l.trinium_order_no ILIKE $1 OR l.work_order ILIKE $1)
       AND ($3::int IS NULL OR l.updated_at >= now() - make_interval(hours => $3::int))
     ORDER BY l.updated_at DESC LIMIT $2`, [like, Math.min(Number(limit) || 100, 500), hours]);
}

/** Everything about one order, with a merged timeline across both flows. */
export async function orderDetail(q, id) {
  // ONE round trip: every block is aggregated to json server-side (8 parallel queries would each need their own connection).
  const agg = (cols, from, order) => `(SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY ${order}), '[]') FROM (SELECT ${cols} FROM ${from} WHERE ${from.split(' ')[0] === 'processing_trace' ? 'ref' : 'dispatch_seq'} = $1) x)`;
  const [r] = await q(`
    SELECT (SELECT to_jsonb(l) - 'raw_204' || jsonb_build_object('raw_chars', COALESCE(length(l.raw_204), 0)) FROM trinium_legs l WHERE l.dispatch_seq = $1) leg,
      ${agg('*', 'trinium_leg_stops', 'x.seq')} stops,
      ${agg('id, file_name, isa_control, txn_type, version_key, outcome, changed_fields, warnings, created_at', 'order_messages', 'x.id')} msgs,
      ${agg('id, topic, status, attempts, last_error, kafka_partition, kafka_offset, created_at, sent_at, payload', 'outbound_messages', 'x.id')} outbound,
      ${agg('event_id, event_type, event_status, source, occurred_at, outcome, detail, received_at, payload', 'inbound_events', 'x.received_at, x.event_id')} events,
      ${agg('id, at7_code, event_time_local, route_seq, event_id, isa_control, file_name, status, created_at, written_at, sftp_status, sftp_sent_at, sftp_error, content', 'edi214_sent', 'x.id')} edi,
      ${agg('id, service, kind, source, outcome, issues, incoming, outgoing, created_at', 'processing_trace', 'x.id')} traces,
      (SELECT to_jsonb(e) FROM leg_equipment e WHERE e.dispatch_seq = $1) equip`, [id]);
  if (!r.leg) return null;
  const { raw_chars, ...legRow } = r.leg;
  const { stops, msgs, outbound, events, edi, traces } = r, equip = [r.equip];
  const tl = [];
  for (const m of msgs) tl.push({ at: m.created_at, flow: 'A', stage: '204 received & converted', status: m.outcome, text: `${m.file_name || ''} (txn ${m.txn_type}, ISA ${m.isa_control})` });
  for (const o of outbound) {
    tl.push({ at: o.created_at, flow: 'A', stage: 'Queued for Kafka', status: 'QUEUED', text: `topic ${o.topic}` });
    if (o.sent_at) tl.push({ at: o.sent_at, flow: 'A', stage: 'Published to Kafka', status: 'SENT', text: `partition ${o.kafka_partition} offset ${o.kafka_offset}` });
    else if (o.status === 'FAILED') tl.push({ at: o.created_at, flow: 'A', stage: 'Kafka publish', status: 'FAILED', text: `${o.attempts} attempt(s): ${o.last_error || ''}` });
  }
  for (const e of events) tl.push({ at: e.received_at, flow: 'B', stage: 'App event received', status: e.outcome, text: `${e.event_type || ''} ${e.event_status || ''} - ${e.detail || ''}` });
  for (const d of edi) {
    tl.push({ at: d.created_at, flow: 'B', stage: '214 generated', status: d.status, text: `${d.at7_code} ${d.event_time_local} -> ${d.file_name}` });
    if (d.sftp_sent_at) tl.push({ at: d.sftp_sent_at, flow: 'B', stage: '214 delivered to SFTP', status: 'SENT', text: d.file_name });
    else if (d.sftp_status === 'PENDING') tl.push({ at: d.created_at, flow: 'B', stage: '214 to SFTP', status: 'PENDING', text: d.sftp_error || 'waiting for upload' });
  }
  for (const t of traces) for (const i of t.issues) tl.push({ at: t.created_at, flow: t.kind === 'order_204' ? 'A' : 'B', stage: 'Check', status: i.level.toUpperCase(), text: `${i.code}: ${i.message}` });
  tl.sort((a, b) => new Date(a.at) - new Date(b.at));
  return { leg: legRow, rawChars: raw_chars, stops, messages: msgs, outbound, events, edi214: edi, traces, equipment: equip[0] || null, timeline: tl };
}

/** Reverse flow: every app event and what became of it. */
export async function events(q, { limit = 100, outcome = '', search = '', hours = null } = {}) {
  return q(`
    SELECT e.event_id, e.dispatch_seq, e.event_type, e.event_status, e.source, e.occurred_at, e.outcome, e.detail, e.received_at,
           s.at7_code, s.event_time_local, s.file_name, s.status file_status, s.written_at, s.sftp_status, s.sftp_sent_at, s.sftp_error,
           (SELECT count(*)::int FROM processing_trace t WHERE t.source = e.event_id AND ${HAS('error').replace('issues', 't.issues')}) errors,
           (SELECT count(*)::int FROM processing_trace t WHERE t.source = e.event_id AND ${HAS('warn').replace('issues', 't.issues')}) warns
      FROM inbound_events e LEFT JOIN edi214_sent s ON s.event_id = e.event_id
     WHERE ($1::text = '' OR e.outcome = $1)
       AND ($2::text IS NULL OR e.dispatch_seq ILIKE $2 OR e.event_id ILIKE $2 OR e.event_status ILIKE $2 OR s.file_name ILIKE $2)
       AND ($4::int IS NULL OR e.received_at >= now() - make_interval(hours => $4::int))
     ORDER BY e.received_at DESC LIMIT $3`, [outcome, search ? `%${search}%` : null, Math.min(Number(limit) || 100, 500), hours]);
}

/** Everything that needs a person: trace issues plus items stuck in the outboxes. */
export async function issues(q, { limit = 100, level = '', hours = 168 } = {}) {
  const [trace, stuck] = await Promise.all([
    q(`SELECT id, created_at, service, kind, ref, source, outcome, issues FROM processing_trace
        WHERE jsonb_array_length(issues) > 0 AND created_at >= now() - ${W}
          AND ($2::text = '' OR issues @> ('[{"level":"' || $2 || '"}]')::jsonb)
        ORDER BY id DESC LIMIT $3`, [hours, level, Math.min(Number(limit) || 100, 500)]),
    q(`SELECT 'kafka' channel, dispatch_seq ref, status, attempts, last_error detail, created_at FROM outbound_messages WHERE status <> 'SENT'
       UNION ALL SELECT 'sftp-214', dispatch_seq, sftp_status, NULL, COALESCE(sftp_error, 'waiting for upload'), created_at FROM edi214_sent WHERE sftp_status = 'PENDING'
       UNION ALL SELECT 'event', dispatch_seq, outcome, NULL, detail, received_at FROM inbound_events WHERE outcome = 'ERROR'
       ORDER BY created_at DESC LIMIT 200`),
  ]);
  return { trace, stuck };
}

/** One trace record in full (incoming vs outgoing). */
export async function traceById(q, id) {
  return (await q(`SELECT * FROM processing_trace WHERE id = $1`, [id]))[0] || null;
}
