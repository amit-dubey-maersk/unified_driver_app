// Trinium driver id <-> our driver id (table driver_mapping). `q` is anything with .query (db() or a transaction).
// An unmapped driver is never fatal: callers get null and decide (the order service sends the Trinium id as-is with a warning,
// the event service leaves the driver out of the 214).
const key = s => String(s ?? '').trim().toUpperCase();

/** Trinium id -> our id, or null. */
export async function ourDriverFor(q, triniumId) {
  if (!key(triniumId)) return null;
  const { rows } = await q.query('SELECT driver_id FROM driver_mapping WHERE trinium_driver_id = $1 AND active', [key(triniumId)]);
  return rows[0]?.driver_id ?? null;
}

/** Our id -> Trinium id, or null. */
export async function triniumDriverFor(q, ourId) {
  if (!key(ourId)) return null;
  const { rows } = await q.query('SELECT trinium_driver_id FROM driver_mapping WHERE upper(driver_id) = $1 AND active', [key(ourId)]);
  return rows[0]?.trinium_driver_id ?? null;
}
