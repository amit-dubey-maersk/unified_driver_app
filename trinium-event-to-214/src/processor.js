import { createHash } from 'crypto';
import { writeFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { db } from './db/index.js';
import { validateEvent } from './validate.js';
import { mapEvent, eventLocalTime, localParts } from './mapping.js';
import { build214, fileName214, splitContainer, appSizeToN7, sizeFromOrder, utcToLocal } from './edi214.js';
import { utcToLocalInState } from './tz.js';
import { metrics } from './metrics.js';
import { normalizeSupplierApi } from './adapters/supplierApi.js';

export function loadConfig(env = process.env) {
  // EDI_PROFILE=DRAYAPP (default): shape of the existing DrayApp -> Trinium 214s (HDDR>HDDR, B10-01 = 204 SS, WO + LX segments,
  // 2-decimal weight, container optional, XB sent).  EDI_PROFILE=OALM: shape of the OALM sample 214s. See src/edi214.js.
  const profile = (env.EDI_PROFILE || 'DRAYAPP').toUpperCase();
  const dray = profile === 'DRAYAPP';
  const id = dray ? 'HDDR' : 'OALM';
  return {
    profile,
    sender: env.ISA_SENDER_ID || id,                // decision D2: new partner id once provisioned
    receiver: env.ISA_RECEIVER_ID || 'HDDR',
    scac: env.B10_SCAC || env.ISA_SENDER_ID || id,  // B10-03 partner SCAC/id
    // Our own control-number range: far above the existing DrayApp stream (~4.4 million, +1 each) and with a different step, so the two never meet.
    controlStart: Number(env.EDI_CONTROL_START || 50000000),
    controlStep: Number(env.EDI_CONTROL_STEP || 7),
    outDir: env.EDI_OUT_DIR || './edi214/outbound',
    toMode: env.L11_TO_MODE || 'from204',           // from204 | omit  (OALM 214 TO values are internal; DrayApp 214 TO == 204 TO)
    appointment214: env.ENABLE_APPOINTMENT_214 === 'true', // AA/AB are not app events -> off
    sendXB: env.SEND_XB !== undefined ? env.SEND_XB === 'true' : true, // driver Accept -> XB (605 of 2,165 DrayApp 214s)
  };
}

const norm = s => (s || '').toUpperCase().replace(/[\s\-_]+/g, '');

/**
 * Which stop of the leg is this event about? Resolved only from our own data - never guessed:
 * routePointId (uuid we sent) -> tmsReferenceId -> siteCode/location name (must be unambiguous).
 */
export function resolveStop(rp, stops) {
  if (!rp) return { error: 'event has no routePoint' };
  const byId = stops.find(s => s.route_point_id && (s.route_point_id === rp.routePointId || s.route_point_id === rp.tmsReferenceId));
  if (byId) return { stop: byId, via: 'routePointId' };
  const key = norm(rp.siteCode);
  if (key) {
    const hits = stops.filter(s => norm(s.site_code) === key || norm(s.location_name) === key);
    if (hits.length === 1) return { stop: hits[0], via: 'siteCode' };
    if (hits.length > 1) return { error: `siteCode "${rp.siteCode}" matches both stops of the leg (pickup and drop at same site); routePointId required` };
  }
  return { error: `route point ${rp.routePointId} / site "${rp.siteCode ?? ''}" not found on this leg` };
}

/**
 * Raw message (Kafka value / dropped file) -> internal events. Messages in the Maersk Supplier Order Update contract
 * (TransportDocument / TransportOrderEvent) are validated against its OpenAPI schema and normalised; anything else is
 * treated as an internal-format event (schema/update-event.schema.json).
 */
export function toEvents(raw) {
  const n = normalizeSupplierApi(raw);
  return n ? n.map(e => ({ ...e, _supplier: true })) : [raw];
}

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function record(t, ev, eventId, outcome, detail) {
  await t.query(
    `INSERT INTO inbound_events (event_id, dispatch_seq, event_type, event_status, source, occurred_at, outcome, detail, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, ev?.order?.orderNumber ?? null, ev?.eventType ?? null, ev?.event?.eventStatus ?? null, ev?.source ?? null,
      ev?.occurredAt && !Number.isNaN(Date.parse(ev.occurredAt)) ? ev.occurredAt : null, outcome, detail ?? null, JSON.stringify(ev ?? null)]);
}

/**
 * Handle one driver-app event object. Returns { outcome, detail, code?, fileName? }.
 * Outcomes: SENT_214 | HELD | SKIPPED | DUPLICATE | ERROR
 */
export async function handleEvent(ev, cfg = loadConfig(), now = new Date()) {
  const v = ev?._invalid ? { ok: false, errors: [] } : ev?._supplier ? { ok: true } : validateEvent(ev);
  const eventId = ev?.eventId || `invalid-${sha(JSON.stringify(ev))}`;
  if (!v.ok) {
    const detail = ev?._invalid || `schema: ${v.errors.join('; ')}`;
    await db().tx(t => record(t, ev, eventId, 'ERROR', detail));
    metrics.events.inc({ outcome: 'ERROR' });
    return { outcome: 'ERROR', detail };
  }

  const result = await db().tx(async t => {
    if ((await t.query('SELECT 1 FROM inbound_events WHERE event_id=$1', [eventId])).rows.length) return { outcome: 'DUPLICATE', detail: 'eventId already processed' };

    const fin = async (outcome, detail, extra = {}) => { await record(t, ev, eventId, outcome, detail); return { outcome, detail, ...extra }; };

    if (ev._ignored) return fin('SKIPPED', ev._ignored);
    if (ev.order.sourceSystem !== 'TRINIUM') return fin('SKIPPED', `sourceSystem ${ev.order.sourceSystem} is not handled here (router)`);

    const leg = (await t.query('SELECT * FROM trinium_legs WHERE dispatch_seq=$1', [ev.order.orderNumber])).rows[0];
    if (!leg) return fin('ERROR', `unknown order ${ev.order.orderNumber}: no 204 received for this dispatch sequence`);
    if (leg.status === 'CANCELLED') return fin('SKIPPED', `leg ${leg.dispatch_seq} is cancelled`);
    const warn = [...(ev._warnings || []).map(w => `schema warning ${w}`)];
    if (leg.order_id && ev.order.orderId && ev.order.orderId !== leg.order_id) warn.push(`orderId ${ev.order.orderId} differs from the one sent (${leg.order_id})`);

    const stops = (await t.query('SELECT * FROM trinium_leg_stops WHERE dispatch_seq=$1 ORDER BY seq', [leg.dispatch_seq])).rows;

    // ---- equipment / assignment data held for the next 214 ----
    const up = ev.updates || {};
    const evContainer = ev.event?.container;
    const cont = up.container || evContainer;
    if (up.chassis || cont || up.seals || up.truck || up.driver || up.decision) {
      await t.query(
        `INSERT INTO leg_equipment (dispatch_seq, chassis, chassis_plate, container_number, container_size_type, net_weight, net_weight_uom,
           seals, truck_id, truck_plate, driver, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13)
         ON CONFLICT (dispatch_seq) DO UPDATE SET
           chassis=COALESCE(EXCLUDED.chassis, leg_equipment.chassis), chassis_plate=COALESCE(EXCLUDED.chassis_plate, leg_equipment.chassis_plate),
           container_number=COALESCE(EXCLUDED.container_number, leg_equipment.container_number),
           container_size_type=COALESCE(EXCLUDED.container_size_type, leg_equipment.container_size_type),
           net_weight=COALESCE(EXCLUDED.net_weight, leg_equipment.net_weight), net_weight_uom=COALESCE(EXCLUDED.net_weight_uom, leg_equipment.net_weight_uom),
           seals=COALESCE(EXCLUDED.seals, leg_equipment.seals), truck_id=COALESCE(EXCLUDED.truck_id, leg_equipment.truck_id),
           truck_plate=COALESCE(EXCLUDED.truck_plate, leg_equipment.truck_plate), driver=COALESCE(EXCLUDED.driver, leg_equipment.driver),
           decision=COALESCE(EXCLUDED.decision, leg_equipment.decision), decision_reason=COALESCE(EXCLUDED.decision_reason, leg_equipment.decision_reason),
           updated_at=NOW()`,
        [leg.dispatch_seq, up.chassis?.chassisNumber ?? null, up.chassis?.chassisLicensePlate ?? null, cont?.containerNumber ?? null,
          cont?.containerSizeType ?? null, cont?.netWeight ?? null, cont?.netWeightUOM ?? null,
          up.seals ? JSON.stringify(up.seals) : null, up.truck?.truckIdentifier ?? null, up.truck?.truckLicensePlate ?? null,
          up.driver ? JSON.stringify(up.driver) : null, up.decision?.decision ?? null,
          up.decision ? [up.decision.reasonCode, up.decision.reasonText].filter(Boolean).join(' ') || null : null]);
    }

    // ---- decide whether a 214 is due ----
    let code, local, routeSeq = null;
    if (ev.eventType === 'ORDER_UPDATE') {
      if (up.decision?.decision === 'CARRIER_REJECTED') return fin('SKIPPED', `rejected by driver (${up.decision.reasonCode}): no 214 exists for reject - dispatcher alert + reassignment (D4)`);
      if (up.decision?.decision === 'CARRIER_ACCEPTED' && cfg.sendXB) {
        code = 'XB';
        local = utcToLocalInState(ev.occurredAt, stops[0]?.state) || utcToLocal(ev.occurredAt, (stops[0]?.time_zone_offset || '').slice(0, 6)); // DST-correct at the event instant
      } else {
        const what = Object.keys(up).join(', ');
        return fin('HELD', `${what} stored; goes out with the next 214${up.decision ? ' (XB disabled)' : ''}`);
      }
    } else {
      const rp = resolveStop(ev.event.routePoint, stops);
      // only statuses that can become a 214 need a stop; lifecycle markers (ORDER_STARTED/COMPLETED), POD, delay, GPS... carry none
      const needsStop = ['ARRIVAL', 'DEPARTURE'].includes(ev.event.eventStatus) || (cfg.appointment214 && /^CUSTOMER_APPOINTMENT/.test(ev.event.eventStatus));
      if (rp.error && needsStop) return fin('ERROR', rp.error);
      routeSeq = rp.stop?.seq ?? null;
      const m = mapEvent(ev, routeSeq, cfg);
      if (m.skip) return fin(m.held ? 'HELD' : 'SKIPPED', m.skip);
      code = m.code;
      local = eventLocalTime(ev, code, rp.stop);
    }

    const lp = localParts(local);
    if (!lp) return fin('ERROR', `no usable local time for ${code} (need ...DateTimeLocal, or UTC + timeZoneOffset)`);

    // ---- build the 214 from leg + latest equipment ----
    const eq = (await t.query('SELECT * FROM leg_equipment WHERE dispatch_seq=$1', [leg.dispatch_seq])).rows[0] || {};
    const dray = cfg.profile === 'DRAYAPP';
    const containerNo = eq.container_number || leg.container_number;
    let c = splitContainer(containerNo);
    // DrayApp 214s legitimately go out without a container (265 of 2,165: bobtail / chassis moves and legs not yet assigned)
    if (!c && !(dray && !containerNo)) return fin('ERROR', `container "${containerNo}" is not a valid 11-character ISO container number`);
    if (!c) c = {};
    if (eq.container_number && leg.container_number && eq.container_number !== leg.container_number) warn.push(`container changed by driver: ${leg.container_number} -> ${eq.container_number}`);
    const od = leg.payload?.orderDetails || {};
    const weight = od.grossWeight != null && od.grossWeight !== ''
      ? (dray ? Number(od.grossWeight).toFixed(2) : String(Math.trunc(Number(od.grossWeight)))) // DrayApp: 2 decimals, OALM: integer
      : '';
    const size = appSizeToN7(eq.container_size_type) || sizeFromOrder(od.containerType, od.containerHeight) || '';

    const idem = `${leg.dispatch_seq}|${code}|${lp.date}${lp.time}`;
    if ((await t.query('SELECT 1 FROM edi214_sent WHERE idempotency_key=$1', [idem])).rows.length) {
      return fin('SKIPPED', `214 ${code} for ${lp.date} ${lp.time} already generated`);
    }

    const ctl = Number((await t.query(
      `INSERT INTO edi214_control (name, last_value) VALUES ($1,$2::bigint)
       ON CONFLICT (name) DO UPDATE SET last_value = GREATEST(edi214_control.last_value + $3::bigint, $2::bigint)
       RETURNING last_value`, [cfg.sender, cfg.controlStart, cfg.controlStep])).rows[0].last_value);

    const content = build214({
      isaControl: ctl, now, sender: cfg.sender, receiver: cfg.receiver, scac: cfg.scac,
      profile: cfg.profile, bol: leg.bol || undefined, wo: od.workOrder || undefined,
      // OALM samples: B10-01 = 204 L11*TN (booking).  DrayApp 214s: B10-01 = 204 L11*SS (BOL) in 1,317 of 1,317 matched legs.
      b10_01: dray ? (leg.bol || leg.booking_ref || leg.dispatch_seq) : (leg.booking_ref || leg.bol || leg.dispatch_seq),
      dispatchSeq: leg.dispatch_seq,
      to: cfg.toMode === 'omit' ? undefined : od.triniumOrderNumber,
      legType: leg.leg_type, legNumber: leg.leg_number || '1',
      chassis: eq.chassis || leg.last_chassis || undefined,
      container: { ...c, weight, size }, code, local: lp,
    });
    const fileName = fileName214(now, ctl, code, { profile: cfg.profile, container: containerNo || '' });
    await t.query(
      `INSERT INTO edi214_sent (dispatch_seq, at7_code, event_time_local, route_seq, event_id, idempotency_key, isa_control, file_name, content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [leg.dispatch_seq, code, lp.date + lp.time, routeSeq, eventId, idem, String(ctl).padStart(9, '0'), fileName, content]);
    return fin('SENT_214', `${code} ${lp.date} ${lp.time} LT -> ${fileName}${warn.length ? ' | ' + warn.join('; ') : ''}`, { code, fileName });
  });

  metrics.events.inc({ outcome: result.outcome });
  if (result.code) metrics.sent.inc({ code: result.code });
  return result;
}

/** Write any generated-but-unwritten 214 files to the outbound folder (atomic: temp file + rename). */
export async function flushFiles(dir = loadConfig().outDir) {
  const { rows } = await db().query(`SELECT id, file_name, content FROM edi214_sent WHERE status='PENDING' ORDER BY id`);
  if (!rows.length) return 0;
  await mkdir(dir, { recursive: true });
  for (const r of rows) {
    const tmp = join(dir, `.${r.file_name}.tmp`);
    await writeFile(tmp, r.content, 'latin1');
    await rename(tmp, join(dir, r.file_name));
    await db().query(`UPDATE edi214_sent SET status='WRITTEN', written_at=NOW() WHERE id=$1`, [r.id]);
  }
  return rows.length;
}
