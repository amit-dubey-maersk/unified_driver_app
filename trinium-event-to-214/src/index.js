import 'dotenv/config';
import express from 'express';
import { initDb, db } from './db/index.js';
import { loadConfig, flushFiles } from './processor.js';
import { scanEventFolder, eventFolders } from './sources.js';
import { startConsumer, stopConsumer, consumerEnabled } from './kafka/consumer.js';
import { client, registerDbMetrics } from './metrics.js';
import { loadRefData } from './refdata.js';

const once = process.argv.includes('--once');
const port = process.env.PORT || 8081;
const metricsPort = process.env.METRICS_PORT || 44421;
const pollMs = Number(process.env.POLL_INTERVAL_MS || 5000);
const cfg = loadConfig();

await initDb();
// This service reads the order service's tables; fail early and clearly if they are not there.
const have = await db().query(`SELECT to_regclass('trinium_legs') AS legs`);
if (!have.rows[0].legs) {
  console.error('[DB] trinium_legs not found. The order service (trinium-order-transformer) must use the same database.');
  process.exit(1);
}
const ref = await loadRefData(db()); // state time zones + event->AT7 map from the database (seeded on first start)
console.log(`[REF] ${ref.states} state time zones, ${ref.eventCodes} event code mappings`);
setInterval(() => loadRefData(db()).catch(e => console.error('[REF] refresh failed, keeping previous values:', e.message)), Number(process.env.REF_REFRESH_MS || 300000)).unref();
registerDbMetrics(db);
console.log(`[CFG] events folder=${eventFolders().input} out=${cfg.outDir} sender=${cfg.sender} receiver=${cfg.receiver} kafka=${consumerEnabled() ? 'ENABLED' : 'disabled'}`);

await flushFiles(cfg.outDir); // finish any file left unwritten by a crash

if (once) {
  const r = await scanEventFolder({ cfg });
  console.log(`[EVT] pass complete: ${r.length} event(s)`);
  await db().close();
  process.exit(0);
}

if (consumerEnabled()) await startConsumer();

let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try { await scanEventFolder({ cfg }); } catch (e) { console.error('[EVT] pass error', e); } finally { busy = false; }
};
setInterval(tick, pollMs);
tick();

const app = express();
app.get('/v1/sent/:dispatchSeq', async (req, res) => {
  res.json((await db().query('SELECT id, at7_code, event_time_local, route_seq, isa_control, file_name, status, created_at FROM edi214_sent WHERE dispatch_seq=$1 ORDER BY id', [req.params.dispatchSeq])).rows);
});
app.get('/v1/events', async (req, res) => {
  res.json((await db().query('SELECT event_id, dispatch_seq, event_type, event_status, outcome, detail, received_at FROM inbound_events ORDER BY received_at DESC LIMIT $1', [Math.min(Number(req.query.limit) || 50, 500)])).rows);
});
app.listen(port, () => console.log(`API listening on ${port}`));

const metricsApp = express();
metricsApp.get('/health', (_req, res) => res.status(200).send('OK'));          // liveness: process is up (a DB blip must not restart the pod)
metricsApp.get('/ready', async (_req, res) => {                                  // readiness: database reachable
  const h = await db().health();
  res.status(h.ok ? 200 : 503).json({ db: h, pool: db().stats() });
});
metricsApp.get('/prometheus', async (_req, res) => { res.set('Content-Type', client.register.contentType); res.end(await client.register.metrics()); });
metricsApp.listen(metricsPort, () => console.log(`Metrics and health listening on ${metricsPort}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await stopConsumer(); await db().close().catch(() => {}); process.exit(0); });
}
