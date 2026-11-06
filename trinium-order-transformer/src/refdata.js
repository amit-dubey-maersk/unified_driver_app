
// Reference data kept in the database (ref_state_timezone) with built-in defaults as the seed and as the fallback
// if the table cannot be read. Held in memory (sync lookups on the hot path) and refreshed periodically.
export const DEFAULT_STATE_TZ = {
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

let stateTz = new Map(Object.entries(DEFAULT_STATE_TZ));

/** IANA zone for a US state code, or undefined. */
export const tzForState = state => stateTz.get((state || '').toUpperCase());

const validZone = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** Seed missing rows from the defaults (never overwrites ops edits), then load the table into memory. */
export async function loadRefData(db) {
  const keys = Object.keys(DEFAULT_STATE_TZ);
  await db.query(
    `INSERT INTO ref_state_timezone (state, tz) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (state) DO NOTHING`,
    [keys, keys.map(k => DEFAULT_STATE_TZ[k])]);
  const { rows } = await db.query('SELECT state, tz FROM ref_state_timezone');
  const m = new Map();
  for (const r of rows) {
    if (validZone(r.tz)) m.set(r.state.toUpperCase(), r.tz);
    else {
      console.warn(`[REF] ref_state_timezone ${r.state} has an invalid zone "${r.tz}": using the built-in default`);
      if (DEFAULT_STATE_TZ[r.state.toUpperCase()]) m.set(r.state.toUpperCase(), DEFAULT_STATE_TZ[r.state.toUpperCase()]);
    }
  }
  if (m.size) stateTz = m;
  return { states: stateTz.size };
}
