import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { handleEvent, flushFiles, loadConfig, toEvents } from '../processor.js';
import { eventOrder } from '../sources.js';

/**
 * Every message read from the topic is also saved as-is to KAFKA_DUMP_DIR (default ./events/received) so it can be checked against the
 * schema/214 later. Deliberately NOT events/input: that folder is processed again by the folder source. Set KAFKA_DUMP_DIR= (empty) to disable.
 */
function dumpRaw(dir, topic, partition, m) {
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const text = m.value?.toString('utf8') ?? '';
    let id = '';
    let body = text;
    try { const j = JSON.parse(text); id = `_${String(j.uniqueIdentifier || j.eventId || '').slice(0, 36)}`; body = JSON.stringify(j, null, 2); } catch { /* keep raw text */ }
    const name = `${topic.split('.').slice(0, 3).join('.')}_p${partition}_o${String(m.offset).padStart(8, '0')}${id}.json`;
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, body + '\n');
    renameSync(tmp, join(dir, name));
  } catch (err) { console.warn(`[KAFKA] could not save raw message @${m.offset}: ${err.message}`); }
}

export const consumerEnabled = () => process.env.KAFKA_ENABLED === 'true';

let consumer;

/**
 * Subscribes to the driver-app update/event topic. Poison messages (bad JSON / failed schema) are recorded as ERROR in
 * inbound_events and the offset moves on; infrastructure failures (DB) throw so kafkajs retries the batch.
 */
export async function startConsumer({ log = console } = {}) {
  const e = process.env;
  const topic = e.KAFKA_UPDATE_TOPIC;
  if (!topic) throw new Error('KAFKA_UPDATE_TOPIC is not set');
  const { Kafka, logLevel } = await import('kafkajs');
  const ssl = e.KAFKA_SSL === 'false' ? false : {
    ...(e.KAFKA_CA_FILE ? { ca: [readFileSync(e.KAFKA_CA_FILE)] } : {}),
    ...(e.KAFKA_TRUSTSTORE_P12 && (existsSync(e.KAFKA_TRUSTSTORE_P12) || console.warn(`[KAFKA] truststore ${e.KAFKA_TRUSTSTORE_P12} not found: using the system CA store`)) ? { pfx: readFileSync(e.KAFKA_TRUSTSTORE_P12), passphrase: e.KAFKA_TRUSTSTORE_PASSWORD } : {}),
    rejectUnauthorized: e.KAFKA_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
  const kafka = new Kafka({
    clientId: e.KAFKA_CLIENT_ID || 'trinium-event-to-214',
    brokers: (e.KAFKA_BROKERS || '').split(',').map(s => s.trim()).filter(Boolean),
    ssl,
    sasl: e.KAFKA_USERNAME ? { mechanism: (e.KAFKA_SASL_MECHANISM || 'scram-sha-512').toLowerCase(), username: e.KAFKA_USERNAME, password: e.KAFKA_PASSWORD } : undefined,
    connectionTimeout: 10000,
    logLevel: logLevel.WARN,
  });
  consumer = kafka.consumer({ groupId: e.KAFKA_GROUP_ID || 'trinium-event-to-214' });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: e.KAFKA_FROM_BEGINNING === 'true' });
  const cfg = loadConfig();

  await consumer.run({
    eachBatchAutoResolve: true,
    eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning }) => {
      const dumpDir = process.env.KAFKA_DUMP_DIR ?? './events/received';
      for (const m of batch.messages) dumpRaw(dumpDir, batch.topic, batch.partition, m);
      // decode first, then process in event-time order per order
      const decoded = batch.messages.map(m => {
        try { return toEvents(JSON.parse(m.value.toString('utf8'))).map(ev => ({ m, ev })); }
        catch { return [{ m, ev: { eventId: `bad-${batch.topic}-${batch.partition}-${m.offset}`, _invalid: 'message is not valid JSON' } }]; }
      }).flat();
      const ordered = [...decoded].sort((a, b) => eventOrder(a.ev, b.ev));
      for (const { m, ev } of ordered) {
        const r = await handleEvent(ev, cfg);
        log.log(`[EVT] ${batch.topic}[${batch.partition}]@${m.offset} ${ev?.event?.eventStatus || ev?.eventType} ${ev?.order?.orderNumber} -> ${r.outcome}: ${r.detail}`);
        await heartbeat();
      }
      await flushFiles(cfg.outDir);
      for (const m of batch.messages) resolveOffset(m.offset);
    },
  });
  log.log(`[KAFKA] consuming ${topic} as group ${e.KAFKA_GROUP_ID || 'trinium-event-to-214'}`);
}

export async function stopConsumer() { await consumer?.disconnect().catch(() => {}); }
