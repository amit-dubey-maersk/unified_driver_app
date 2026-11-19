import { issue } from '../trace.js';
import { l11 } from '../edi/parser.js';

const n = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** What the 204 said (compact, comparable). */
export function summarize204(isa, tx) {
  const e = tx.n7 || {};
  return {
    isa: { sender: isa.sender, receiver: isa.receiver, date: isa.date, time: isa.time, control: isa.control },
    dispatchSeq: tx.dispatchSeq, txnType: tx.txnType, csnSeq: tx.csnSeq,
    to: l11(tx, 'TO'), bol: l11(tx, 'SS'), booking: l11(tx, 'TN'), workOrder: l11(tx, 'WO'), legType: l11(tx, 'LT'), legNumber: l11(tx, 'LN'),
    carrierTB: l11(tx, 'TB'), driver: l11(tx, process.env.DRIVER_QUALIFIER || 'DR'),
    container: e.prefix ? `${e.prefix}${e.number}${e.checkDigit ?? ''}` : null, size: e.size, equipmentType: e.equipmentType, weightN7: e.weight, weightL3: tx.l3?.weight,
    stops: (tx.stops || []).map(s => ({ seq: s.seq, reason: s.reason, name: s.name, city: s.city, state: s.state, zip: s.zip, appointments: (s.appointments || []).map(a => a.kind) })),
  };
}

/** What we produced for the mobile backend (compact). */
export function summarizeOrder(r) {
  const p = r.payload;
  if (!p) return { outcome: r.outcome, queuedForKafka: !!r.published };
  const d = p.orderDetails || {};
  return {
    outcome: r.outcome, status: p.status, queuedForKafka: !!r.published, orderNumber: p.orderNumber, orderId: p.orderId, vendorCode: p.vendorCode, driverId: p.driverId,
    triniumOrderNumber: d.triniumOrderNumber, bol: d.bol, containerNumber: d.containerNumber, grossWeight: d.grossWeight, legType: d.legType,
    routes: (p.routes || []).map(x => ({ sequence: x.sequence, addressName: x.addressName, city: x.city, state: x.state, siteCode: x.siteCode ?? null,
      activityType: x.activityType, plannedArrival: x.plannedArrivalDateTimeLocal, plannedDeparture: x.plannedDepartureDateTimeLocal })),
  };
}

/** Compare IN vs OUT and list everything that looks wrong or lost. */
export function compareOrder(inc, out, warnings = []) {
  const issues = warnings.map(w => issue('warn', 'TRANSFORM_WARNING', String(w)));
  if (['STALE', 'NOOP'].includes(out.outcome)) issues.push(issue('info', out.outcome, out.outcome === 'STALE' ? 'older interchange than the stored one: ignored' : 'no business change vs stored order: nothing queued'));
  if (!out.routes) return issues; // nothing built (stale) -> nothing more to compare

  if (inc.txnType !== '01') {
    if (!inc.container) issues.push(issue('warn', 'NO_CONTAINER_IN_204', 'the 204 carries no container (N7)'));
    else if (n(inc.container) !== n(out.containerNumber)) issues.push(issue('error', 'CONTAINER_MISMATCH', `204 ${inc.container} -> payload ${out.containerNumber}`));
    const w = Number(inc.weightN7 ?? inc.weightL3), pw = Number(out.grossWeight);
    if (Number.isFinite(w) && Number.isFinite(pw) && Math.abs(w - pw) > 1) issues.push(issue('warn', 'WEIGHT_MISMATCH', `204 ${w} -> payload ${pw}`));
    if (inc.bol && n(inc.bol) !== n(out.bol)) issues.push(issue('warn', 'BOL_MISMATCH', `204 SS ${inc.bol} -> payload ${out.bol}`));
    if (inc.to && n(inc.to) !== n(out.triniumOrderNumber)) issues.push(issue('warn', 'TO_MISMATCH', `204 TO ${inc.to} -> payload ${out.triniumOrderNumber}`));
    if (!out.driverId) issues.push(issue('info', 'NO_DRIVER', 'no driver code in the 204 (L11 DR): order is not pre-assigned'));
    else if (inc.driver && n(inc.driver) === n(out.driverId)) issues.push(issue('warn', 'DRIVER_UNMAPPED', `Trinium driver ${inc.driver} has no row in driver_mapping: sent to Kafka as-is`));
    else if (inc.driver) issues.push(issue('info', 'DRIVER_MAPPED', `Trinium driver ${inc.driver} -> ${out.driverId}`));
    if (!out.vendorCode) issues.push(issue('warn', 'NO_VENDOR_CODE', 'no carrier/vendor code derived'));
  }
  if (inc.stops.length !== out.routes.length) issues.push(issue('error', 'STOP_COUNT_MISMATCH', `204 has ${inc.stops.length} stop(s), payload has ${out.routes.length} route(s)`));
  inc.stops.forEach((s, i) => {
    const r = out.routes[i];
    if (!r) return;
    if (n(s.name) !== n(r.addressName)) issues.push(issue('warn', 'STOP_NAME_DIFF', `stop ${s.seq}: 204 "${s.name}" -> payload "${r.addressName}"`));
    if (!r.siteCode) issues.push(issue('warn', 'GEO_UNMATCHED', `stop ${s.seq} "${s.name}" (${s.city}, ${s.state}) not found in ref_geo_location: no geofence/site code`));
    if (!s.appointments.length) issues.push(issue('info', 'NO_APPOINTMENT', `stop ${s.seq} "${s.name}" has no appointment window in the 204`));
    else if (!r.plannedArrival) issues.push(issue('error', 'APPOINTMENT_LOST', `stop ${s.seq}: 204 has appointment(s) ${s.appointments.join(',')} but payload has no plannedArrival`));
  });
  return issues;
}
