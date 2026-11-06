import 'dotenv/config';
import express from 'express';
import { initDb, db } from './db/index.js';
import { GeoCache } from './geoDb.js';
import { loadRefData } from './refdata.js';
import { scanOnce, folders, ensureFolders } from './pipeline/watcher.js';
import { flushOutbox, closeKafka, kafkaEnabled } from './kafka/publisher.js';
import { client, registerDbMetrics } from './metrics.js';

const once = process.argv.includes('--once');
const port = process.env.PORT || 8080;
const metricsPort = process.env.METRICS_PORT || 44420;
const pollMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const topic = process.env.KAFKA_TOPIC || 'trinium.mobile.orders';

await initDb();
await loadRefData(db());
// Geo-fences come from ref_geo_location (seeded from GEO_CSV_PATH if the table is empty); in memory, refreshed when the table changes.
const geo = await GeoCache.create(db(), { csvPath: process.env.GEO_CSV_PATH || './data/Geo.csv' });
console.log(`[GEO] ${geo.size} locations loaded from database`);
if (!geo.size) console.warn('[GEO] ref_geo_location is empty: every stop will be reported as unmatched. Run `npm run load-geo`.');
setInterval(() => loadRefData(db()).catch(e => console.error('[REF] refresh failed, keeping previous values:', e.message)), Number(process.env.REF_REFRESH_MS || 300000)).unref();
registerDbMetrics(db);
await ensureFolders(folders());
console.log(`[CFG] input=${folders().input} topic=${topic} kafka=${kafkaEnabled() ? 'ENABLED' : 'disabled (messages stay PENDING in outbound_messages)'}`);

if (once) {
  const r = await scanOnce({ geo, topic });
  console.log(`[204] pass complete: ${r.length} file(s)`);
  await closeKafka();
  await db().close();
  process.exit(0);
}

// --- poll loop (never overlaps) ---
let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try { await scanOnce({ geo, topic }); } catch (e) { console.error('[204] pass error', e); } finally { busy = false; }
};
setInterval(tick, pollMs);
tick();

// --- API (inspection / manual replay) ---
const app = express();
app.get('/v1/legs', async (req, res) => {
  const { rows } = await db().query(
    `SELECT dispatch_seq, trinium_order_no, bol, container_number, leg_type, status, last_txn_type, publish_count, updated_at
       FROM trinium_legs ORDER BY updated_at DESC LIMIT $1`, [Math.min(Number(req.query.limit) || 50, 500)]);
  res.json(rows);
});
app.get('/v1/legs/:dispatchSeq', async (req, res) => {
  const d = req.params.dispatchSeq;
  const leg = (await db().query('SELECT * FROM trinium_legs WHERE dispatch_seq=$1', [d])).rows[0];
  if (!leg) return res.status(404).json({ error: 'not found' });
  const [stops, history, outbound] = await Promise.all([
    db().query('SELECT * FROM trinium_leg_stops WHERE dispatch_seq=$1 ORDER BY seq', [d]),
    db().query('SELECT * FROM order_messages WHERE dispatch_seq=$1 ORDER BY id', [d]),
    db().query('SELECT id,topic,status,attempts,last_error,kafka_partition,kafka_offset,created_at,sent_at FROM outbound_messages WHERE dispatch_seq=$1 ORDER BY id', [d]),
  ]);
  res.json({ leg, stops: stops.rows, history: history.rows, outbound: outbound.rows });
});
app.get('/v1/unmatched-locations', async (_req, res) => res.json((await db().query('SELECT * FROM unmatched_locations ORDER BY seen_count DESC')).rows));
app.post('/v1/outbound/flush', async (_req, res) => res.json(await flushOutbox()));
app.listen(port, () => console.log(`API listening on ${port}`));

// --- health + metrics (internal, same layout as the reference service) ---
const metricsApp = express();
metricsApp.get('/health', (_req, res) => res.status(200).send('OK'));          // liveness: process is up (a DB blip must not restart the pod)
metricsApp.get('/ready', async (_req, res) => {                                  // readiness: database reachable
  const h = await db().health();
  res.status(h.ok ? 200 : 503).json({ db: h, pool: db().stats(), geo: geo.size });
});
metricsApp.get('/prometheus', async (_req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
metricsApp.listen(metricsPort, () => console.log(`Metrics and health listening on ${metricsPort}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { geo.stop(); await closeKafka(); await db().close().catch(() => {}); process.exit(0); });
}
