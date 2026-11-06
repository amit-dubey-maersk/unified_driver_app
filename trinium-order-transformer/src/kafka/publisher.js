import { readFileSync } from 'fs';
import { db } from '../db/index.js';
import { metrics } from '../metrics.js';

let producer;

async function getProducer() {
  if (producer) return producer;
  const { Kafka, logLevel } = await import('kafkajs');
  const e = process.env;
  const ssl = e.KAFKA_SSL === 'false' ? false : {
    // Convert the JKS/p12 truststore to PEM once:  openssl pkcs12 -in truststore.p12 -nokey -out ca.pem
    ...(e.KAFKA_CA_FILE ? { ca: [readFileSync(e.KAFKA_CA_FILE)] } : {}),
    ...(e.KAFKA_TRUSTSTORE_P12 ? { pfx: readFileSync(e.KAFKA_TRUSTSTORE_P12), passphrase: e.KAFKA_TRUSTSTORE_PASSWORD } : {}),
    rejectUnauthorized: e.KAFKA_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
  const kafka = new Kafka({
    clientId: e.KAFKA_CLIENT_ID || 'trinium-order-transformer',
    brokers: (e.KAFKA_BROKERS || '').split(',').map(s => s.trim()).filter(Boolean),
    ssl,
    sasl: e.KAFKA_USERNAME
      ? { mechanism: (e.KAFKA_SASL_MECHANISM || 'scram-sha-512').toLowerCase(), username: e.KAFKA_USERNAME, password: e.KAFKA_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    requestTimeout: 30000,
    retry: { retries: 3 },
    logLevel: logLevel.WARN,
  });
  const p = kafka.producer({ idempotent: false, allowAutoTopicCreation: false });
  await p.connect();
  producer = p;
  console.log('[KAFKA] producer connected');
  return p;
}

export const kafkaEnabled = () => process.env.KAFKA_ENABLED === 'true';

/**
 * Publish PENDING/FAILED outbox rows in id order. Per-key ordering is preserved: once a message for a
 * dispatch sequence fails, later messages for that key wait for the next pass.
 */
let running = false;
export async function flushOutbox(limit = 200) {
  if (!kafkaEnabled() || running) return { sent: 0, failed: 0 };
  running = true;
  let sent = 0, failed = 0;
  try {
    const { rows } = await db().query(
      `SELECT id, topic, msg_key, payload FROM outbound_messages WHERE status <> 'SENT' ORDER BY id LIMIT $1`, [limit]);
    const blocked = new Set();
    for (const m of rows) {
      if (blocked.has(m.msg_key)) continue;
      try {
        const p = await getProducer();
        const [meta] = await p.send({
          topic: m.topic,
          messages: [{ key: m.msg_key, value: JSON.stringify(m.payload), headers: { source: 'trinium-order-transformer' } }],
        });
        await db().query(
          `UPDATE outbound_messages SET status='SENT', attempts=attempts+1, sent_at=NOW(), last_error=NULL,
             kafka_partition=$2, kafka_offset=$3 WHERE id=$1`, [m.id, meta.partition, String(meta.baseOffset)]);
        metrics.kafka.inc({ result: 'sent' });
        sent++;
      } catch (err) {
        blocked.add(m.msg_key);
        await db().query(
          `UPDATE outbound_messages SET status='FAILED', attempts=attempts+1, last_error=$2 WHERE id=$1`,
          [m.id, String(err.message).slice(0, 500)]);
        metrics.kafka.inc({ result: 'failed' });
        console.error(`[KAFKA] publish failed for ${m.msg_key}: ${err.message}`);
        failed++;
        if (/connect|ECONN|ENOTFOUND|sasl|authentication/i.test(err.message)) { producer = undefined; break; }
      }
    }
  } finally {
    running = false;
  }
  return { sent, failed };
}

export async function closeKafka() {
  await producer?.disconnect().catch(() => {});
  producer = undefined;
}
