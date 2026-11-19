import 'dotenv/config';
import express from 'express';
import { makePool } from './db.js';
import * as Q from './queries.js';
import { readLogs, fileStats, sftpLive } from './sources.js';

const e = process.env;
const { q, warm } = makePool();
warm(); // open the minimum connections now so the first page load does not pay the TLS handshake
const hoursOf = r => Math.min(Math.max(parseInt(r.query.hours, 10) || 24, 1), 720);
const dirs = () => [e.ORDER_LOG_DIR || '../trinium-order-transformer/logs', e.EVENT_LOG_DIR || '../trinium-event-to-214/logs'];

const app = express();
// Short cache + de-duplication of identical in-flight requests: several tabs / the 10 s auto-refresh cost one query set per TTL, not one each.
const TTL = Number(e.CACHE_TTL_MS ?? 5000), cache = new Map();
const cached = (key, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = fn(); cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  if (cache.size > 200) for (const [k, v] of cache) if (Date.now() - v.at >= TTL) cache.delete(k);
  return p;
};
const wrap = fn => async (req, res) => { try { res.json(await cached(req.originalUrl, () => fn(req))); } catch (err) { console.error(`[API] ${req.path}: ${err.message}`); res.status(500).json({ error: err.message }); } };

app.get('/api/summary', wrap(r => Q.summary(q, hoursOf(r))));
app.get('/api/orders', wrap(r => Q.orders(q, { limit: r.query.limit, search: r.query.search, hours: r.query.hours ? hoursOf(r) : null })));
app.get('/api/orders/:id', wrap(async r => (await Q.orderDetail(q, r.params.id)) || { error: 'not found' }));
app.get('/api/events', wrap(r => Q.events(q, { limit: r.query.limit, outcome: r.query.outcome || '', search: r.query.search, hours: r.query.hours ? hoursOf(r) : null })));
app.get('/api/issues', wrap(r => Q.issues(q, { limit: r.query.limit, level: r.query.level || '', hours: hoursOf(r) })));
app.get('/api/trace/:id', wrap(async r => (await Q.traceById(q, r.params.id)) || { error: 'not found' }));
app.get('/api/logs', wrap(r => readLogs({ dirs: dirs(), limit: Math.min(Number(r.query.limit) || 200, 1000), kind: r.query.kind || '', level: r.query.level || '', ref: r.query.ref || '', full: r.query.full === '1' })));
app.get('/api/files', wrap(() => fileStats({ ediDir: e.ORDER_EDI_DIR || '../trinium-order-transformer/edi', eventsDir: e.EVENTS_DIR || '../trinium-event-to-214/events', edi214Dir: e.EDI214_DIR || '../trinium-event-to-214/edi214/outbound' })));
app.get('/api/sftp', wrap(() => (e.DASH_SFTP === 'true' ? sftpLive() : { ok: false, disabled: true, error: 'SFTP view is off (DASH_SFTP=false)' })));
app.get('/api/health', wrap(async () => ({ ok: true, db: (await q('SELECT current_database() db, current_schema() schema'))[0] })));
app.use(express.static(new URL('../public', import.meta.url).pathname));

const port = Number(e.PORT || 8090), host = e.HOST || '127.0.0.1'; // loopback by default: the page shows order data and has no login
app.listen(port, host, () => console.log(`[DASH] http://${host}:${port}  db=${e.PGUSER}@${e.PGHOST}:${e.PGPORT}/${e.PGDATABASE} sftp=${e.DASH_SFTP === 'true' ? 'live' : 'off'}`));
