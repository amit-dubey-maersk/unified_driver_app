import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { GeoStore, norm } from './geo.js';

// Geo dataset in the database (ref_geo_location). Geo.csv is only the bulk-load / seed format.

const sha1 = s => createHash('sha1').update(s).digest('hex');
export const geoRowKey = r => sha1([r.code, norm(r.name), norm(r.address1), r.zip].join('|'));

const COLS = ['row_key', 'code', 'name', 'name_norm', 'type', 'active', 'address1', 'city', 'state', 'zip', 'polygon', 'queue_polygon', 'fence_broken', 'lat', 'lng', 'radius'];
const BOOL = new Set(['active', 'fence_broken']);

const toDbRow = r => ({
  row_key: geoRowKey(r), code: r.code || null, name: r.name, name_norm: norm(r.name), type: r.type || null, active: !!r.active,
  address1: r.address1 || null, city: r.city || null, state: r.state || null, zip: r.zip || null, polygon: r.polygon || null,
  queue_polygon: r.queuePolygon || null, fence_broken: !!r.fenceBroken, lat: r.lat || null, lng: r.lng || null, radius: r.radius || null,
});
const fromDbRow = r => ({
  code: r.code || '', name: r.name, type: r.type || '', active: r.active, address1: r.address1 || '', city: r.city || '', state: r.state || '',
  zip: r.zip || '', polygon: r.polygon, queuePolygon: r.queue_polygon, fenceBroken: r.fence_broken, lat: r.lat || '', lng: r.lng || '', radius: r.radius || '',
});

/**
 * Load geo rows into ref_geo_location in ONE transaction: idempotent upsert by row_key in chunks, then remove rows that are not in
 * this load. Safety: refuses a load that would remove more than GEO_MAX_REMOVE_PCT (default 30) of the table unless force=true,
 * so a truncated or wrong file cannot wipe the geofences.
 */
export async function saveGeoRows(db, rows, { source = 'csv', force = false } = {}) {
  const byKey = new Map();
  for (const r of rows) if (norm(r.name)) byKey.set(geoRowKey(r), toDbRow(r)); // de-duplicate: ON CONFLICT cannot hit a row twice
  const list = [...byKey.values()];
  if (!list.length) throw new Error('geo load has no usable rows');
  const loadId = `${new Date().toISOString()}#${sha1(list.map(r => r.row_key).join()).slice(0, 8)}`;
  const arr = c => `$${COLS.indexOf(c) + 1}::${BOOL.has(c) ? 'boolean' : 'text'}[]`;
  const upd = COLS.slice(1);
  const upsert = `INSERT INTO ref_geo_location (${COLS.join(',')}, load_id, updated_at)
      SELECT ${COLS.map(c => 't.' + c).join(',')}, $${COLS.length + 1}, NOW() FROM unnest(${COLS.map(arr).join(',')}) AS t(${COLS.join(',')})
      ON CONFLICT (row_key) DO UPDATE SET ${upd.map(c => `${c}=EXCLUDED.${c}`).join(',')}, load_id=EXCLUDED.load_id,
        updated_at = CASE WHEN (${upd.map(c => 'ref_geo_location.' + c).join(',')}) IS DISTINCT FROM (${upd.map(c => 'EXCLUDED.' + c).join(',')})
                          THEN NOW() ELSE ref_geo_location.updated_at END`; // unchanged rows keep updated_at: no needless cache reload
  const CHUNK = Number(process.env.GEO_LOAD_CHUNK || 500);
  return db.tx(async t => {
    for (let i = 0; i < list.length; i += CHUNK) {
      const part = list.slice(i, i + CHUNK);
      await t.query(upsert, [...COLS.map(c => part.map(r => r[c])), loadId]);
    }
    const before = Number((await t.query('SELECT COUNT(*)::int AS n FROM ref_geo_location')).rows[0].n);
    const stale = Number((await t.query('SELECT COUNT(*)::int AS n FROM ref_geo_location WHERE load_id IS DISTINCT FROM $1', [loadId])).rows[0].n);
    const maxPct = Number(process.env.GEO_MAX_REMOVE_PCT || 30);
    if (!force && before && stale * 100 > before * maxPct) {
      throw new Error(`geo load would remove ${stale} of ${before} rows (> ${maxPct}%): aborted, nothing changed (use --force to override)`);
    }
    await t.query('DELETE FROM ref_geo_location WHERE load_id IS DISTINCT FROM $1', [loadId]);
    await t.query('INSERT INTO ref_geo_load (load_id, source, row_count, removed) VALUES ($1,$2,$3,$4)', [loadId, source, list.length, stale]);
    return { loadId, rows: list.length, removed: stale };
  });
}

export async function loadGeoStore(db) {
  const { rows } = await db.query('SELECT * FROM ref_geo_location');
  return new GeoStore(rows.map(fromDbRow));
}

/**
 * What the services use: same find() API as GeoStore, backed by the table. Lookups are in memory (no query per stop); a cheap
 * version probe (row count + newest update) every GEO_REFRESH_MS reloads the set when the table changed. If a refresh fails
 * the previous set stays in use.
 */
export class GeoCache {
  constructor(db) { this.db = db; this.store = new GeoStore([]); this.version = ''; this.timer = undefined; }
  get size() { return this.store.size; }
  find(name, address, zip) { return this.store.find(name, address, zip); }

  static async create(db, { csvPath, refreshMs = Number(process.env.GEO_REFRESH_MS || 300000) } = {}) {
    const c = new GeoCache(db);
    await c.refresh(true);
    if (!c.size && csvPath && existsSync(csvPath)) { // first start on an empty database: seed from the CSV
      const r = await saveGeoRows(db, GeoStore.readCsvRows(csvPath), { source: `seed:${csvPath}` });
      console.log(`[GEO] seeded ref_geo_location from ${csvPath}: ${r.rows} rows`);
      await c.refresh(true);
    }
    if (refreshMs > 0) {
      c.timer = setInterval(() => c.refresh().catch(e => console.error('[GEO] refresh failed, keeping previous set:', e.message)), refreshMs);
      c.timer.unref();
    }
    return c;
  }

  async refresh(force = false) {
    const v = (await this.db.query(`SELECT COUNT(*)::text || '|' || COALESCE(MAX(updated_at)::text, '') AS v FROM ref_geo_location`)).rows[0].v;
    if (!force && v === this.version) return false;
    this.store = await loadGeoStore(this.db);
    this.version = v;
    return true;
  }
  stop() { clearInterval(this.timer); }
}
