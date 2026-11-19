import pg from 'pg';

/** Read-only pool on the shared Postgres (same PG* variables as the two services). Every session is forced read-only. */
export function makePool(e = process.env) {
  if (!e.PGHOST) throw new Error('PGHOST is not set: the dashboard reads the shared Postgres (same PG* settings as the services)');
  const mode = (e.PGSSLMODE || 'require').toLowerCase();
  const pool = new pg.Pool({
    host: e.PGHOST, port: Number(e.PGPORT || 5432), database: e.PGDATABASE, user: e.PGUSER, password: e.PGPASSWORD,
    ssl: mode === 'disable' ? false : { rejectUnauthorized: false },
    options: [e.PGSCHEMA && `-c search_path=${e.PGSCHEMA}`, '-c default_transaction_read_only=on', '-c statement_timeout=15000'].filter(Boolean).join(' '),
    max: Number(e.PG_POOL_MAX || 6), min: Number(e.PG_POOL_MIN || 2), connectionTimeoutMillis: 10000, application_name: 'trinium-dashboard',
    // Each new connection costs a TLS handshake (~1.5 s to MDP); the default 10 s idle timeout would drop them between 10 s refreshes.
    idleTimeoutMillis: Number(e.PG_IDLE_TIMEOUT_MS || 300000), keepAlive: true, keepAliveInitialDelayMillis: 10000, maxLifetimeSeconds: 1800,
  });
  pool.on('error', err => console.error(`[DB] idle client error: ${err.message}`));
  const warm = () => Promise.all(Array.from({ length: pool.options.min }, () => pool.connect())).then(cs => cs.forEach(c => c.release())).catch(() => {});
  return { warm, q: async (sql, p) => (await pool.query(sql, p)).rows, close: () => pool.end() };
}
