import 'dotenv/config';
import { initDb, db } from '../db/index.js';
import { GeoStore } from '../geo.js';
import { saveGeoRows } from '../geoDb.js';

// npm run load-geo -- [path/to/Geo.csv] [--force]
// Upserts the file into ref_geo_location in one transaction and removes rows that are no longer in it.
// Aborts (nothing changed) if it would remove more than GEO_MAX_REMOVE_PCT of the table, unless --force.
const args = process.argv.slice(2);
const force = args.includes('--force');
const path = args.find(a => !a.startsWith('--')) || process.env.GEO_CSV_PATH || './data/Geo.csv';
try {
  await initDb();
  const rows = GeoStore.readCsvRows(path);
  console.log(`[GEO] ${path}: ${rows.length} rows read`);
  const r = await saveGeoRows(db(), rows, { source: path, force });
  console.log(`[GEO] loaded ${r.rows} rows, removed ${r.removed} (load ${r.loadId})`);
  await db().close();
} catch (e) {
  console.error(`[GEO] FAILED: ${e.message}`);
  process.exit(1);
}
