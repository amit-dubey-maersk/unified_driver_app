import { l11 } from './edi/parser.js';
import { geoFields } from './geo.js';
import { tzForState } from './refdata.js';
import { createHash } from 'crypto';

// Status values sent to the mobile backend (single place to change if the backend expects others).
export const STATUS = { NEW: 'NEW', UPDATED: 'UPDATED', CANCELLED: 'CANCELLED' };

/** UTC offset like "-07:00:00" for a wall-clock local ISO time in an IANA zone (DST aware). */
export function tzOffset(tz, localIso) {
  if (!tz) return undefined;
  const base = localIso ? new Date(localIso + 'Z') : new Date();
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const get = d => (fmt.formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'GMT').replace('GMT', '') || '+00:00';
  let off = get(base);
  const m = off.match(/([+-])(\d\d):(\d\d)/);
  if (m) {
    // wall-clock was interpreted as UTC; shift by the offset once and re-read (handles DST boundaries)
    const ms = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
    off = get(new Date(base.getTime() - ms));
  }
  const mm = off.match(/([+-])(\d\d):(\d\d)/);
  return mm ? `${mm[1]}${mm[2]}:${mm[3]}:00` : '+00:00:00';
}

const isoDate = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const isoDateTime = (d, t) => {
  if (!d || !/^\d{8}$/.test(d)) return undefined;
  const tt = /^\d{4}/.test(t || '') ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '00:00';
  return `${isoDate(d)}T${tt}:00`;
};

/** ISO 6346 check digit for an 11-char container (owner+category+serial). */
export function iso6346CheckDigit(code10) {
  const vals = '0123456789A?BCDEFGHIJK?LMNOPQRSTU?VWXYZ';
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const v = vals.indexOf(code10[i]);
    if (v < 0) return null;
    sum += v * 2 ** i;
  }
  return (sum % 11) % 10;
}

function container(n7, warnings) {
  if (!n7) return {};
  const base = `${(n7.prefix || '').trim()}${(n7.number || '').trim()}`.toUpperCase();
  let check = (n7.checkDigit || '').trim();
  const calc = base.length === 10 ? iso6346CheckDigit(base) : null;
  if (!check && calc !== null) check = String(calc);
  else if (calc !== null && String(calc) !== check) warnings.push(`container ${base}${check}: check digit differs from ISO 6346 (${calc})`);
  const sizeRaw = (n7.size || '').toUpperCase(); // 40H, 40, 45H, 20
  const size = sizeRaw.replace(/\D/g, '');
  const high = /H$/.test(sizeRaw);
  return {
    containerNumber: base + check,
    containerType: [size, n7.equipmentType].filter(Boolean).join(' ') || undefined,
    containerHeight: size ? (high ? '9 6' : '8 6') : undefined,
    sCac: n7.ownerScac || undefined,
  };
}

const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
/** Deterministic UUID v5 so the app can echo orderId / routePointId back as UUIDs (update-event schema) and we can resolve them. */
export function uuidv5(name, ns = NS) {
  const h = createHash('sha1').update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name)])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const orderIdFor = dispatchSeq => uuidv5(`trinium:order:${dispatchSeq}`);
export const routePointIdFor = (dispatchSeq, seq) => uuidv5(`trinium:route:${dispatchSeq}:${seq}`);

const strip = o => JSON.parse(JSON.stringify(o)); // drops undefined

/**
 * Build the order payload for the mobile-backend topic from one parsed 204 transaction.
 * `status` is decided by the caller (NEW / UPDATED / CANCELLED).
 * Returns { payload, warnings[], unmatched[] }.
 */
export function buildOrderPayload(tx, status, geo) {
  const warnings = [];
  const unmatched = [];
  const legType = l11(tx, 'LT'); // FCL | ECL
  const gross = tx.n7?.weight || tx.l3?.weight;
  // Carrier code: L11*<carrier>*TB (e.g. OALM). Driver id: its own L11 element, qualifier DRIVER_QUALIFIER (default DR,
  // placeholder until agreed with Trinium). Legacy fallback: a TB value different from the ISA receiver is a driver code.
  const tb = (l11(tx, 'TB') || '').trim() || undefined;
  const isaCarrier = (tx.isa?.receiver || '').trim().toUpperCase() || undefined; // 'hddr' and 'HDDR' both occur in the feed
  const drv = (l11(tx, process.env.DRIVER_QUALIFIER || 'DR') || '').trim() || undefined;
  const carrier = (drv ? tb : undefined) || isaCarrier || tb;
  const driverCode = drv || (tb && tb !== isaCarrier ? tb : undefined);
  const pieces = l11(tx, 'PC');

  const route = tx.stops
    .sort((a, b) => a.seq - b.seq)
    .map((stop, i) => {
      const row = geo.find(stop.name, stop.address, stop.zip);
      const gf = geoFields(row);
      if (row?.fenceBroken) warnings.push(`stop ${stop.seq}: geofence polygon for "${stop.name}" is truncated/invalid in geo data, using centre point + radius`);
      if (!row) {
        unmatched.push({ name: stop.name, address: stop.address, city: stop.city, state: stop.state, zip: stop.zip });
        warnings.push(`stop ${stop.seq}: location "${stop.name}" not found in geo data`);
      }
      const isPickup = i === 0; // S5*1 LD / S5*2 UL: Trinium legs always have a pickup then a drop
      const appt = k => stop.appointments.find(a => a.kind === k);
      const u = appt('U'), lp = appt('LP');
      const g06 = tx.g62.find(g => g.q === '06'); // requested pickup date (date only)
      const g10 = tx.g62.find(g => g.q === '10'); // requested delivery date/time

      let plannedArrival = isoDateTime(u?.date, u?.time);
      let plannedDeparture = isoDateTime(lp?.date, lp?.time);
      if (isPickup && !plannedArrival && g06) plannedArrival = isoDateTime(g06.date, '0000');
      // Last resort for a pickup with no appointment and no G62*06: L11*IT = requested pickup date, sent as M/D/YYYY (date only)
      if (isPickup && !plannedArrival) { const it = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(l11(tx, 'IT') || ''); if (it) plannedArrival = `${it[3]}-${it[1].padStart(2, '0')}-${it[2].padStart(2, '0')}T00:00:00`; }
      if (!isPickup && g10 && !plannedArrival) plannedArrival = isoDateTime(g10.date, g10.el3); // an appointment (G62*70) beats the requested date

      const tz = tzForState(stop.state);
      const siteType = gf.siteType || 'CustomerFacility';
      return {
        routePointId: routePointIdFor(tx.dispatchSeq, stop.seq),
        sequence: stop.seq,
        siteCode: gf.siteCode,
        siteType,
        addressName: stop.name,
        addressLine1: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.zip,
        country: stop.country,
        plannedArrivalDateTimeLocal: plannedArrival,
        plannedDepartureDateTimeLocal: plannedDeparture,
        activityType: isPickup ? 'PICK_UP' : 'DROP_OFF',
        activityDescription: isPickup ? 'Pick-up Container' : 'Drop-off Container',
        isCustomerLocation: siteType === 'CustomerFacility',
        location: gf.location,
        geofence: gf.geofence,
        geofenceRadiusMeters: gf.geofenceRadiusMeters,
        queuedFence: gf.queuedFence,
        legType,
        timeZoneOffset: tzOffset(tz, plannedArrival),
      };
    });

  const lfd = tx.g62.find(g => g.q === 'DM');
  const payload = strip({
    orderNumber: tx.dispatchSeq,
    orderId: orderIdFor(tx.dispatchSeq),
    sourceSystem: 'TRINIUM',
    vendorCode: carrier,
    driverId: driverCode,
    loadType: legType === 'ECL' ? 'Empty' : 'Laden',
    status,
    orderDetails: {
      bookingRefNumber: l11(tx, 'TN'),
      customerName: tx.parties.BN?.name,
      bol: l11(tx, 'SS'),
      ...container(tx.n7, warnings),
      direction: 'Import',
      oceanCarrier: l11(tx, 'SL'),
      chassisNumber: l11(tx, 'CH'),
      grossWeight: gross,
      weightUom: 'LBR',
      legType,
      legNumber: l11(tx, 'LN'),
      workOrder: l11(tx, 'WO'),
      pickupNumber: l11(tx, 'AT') || undefined, // L11*AT = pin / appointment number (DrayApp guide: "Pickup Number" / "Pin/Appt#")
      triniumOrderNumber: l11(tx, 'TO'),
      vessel: l11(tx, 'WU'),
      voyage: l11(tx, 'V3'),
      sealNumber: l11(tx, 'SN'),
      ownerSite: l11(tx, 'SC'),
      lastFreeDay: lfd ? isoDateTime(lfd.date, lfd.el3) : undefined,
      moveType: /STAY/i.test(tx.at5?.desc || '') ? 'STAY' : 'DROP',
      pieceCount: pieces && Number(pieces) > 0 ? pieces : undefined,
    },
    dispatchSequenceNumber: tx.dispatchSeq,
    consignmentSequenceNumber: tx.csnSeq || undefined,
    instructions: tx.instructions.length ? tx.instructions : undefined,
    routes: route,
  });
  return { payload, warnings, unmatched };
}
