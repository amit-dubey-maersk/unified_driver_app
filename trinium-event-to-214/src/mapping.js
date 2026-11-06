import { localParts, utcToLocal } from './edi214.js';
import { utcToLocalInState } from './tz.js';
import { codeFor } from './refdata.js';

// Single place that decides which app events become which 214 AT7 status. Validated against the 1,850 OALM sample 214s:
//   AF departed pickup (rp1)   X3 arrived pickup (rp1)   X1 arrived delivery (rp2)   CD departed delivery (rp2)
//   AA / AB / AV / XB are NOT produced from driver-app events (dispatcher / back-office sources).

/** @returns {{code:string}|{skip:string, alert?:boolean}} */
export function mapEvent(ev, stopSeq, cfg) {
  const e = ev.event;
  if (e.transactionType === 'DELETE') return { skip: 'DELETE is not sent to Trinium (214 has no undo)', alert: true };
  switch (e.eventStatus) {
    // codes come from ref_event_code_map (database), see refdata.js
    case 'ARRIVAL': case 'DEPARTURE': {
      const m = codeFor(e.eventStatus, stopSeq);
      return m ? { code: m.code } : { skip: `route point ${stopSeq} has no 214 mapping` };
    }
    case 'CUSTOMER_APPOINTMENT|PICKUP': case 'CUSTOMER_APPOINTMENT|DROPOFF': {
      const m = codeFor(e.eventStatus, stopSeq);
      if (!m) return { skip: `${e.eventStatus} has no 214 mapping` };
      return m.flag && !cfg[m.flag] ? { skip: `${m.code} is dispatcher-sourced in Trinium, not produced from the app (ENABLE_APPOINTMENT_214=false)` } : { code: m.code };
    }
    case 'PROOF_OF_DELIVERY':
      return { skip: 'POD is a document: goes through the document path, not the 214 (CD comes from DEPARTURE at route point 2)' };
    case 'EQUIP_NUM_REGISTERED':
      return { skip: 'equipment is held and sent with the next 214 (chassis/container cannot go alone)', held: true };
    case 'DELAY': case 'WAIT_TIME': case 'WAIT_TIME_DAYS': case 'FUTILE_TRIP':
      return { skip: `${e.eventStatus}: Trinium 214 accepts only NS status; handled by dispatcher alert`, alert: true };
    case 'ORDER_STARTED': case 'ORDER_COMPLETED':
      return { skip: `${e.eventStatus}: app lifecycle marker, no 214 (arrival/departure at each stop drive the 214s)` };
    case 'GPS_UPDATE':
      return { skip: 'GPS is not supported by the 214 format' };
    default:
      return { skip: `unmapped eventStatus ${e.eventStatus}` };
  }
}

/** Local wall-clock time (ISO, no offset) of the milestone, preferring the app's own Local value. */
export function eventLocalTime(ev, code, stop) {
  const e = ev.event;
  const rp = e.routePoint || {};
  // app-supplied offset wins; otherwise the stop's state zone at the event instant (DST-correct); last resort the 204-time offset
  const offset = rp.timeZoneOffset || e.appointment?.timeZoneOffset;
  const conv = (utc) => (offset ? utcToLocal(utc, offset) : utcToLocalInState(utc, stop?.state) || utcToLocal(utc, stop?.time_zone_offset?.slice(0, 6)));
  if (code === 'AA' || code === 'AB') {
    const a = e.appointment || {};
    return a.appointmentDateTimeLocal || conv(a.appointmentDateTimeUTC);
  }
  const arrival = code === 'X3' || code === 'X1';
  return (arrival ? rp.actualArrivalDateTimeLocal : rp.actualDepartureDateTimeLocal)
    || conv(arrival ? rp.actualArrivalDateTimeUTC : rp.actualDepartureDateTimeUTC)
    || conv(ev.occurredAt);
}

export { localParts };
