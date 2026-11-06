import { STATE_TZ as DEFAULT_STATE_TZ, setStateZones } from './tz.js';

// Reference data kept in the database, with the built-in values as the seed (never overwriting ops edits) and as the fallback
// if a table cannot be read. Held in memory (sync lookups on the hot path) and refreshed periodically.

const DEFAULT_EVENT_MAP = [
  // event_key, route_seq (0 = any), at7, requires_flag, note
  ['ARRIVAL', 1, 'X3', null, 'arrived at pickup'],
  ['DEPARTURE', 1, 'AF', null, 'departed pickup'],
  ['ARRIVAL', 2, 'X1', null, 'arrived at delivery / return'],
  ['DEPARTURE', 2, 'CD', null, 'departed delivery / return (Finish Stop)'],
  ['CUSTOMER_APPOINTMENT|PICKUP', 0, 'AA', 'appointment214', 'dispatcher-sourced in Trinium; off unless ENABLE_APPOINTMENT_214=true'],
  ['CUSTOMER_APPOINTMENT|DROPOFF', 0, 'AB', 'appointment214', 'dispatcher-sourced in Trinium; off unless ENABLE_APPOINTMENT_214=true'],
];

let eventMap = new Map(DEFAULT_EVENT_MAP.map(r => [`${r[0]}#${r[1]}`, { code: r[2], flag: r[3] }]));

/** AT7 code for an app event at a stop: exact route_seq first, then the any-stop row. undefined = not mapped. */
export function codeFor(eventKey, routeSeq) {
  return eventMap.get(`${eventKey}#${routeSeq}`) || eventMap.get(`${eventKey}#0`);
}

const validZone = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

export async function loadRefData(db) {
  const states = Object.keys(DEFAULT_STATE_TZ);
  await db.query(
    `INSERT INTO ref_state_timezone (state, tz) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (state) DO NOTHING`,
    [states, states.map(k => DEFAULT_STATE_TZ[k])]);
  const cols = [0, 1, 2, 3, 4].map(i => DEFAULT_EVENT_MAP.map(r => r[i]));
  await db.query(
    `INSERT INTO ref_event_code_map (event_key, route_seq, at7_code, requires_flag, note)
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[]) ON CONFLICT (event_key, route_seq) DO NOTHING`, cols);

  const zr = (await db.query('SELECT state, tz FROM ref_state_timezone')).rows;
  const zm = new Map();
  for (const r of zr) {
    if (validZone(r.tz)) zm.set(r.state.toUpperCase(), r.tz);
    else {
      console.warn(`[REF] ref_state_timezone ${r.state} has an invalid zone "${r.tz}": using the built-in default`);
      if (DEFAULT_STATE_TZ[r.state.toUpperCase()]) zm.set(r.state.toUpperCase(), DEFAULT_STATE_TZ[r.state.toUpperCase()]);
    }
  }
  if (zm.size) setStateZones(zm);

  const er = (await db.query('SELECT event_key, route_seq, at7_code, requires_flag FROM ref_event_code_map WHERE active')).rows;
  if (er.length) eventMap = new Map(er.map(r => [`${r.event_key}#${r.route_seq}`, { code: r.at7_code, flag: r.requires_flag }]));
  return { states: zm.size, eventCodes: eventMap.size };
}
