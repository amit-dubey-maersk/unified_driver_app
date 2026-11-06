import client from 'prom-client';

client.collectDefaultMetrics();

export const metrics = {
  files: new client.Counter({ name: 'edi204_files_total', help: '204 files handled', labelNames: ['result'] }),
  outcomes: new client.Counter({ name: 'edi204_leg_outcomes_total', help: '204 transactions by outcome', labelNames: ['outcome'] }),
  kafka: new client.Counter({ name: 'edi204_kafka_publish_total', help: 'Kafka publish attempts', labelNames: ['result'] }),
};

/** Connection-pool gauges (total / idle / waiting): waiting > 0 for long means PG_POOL_MAX is too small. */
export function registerDbMetrics(getDb) {
  for (const k of ['total', 'idle', 'waiting']) {
    new client.Gauge({ name: `db_pool_${k}`, help: `DB pool connections: ${k}`, collect() { this.set(getDb().stats()[k]); } });
  }
}

export { client };
