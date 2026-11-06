import { createHash } from 'crypto';
import { parse204, versionKey, l11 } from '../edi/parser.js';
import { buildOrderPayload, STATUS } from '../transform.js';
import { norm } from '../geo.js';
import { db } from '../db/index.js';

const sha = s => createHash('sha256').update(s).digest('hex');
const stable = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

/** Top-level changed paths between two payloads (for the audit trail). */
function diff(a, b) {
  if (!a) return null;
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'status') continue;
    if (stable(a[k]) !== stable(b[k])) out.push(k);
  }
  return out;
}

/**
 * Apply one 204 file: parse -> decide NEW/UPDATE/CANCEL/NOOP/STALE -> persist leg + outbox atomically.
 * Returns the per-transaction results (payload + whether a message was queued for Kafka).
 * Throws EdiParseError on malformed input (caller moves the file to the error folder).
 */
export async function processFile({ fileName, raw, geo, topic }) {
  const { isa, transactions } = parse204(raw);
  const results = [];
  for (const tx of transactions) {
    results.push(await applyTransaction({ fileName, raw, isa, tx, geo, topic }));
  }
  return results;
}

async function applyTransaction({ fileName, raw, isa, tx, geo, topic }) {
  const vKey = versionKey(isa);
  const isCancel = tx.txnType === '01';

  return db().tx(async t => {
    const { rows } = await t.query('SELECT * FROM trinium_legs WHERE dispatch_seq = $1 FOR UPDATE', [tx.dispatchSeq]);
    const existing = rows[0];

    const audit = (outcome, changed, warnings) =>
      t.query(
        `INSERT INTO order_messages (dispatch_seq, file_name, isa_control, txn_type, version_key, outcome, changed_fields, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
        [tx.dispatchSeq, fileName, isa.control, tx.txnType, vKey, outcome, JSON.stringify(changed ?? null), JSON.stringify(warnings ?? [])],
      );

    // Out-of-order protection: an older interchange must never overwrite a newer one.
    if (existing && vKey < existing.version_key) {
      await audit('STALE', null, [`older than stored ${existing.version_key}`]);
      return { dispatchSeq: tx.dispatchSeq, outcome: 'STALE', published: false, payload: null };
    }

    const reactivated = existing?.status === 'CANCELLED' && !isCancel;
    const neverSent = !existing || existing.publish_count === 0 || reactivated;
    const status = isCancel ? STATUS.CANCELLED : neverSent ? STATUS.NEW : STATUS.UPDATED;

    let { payload, warnings, unmatched } = buildOrderPayload(tx, status, geo);
    if (isCancel && !tx.stops.length && existing?.payload) {
      // A cancel carrying no body: reuse the last known order so the backend can match it.
      payload = { ...existing.payload, status };
    }

    const { status: _s, ...business } = payload;
    const hash = sha(stable(business));
    const outcome = isCancel
      ? (existing?.status === 'CANCELLED' ? 'NOOP' : 'CANCELLED')
      : !existing ? 'CREATED' : reactivated ? 'REACTIVATED' : hash === existing.content_hash ? 'NOOP' : 'UPDATED';

    // Always refresh the stored leg (latest version wins), even on NOOP.
    const d = payload.orderDetails || {};
    await t.query(
      `INSERT INTO trinium_legs (dispatch_seq, consignment_seq, trinium_order_no, work_order, bol, booking_ref, container_number,
         leg_type, leg_number, carrier_code, driver_code, owner_site, last_chassis, status, last_txn_type, version_key, last_file_name,
         last_isa_control, payload, content_hash, raw_204, order_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22)
       ON CONFLICT (dispatch_seq) DO UPDATE SET
         consignment_seq=EXCLUDED.consignment_seq, trinium_order_no=EXCLUDED.trinium_order_no, work_order=EXCLUDED.work_order,
         bol=EXCLUDED.bol, booking_ref=EXCLUDED.booking_ref, container_number=EXCLUDED.container_number,
         leg_type=EXCLUDED.leg_type, leg_number=EXCLUDED.leg_number, carrier_code=EXCLUDED.carrier_code, driver_code=EXCLUDED.driver_code,
         owner_site=EXCLUDED.owner_site, last_chassis=EXCLUDED.last_chassis, status=EXCLUDED.status,
         last_txn_type=EXCLUDED.last_txn_type, version_key=EXCLUDED.version_key, last_file_name=EXCLUDED.last_file_name,
         last_isa_control=EXCLUDED.last_isa_control, payload=EXCLUDED.payload, content_hash=EXCLUDED.content_hash,
         raw_204=EXCLUDED.raw_204, order_id=EXCLUDED.order_id, updated_at=NOW()`,
      [
        tx.dispatchSeq, tx.csnSeq, d.triniumOrderNumber ?? null, d.workOrder ?? null, d.bol ?? null, d.bookingRefNumber ?? null,
        d.containerNumber ?? null, d.legType ?? null, d.legNumber ?? null, payload.vendorCode ?? null, payload.driverId ?? null, d.ownerSite ?? null,
        d.chassisNumber ?? null, isCancel ? 'CANCELLED' : 'ACTIVE', tx.txnType, vKey, fileName, isa.control,
        JSON.stringify(payload), hash, raw, payload.orderId ?? null,
      ],
    );

    await t.query('DELETE FROM trinium_leg_stops WHERE dispatch_seq = $1', [tx.dispatchSeq]);
    for (const r of payload.routes || []) {
      await t.query(
        `INSERT INTO trinium_leg_stops (dispatch_seq, seq, location_name, address, city, state, zip, site_code, geo_matched,
           time_zone_offset, planned_arrival, planned_departure, route_point_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [tx.dispatchSeq, r.sequence, r.addressName ?? null, r.addressLine1 ?? null, r.city ?? null, r.state ?? null,
          r.postalCode ?? null, r.siteCode ?? null, !!r.siteCode, r.timeZoneOffset ?? null,
          r.plannedArrivalDateTimeLocal ?? null, r.plannedDepartureDateTimeLocal ?? null, r.routePointId ?? null],
      );
    }

    for (const u of unmatched) {
      await t.query(
        `INSERT INTO unmatched_locations (name_norm, address, name, city, state, zip) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (name_norm, address) DO UPDATE SET seen_count = unmatched_locations.seen_count + 1, last_seen = NOW()`,
        [norm(u.name), u.address || '', u.name, u.city, u.state, u.zip],
      );
    }

    await audit(outcome, diff(existing?.payload, payload), warnings);

    const publish = outcome !== 'NOOP';
    if (publish) {
      await t.query(
        `INSERT INTO outbound_messages (dispatch_seq, topic, msg_key, payload) VALUES ($1,$2,$3,$4::jsonb)`,
        [tx.dispatchSeq, topic, tx.dispatchSeq, JSON.stringify(payload)],
      );
      // publish_count = messages queued for this leg; 0 means the backend has never been told about it (-> NEW)
      await t.query('UPDATE trinium_legs SET publish_count = publish_count + 1 WHERE dispatch_seq = $1', [tx.dispatchSeq]);
    }
    return { dispatchSeq: tx.dispatchSeq, outcome, published: publish, payload, warnings };
  });
}

export { l11 };
