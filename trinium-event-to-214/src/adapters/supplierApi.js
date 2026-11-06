import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * Adapter for the Maersk "Supplier Order Update Service" contract (OpenAPI 2.0.0, src/schema/supplier-order-update.openapi.json):
 *   TransportDocument     (/v1/updateTransportOrder)  accept / reject, container, seals, driver, truck + chassis, documents
 *   TransportOrderEvent   (/v1/reportEvent)           arrival / departure / delay / POD / appointment / GPS ...
 * Both are validated against that schema, then normalised into the service's internal event shape (one ORDER_EVENT per
 * transportLeg event, one ORDER_UPDATE for the update parts) so mapping / 214 logic stays in one place.
 */

const here = dirname(fileURLToPath(import.meta.url));
const api = JSON.parse(readFileSync(join(here, '..', 'schema', 'supplier-order-update.openapi.json'), 'utf8'));

// Statuses the real app sends that the published enum does not list (seen on the topic 2026-11-04). They carry no 214.
const APP_EXTRA_STATUS = ['ORDER_STARTED', 'ORDER_COMPLETED'];
api.components.schemas.Event.properties.eventStatus.enum.push(...APP_EXTRA_STATUS);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const f of ['double', 'int32', 'int64', 'float', 'binary']) ajv.addFormat(f, true); // OpenAPI-only formats
const wrap = name => ({ $ref: `#/components/schemas/${name}`, components: api.components });
const checkDoc = ajv.compile(wrap('TransportDocument'));
const checkEvt = ajv.compile(wrap('TransportOrderEvent'));

const LENGTH_ONLY = new Set(['maxLength', 'minLength']);
// Fields that carry no 214 information: a bad value there is logged, never a reason to lose a milestone.
const IRRELEVANT = e => /^\/(communicationMediaType|document|rate)(\/|$)/.test(e.instancePath || '');
const soft = e => LENGTH_ONLY.has(e.keyword) || IRRELEVANT(e);
const fmt = e => `${e.instancePath || '/'} ${e.message}`;

/** Which contract does this look like? null = not a supplier-API message. */
export function detectSupplierApi(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.uniqueIdentifier === undefined && !m.carrierBooking) return null;
  const legs = m.transportOrder?.transportPlan?.transportLeg;
  const hasEvent = Array.isArray(legs) && legs.some(l => l?.event);
  const hasUpdate = !!(m.transportOrder?.cargoStuffing || m.transportOrder?.transportPlan?.carriage || m.transportOrder?.transportPlan?.party
    || m.carrierBooking?.carrierBookingStatus || m.document || m.rate);
  // reportEvent carries events; updateTransportOrder carries the rest. A message with both is validated as TransportDocument (superset).
  return hasEvent && !hasUpdate ? 'EVENT' : 'UPDATE';
}

/** Structural errors fail; length overruns and problems in fields the 214 never uses (communicationMediaType, document, rate) are warnings. */
export function validateSupplierApi(m, kind) {
  const check = kind === 'EVENT' ? checkEvt : checkDoc;
  if (check(m)) return { ok: true, warnings: [] };
  const hard = check.errors.filter(e => !soft(e));
  const warnings = check.errors.filter(soft).map(fmt).slice(0, 5);
  if (!hard.length) return { ok: true, warnings };
  return { ok: false, errors: hard.map(fmt).slice(0, 8), warnings };
}

const typeVal = (types, name) => (types || []).find(t => t?.eventTypeName === name)?.eventTypeCode;
const iso = v => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString().replace('.000Z', 'Z') : undefined);
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16);
const clean = o => JSON.parse(JSON.stringify(o)); // drop undefined

function baseOf(m, occurredAt) {
  const carrier = (m.parties || []).find(p => /carrier/i.test(p.partyFunction || '')) || m.parties?.[0] || {};
  return {
    occurredAt: iso(occurredAt) || iso(m.createTimestamp) || new Date().toISOString(),
    sentAt: iso(m.createTimestamp),
    source: 'DRIVER_APP',
    actor: { vendorCode: carrier.partyCode, vendorScac: carrier.businessEntityCode },
    order: { orderNumber: m.carrierBooking?.carrierBookingNumber, sourceSystem: 'TRINIUM' }, // orderId is not part of this contract
  };
}

/** One transportLeg[].event -> internal ORDER_EVENT. */
function toOrderEvent(m, leg, idx) {
  const ev = leg.event;
  const t = ev.eventType;
  const warns = [];
  // Which instant is the milestone? ACTUAL_ARRIVAL / ACTUAL_DEPARTURE = the real arrival/departure time, converted by the app to UTC from
  // the stop's local time. `timestamp` is when the message was created/sent, which for an offline burst can be hours later, so it is only
  // the fallback. (In a test where the phone is not in the stop's time zone, ACTUAL_* lands hours after `timestamp`: that is reported
  // as a warning, but it is still the time the app says the arrival happened.) ACTUAL_TIME_MODE=timestamp reverses the preference.
  const useActual = process.env.ACTUAL_TIME_MODE !== 'timestamp';
  const actual = name => {
    const v = typeVal(t, name);
    if (!v) return undefined;
    if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v)) { warns.push(`${name} "${v}" has no time zone: ignored, event timestamp used`); return undefined; }
    const u = iso(v);
    const gap = u ? (Date.parse(u) - Date.parse(ev.timestamp)) / 3600000 : 0;
    // earlier than the send time is normal (offline); later than the send time is impossible for a real arrival: check device / stop time zone
    if (gap > 0.17) warns.push(`${name} ${u} is ${gap.toFixed(1)} h AFTER the message timestamp ${ev.timestamp}: used as the milestone time, check the device / stop time zone`);
    return useActual ? u : undefined;
  };
  const arrivalUtc = actual('ACTUAL_ARRIVAL');
  const departureUtc = actual('ACTUAL_DEPARTURE');
  const when = ev.timestamp;
  const loc = (ev.locations || [])[0];
  const cont = typeVal(t, 'LADEN_CONT') || typeVal(t, 'EMPTY_CONT');
  const base = baseOf(m, (ev.eventStatus === 'ARRIVAL' ? arrivalUtc : ev.eventStatus === 'DEPARTURE' ? departureUtc : undefined) || when);
  const user = typeVal(t, 'USER_ID');
  if (user) base.actor.userId = user;
  const vendor = typeVal(t, 'VENDOR_CODE');
  if (vendor && !base.actor.vendorCode) base.actor.vendorCode = vendor;
  const wo = typeVal(t, 'WORKORDER_NUMBER');
  if (wo) base.order.workOrderNumber = wo;
  const status = ev.eventStatus;
  const isDep = status === 'DEPARTURE';
  return clean({
    ...base,
    _warnings: warns.length ? warns : undefined,
    eventId: m.uniqueIdentifier + (m.transportOrder.transportPlan.transportLeg.length > 1 ? `#${idx}` : ''),
    eventType: 'ORDER_EVENT',
    event: {
      eventStatus: status,
      transactionType: ev.transactionType || 'ADD',
      eventSource: ev.eventTrigger,
      routePoint: {
        // LOC_GUID = the location id we sent as routePointId; ZTMSREFERENCE_ID = TMS reference; REF_EVENT_LOC / locations = site text.
        routePointId: typeVal(t, 'LOC_GUID'),
        tmsReferenceId: typeVal(t, 'ZTMSREFERENCE_ID'),
        siteCode: typeVal(t, 'REF_EVENT_LOC') || loc?.location,
        // no local time in this contract: the UTC instant is converted with the stop's offset held from the 204
        actualArrivalDateTimeUTC: status === 'ARRIVAL' ? (arrivalUtc || iso(when)) : undefined,
        actualDepartureDateTimeUTC: isDep ? (departureUtc || iso(when)) : undefined,
      },
      container: cont ? { containerNumber: cont } : undefined,
    },
  });
}

/** TransportDocument update parts -> internal ORDER_UPDATE (chassis, container, seals, truck, driver, accept/reject). */
function toOrderUpdate(m) {
  const to = m.transportOrder || {};
  const plan = to.transportPlan || {};
  const up = {};
  const cs = (to.cargoStuffing || [])[0];
  if (cs?.containerNumber) up.container = { containerNumber: cs.containerNumber };
  const seals = (to.cargoStuffing || []).flatMap(c => c.seals || []).filter(s => s.sealNumber);
  if (seals.length) up.seals = seals;
  const { truck, trailer } = plan.carriage || {};
  if (truck && (truck.truckIdentifier || truck.truckLicensePlate)) up.truck = truck;
  if (trailer?.trailerIdentifier || trailer?.trailerLicensePlate) up.chassis = { chassisNumber: trailer.trailerIdentifier, chassisLicensePlate: trailer.trailerLicensePlate };
  const d = (plan.party || [])[0];
  if (d) up.driver = { name: d.partyName, licenseNumber: d.licenseNumber, badgeNumber: d.badgeNumber, phones: d.telecommunicationNumbers };
  const st = m.carrierBooking?.carrierBookingStatus;
  if (st === 'CARRIER_ACCEPTED' || st === 'CARRIER_REJECTED') {
    const r = m.carrierBooking.carrierBookingRejectionReason;
    up.decision = { decision: st, reasonCode: r?.reasonCode, reasonText: r?.rejectionReasonAdditionalText };
  }
  if (!Object.keys(up).length) return null; // documents / charges / EQUIPMENT_ASSIGNED etc.: nothing a 214 can use
  const user = m.transportOrder?.transportPlan?.party?.[0]?.badgeNumber;
  const base = baseOf(m, m.createTimestamp);
  if (user) base.actor.userId = user;
  return clean({ ...base, eventId: m.uniqueIdentifier, eventType: 'ORDER_UPDATE', updates: up });
}

/**
 * Raw Kafka/folder message -> list of internal events. Never throws.
 * Returns [{ _invalid, eventId, raw }] for a supplier-API message that fails the schema, so it is recorded as ERROR.
 */
export function normalizeSupplierApi(m) {
  const kind = detectSupplierApi(m);
  if (!kind) return null;
  const v = validateSupplierApi(m, kind);
  const id = m.uniqueIdentifier || `invalid-${sha(JSON.stringify(m))}`;
  if (!v.ok) return [{ eventId: id, _invalid: `schema (supplier API): ${v.errors.join('; ')}`, _raw: m, eventType: undefined, order: { orderNumber: m.carrierBooking?.carrierBookingNumber } }];
  if (!m.carrierBooking?.carrierBookingNumber) return [{ eventId: id, _invalid: 'carrierBooking.carrierBookingNumber (the order number) is missing', order: {} }];

  const out = [];
  (m.transportOrder?.transportPlan?.transportLeg || []).forEach((leg, i) => { if (leg?.event) out.push(toOrderEvent(m, leg, i)); });
  const up = toOrderUpdate(m);
  if (up) out.push(out.length ? { ...up, eventId: `${up.eventId}#update` } : up);
  if (!out.length) return [{ eventId: id, _ignored: 'nothing 214-relevant in this message (document / charge / status only)', order: { orderNumber: m.carrierBooking.carrierBookingNumber, sourceSystem: 'TRINIUM' }, eventType: 'ORDER_UPDATE' }];
  if (v.warnings.length) out.forEach(e => { e._warnings = [...v.warnings, ...(e._warnings || [])]; });
  return out;
}
