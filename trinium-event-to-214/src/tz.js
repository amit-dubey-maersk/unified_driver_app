// US state -> IANA zone (same table as the order service); used to get the DST-correct offset at the EVENT instant,
// because trinium_leg_stops.time_zone_offset was computed at the planned date and can be an hour off after a DST change.
export const STATE_TZ = {
  CA: 'America/Los_Angeles', WA: 'America/Los_Angeles', OR: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  AZ: 'America/Phoenix', UT: 'America/Denver', CO: 'America/Denver', NM: 'America/Denver', MT: 'America/Denver', WY: 'America/Denver', ID: 'America/Boise',
  TX: 'America/Chicago', IL: 'America/Chicago', MO: 'America/Chicago', LA: 'America/Chicago', AL: 'America/Chicago', MS: 'America/Chicago',
  TN: 'America/Chicago', AR: 'America/Chicago', OK: 'America/Chicago', KS: 'America/Chicago', NE: 'America/Chicago', IA: 'America/Chicago',
  MN: 'America/Chicago', WI: 'America/Chicago', ND: 'America/Chicago', SD: 'America/Chicago',
  NY: 'America/New_York', NJ: 'America/New_York', PA: 'America/New_York', GA: 'America/New_York', FL: 'America/New_York', SC: 'America/New_York',
  NC: 'America/New_York', VA: 'America/New_York', MD: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', MA: 'America/New_York',
  CT: 'America/New_York', RI: 'America/New_York', NH: 'America/New_York', VT: 'America/New_York', ME: 'America/New_York', OH: 'America/New_York',
  MI: 'America/Detroit', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York', WV: 'America/New_York',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};


// Active table: the built-in defaults until refdata.js loads ref_state_timezone from the database.
let zones = new Map(Object.entries(STATE_TZ));
export const setStateZones = m => { zones = m; };

/** Local wall-clock ISO (no offset) of a UTC instant in the zone of a US state; null if the state/instant is unknown. */
export function utcToLocalInState(utcIso, state) {
  const tz = zones.get((state || '').toUpperCase());
  const t = Date.parse(utcIso);
  if (!tz || Number.isNaN(t)) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
