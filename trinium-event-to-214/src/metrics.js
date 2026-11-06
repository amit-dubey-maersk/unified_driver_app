import client from 'prom-client';

client.collectDefaultMetrics();

export const metrics = {
  events: new client.Counter({ name: 'driver_events_total', help: 'Driver-app events handled', labelNames: ['outcome'] }),
  sent: new client.Counter({ name: 'edi214_generated_total', help: '214 files generated', labelNames: ['code'] }),
};

/** Connection-pool gauges (total / idle / waiting): waiting > 0 for long means PG_POOL_MAX is too small. */
export function registerDbMetrics(getDb) {
  for (const k of ['total', 'idle', 'waiting']) {
    new client.Gauge({ name: `db_pool_${k}`, help: `DB pool connections: ${k}`, collect() { this.set(getDb().stats()[k]); } });
  }
}

export { client };
