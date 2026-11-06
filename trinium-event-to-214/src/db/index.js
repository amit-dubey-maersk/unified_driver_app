import { readFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// NOTE: this file is identical in trinium-order-transformer and trinium-event-to-214 (both share one database). Keep them in sync.
const __dirname = dirname(fileURLToPath(import.meta.url));

let impl; // { query(sql, params), exec(sql), tx(fn), health(), stats(), close(), kind }

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIGRATION_LOCK = 727001; // pg_advisory_lock key: only one service migrates at a time

/**
 * Postgres (MDP / udapdb001) when PGHOST is set, otherwise embedded PGlite persisted under DB_DIR (local dev + tests).
 * Pool, timeouts and retries are configured by environment, see .env.sample.
 */
export async function initDb() {
  if (impl) return impl;
  impl = process.env.PGHOST ? await initPg() : await initPglite();
  if (process.env.DB_MIGRATE !== 'false') await migrate();
  console.log(`[DB] ready (${impl.kind}), schema ${process.env.DB_MIGRATE === 'false' ? 'NOT applied (DB_MIGRATE=false)' : 'applied'}`);
  return impl;
}

/** Apply schema.sql. Idempotent; serialised across services/instances with an advisory lock so concurrent starts cannot race. */
export async function migrate() {
  let schema;
  try { schema = await readFile(join(__dirname, 'schema.sql'), 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.warn('[DB] no schema.sql shipped with this build: tables must already exist (created by the DBA / release step)');
    return;
  }
  if (!impl.isPg) return impl.exec(schema); // PGlite: one process, multi-statement exec
  await impl.tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]); // held until COMMIT
    await t.query(schema);                                              // simple protocol: multi-statement script
  });
}

// ---------------------------------------------------------------- retry policy
// "safe": nothing was executed (connect failed, server starting/full)      -> always retry
// "rolled back": server aborted the transaction (serialization, deadlock, admin shutdown, failover) -> retry
// "ambiguous": connection dropped mid-flight                                 -> retry reads and whole transactions only
//   (every write in these services is idempotent by key: inbound_events.event_id, edi214_sent.idempotency_key, trinium_legs.dispatch_seq)
const SAFE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '53300', '08001', '08004', '08003']);
const ROLLED_BACK = new Set(['40001', '40P01', '57P01', '57P02', '25006', '53400']);
const AMBIGUOUS = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', '08006', '08000']);

export function classify(e) {
  const code = e?.code;
  const msg = String(e?.message || '');
  if (SAFE.has(code) || /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(msg)) return 'safe';
  if (ROLLED_BACK.has(code)) return 'rolled-back';
  if (AMBIGUOUS.has(code) || /Connection terminated unexpectedly|Client has encountered a connection error|read ECONNRESET/i.test(msg)) return 'ambiguous';
  return 'fatal';
}

async function retrying(label, fn, { idempotent }) {
  const max = num(process.env.DB_RETRY_MAX, 5);
  const base = num(process.env.DB_RETRY_BASE_MS, 200);
  const cap = num(process.env.DB_RETRY_MAX_MS, 5000);
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      const k = classify(e);
      const retry = k === 'safe' || k === 'rolled-back' || (k === 'ambiguous' && idempotent);
      if (!retry || attempt >= max) { e.dbRetries = attempt - 1; throw e; }
      const wait = Math.min(cap, base * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2); // exponential backoff with jitter
      console.warn(`[DB] ${label} failed (${k}: ${e.code || e.message}); retry ${attempt}/${max - 1} in ${Math.round(wait)} ms`);
      await sleep(wait);
    }
  }
}

const isRead = sql => /^\s*(select|with\s[\s\S]*?\bselect|show|explain)\b/i.test(sql) && !/\b(insert|update|delete)\b/i.test(sql);

// ---------------------------------------------------------------- embedded (local / tests)
async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.DB_DIR || './data/pglite';
  if (!dir.startsWith('memory:')) await mkdir(dirname(dir), { recursive: true });
  // PGlite is single-process: refuse to open a directory another live process is using (would corrupt it).
  if (!dir.startsWith('memory:')) acquireLock(dir + '.lock');
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: `pglite:${dir}`,
    isPg: false,
    query: (sql, p) => db.query(sql, p),
    exec: sql => db.exec(sql),
    tx: fn => db.transaction(t => fn({ query: (sql, p) => t.query(sql, p) })),
    health: async () => { await db.query('SELECT 1'); return { ok: true }; },
    stats: () => ({ total: 1, idle: 1, waiting: 0 }),
    close: async () => { await db.close(); releaseLock(); },
  };
}

let lockFile;
function acquireLock(file) {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = pid !== process.pid; } catch { /* stale lock */ }
    if (alive) {
      throw new Error(`Embedded DB is in use by process ${pid} (${file}). Stop it first, or set PGHOST to use a shared Postgres.`);
    }
  }
  writeFileSync(file, String(process.pid));
  lockFile = file;
  process.on('exit', releaseLock);
}
function releaseLock() {
  try { if (lockFile) unlinkSync(lockFile); } catch { /* ignore */ }
  lockFile = undefined;
}

// ---------------------------------------------------------------- postgres (pooled)
function sslConfig() {
  const mode = (process.env.PGSSLMODE || 'require').toLowerCase();
  if (mode === 'disable') return false;
  const ca = process.env.PGSSL_CA_FILE ? readFileSync(process.env.PGSSL_CA_FILE, 'utf8') : undefined;
  // verify-full: verify the server certificate (needs PGSSL_CA_FILE for a private CA). require (default): encrypted, certificate not verified.
  if (mode === 'verify-full' || mode === 'verify-ca') return { ca, rejectUnauthorized: true };
  return { ca, rejectUnauthorized: false, checkServerIdentity: () => undefined };
}

async function initPg() {
  const { default: pg } = await import('pg');
  const schema = process.env.PGSCHEMA || undefined;
  const opts = [
    schema && `-c search_path=${schema}`,
    `-c statement_timeout=${num(process.env.PG_STATEMENT_TIMEOUT_MS, 30000)}`,
    `-c idle_in_transaction_session_timeout=${num(process.env.PG_IDLE_TX_TIMEOUT_MS, 60000)}`,
    `-c lock_timeout=${num(process.env.PG_LOCK_TIMEOUT_MS, 10000)}`,
  ].filter(Boolean).join(' ');

  const pool = new pg.Pool({
    host: process.env.PGHOST,
    port: num(process.env.PGPORT, 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: sslConfig(),
    application_name: process.env.PG_APPLICATION_NAME || process.env.npm_package_name || 'trinium-service',
    options: opts,
    max: num(process.env.PG_POOL_MAX, 10),
    min: num(process.env.PG_POOL_MIN, 1),
    idleTimeoutMillis: num(process.env.PG_IDLE_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: num(process.env.PG_CONNECT_TIMEOUT_MS, 10000),
    maxLifetimeSeconds: num(process.env.PG_MAX_LIFETIME_S, 1800), // recycle connections so failovers / LB changes are picked up
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    allowExitOnIdle: false,
  });
  // An idle client can be killed by the server or a firewall; without a listener this event would crash the process.
  pool.on('error', e => console.error(`[DB] idle client error (${e.code || e.message}); the pool will replace it`));

  const query = (sql, p) => retrying('query', () => pool.query(sql, p), { idempotent: isRead(sql) });

  return {
    kind: `postgres:${process.env.PGHOST}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE}${schema ? ` schema=${schema}` : ''} pool<=${pool.options.max}`,
    isPg: true,
    query,
    exec: sql => retrying('exec', () => pool.query(sql), { idempotent: false }),
    /** Runs fn in one transaction. The WHOLE transaction is retried on serialization/deadlock/failover errors, so fn must be re-runnable. */
    tx: (fn, { isolation } = {}) => retrying('tx', async () => {
      const c = await pool.connect();
      let broken = false;
      // The pool only listens on IDLE clients: a connection killed while checked out would emit an unhandled 'error' and crash the process.
      const onErr = e => { broken = true; console.warn(`[DB] connection error during transaction (${e.code || e.message})`); };
      c.on('error', onErr);
      try {
        await c.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
        const r = await fn({ query: (sql, p) => c.query(sql, p) });
        await c.query('COMMIT');
        return r;
      } catch (e) {
        if (classify(e) === 'ambiguous') broken = true; // do not hand a dead connection back to the pool
        await c.query('ROLLBACK').catch(() => { broken = true; });
        throw e;
      } finally {
        c.off('error', onErr);
        c.release(broken ? true : undefined);
      }
    }, { idempotent: true }),
    health: async () => {
      const t0 = Date.now();
      try {
        await Promise.race([pool.query('SELECT 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('health query timed out')), 2000))]);
        return { ok: true, ms: Date.now() - t0 };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    close: () => pool.end(),
  };
}

export const db = () => impl;
