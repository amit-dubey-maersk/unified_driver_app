import 'dotenv/config';
import { initDb, db } from '../db/index.js';
import { loadRefData } from '../refdata.js';

// npm run migrate  -> create/upgrade all tables (idempotent) and seed reference data, then list what exists.
// Run it once from a machine that can reach the database (VPN / MDP) before the first deploy; the services also migrate on start.
process.env.DB_MIGRATE = 'true';
try {
  await initDb();
  const ref = await loadRefData(db());
  const { rows } = await db().query(
    `SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = COALESCE(NULLIF(current_schema(), ''), 'public') ORDER BY 1`);
  console.log(`[MIGRATE] ok, reference data: ${ref.states} state time zones`);
  console.table(rows);
  await db().close();
} catch (e) {
  console.error(`[MIGRATE] FAILED: ${e.code || ''} ${e.message}`);
  process.exit(1);
}
