import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

// Geo source of truth is the table ref_geo_location (GeoCache below: loaded into memory, refreshed on change). Geo.csv is only the
// seed / bulk-load format (`npm run load-geo`).

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export const norm = s => (s || '').toUpperCase().replace(/\s+/g, ' ').replace(/[\s-]+$/, '').trim();

const FACILITY_TYPES = new Set(['PIER', 'RAIL', 'DEPOT', 'STORAGE', 'YARDVIEW']);

function polygon(jsonList) {
  if (!jsonList) return null;
  let pts;
  try { pts = JSON.parse(jsonList); } catch { return null; }
  if (!Array.isArray(pts) || pts.length < 3) return null;
  const a = pts[0], z = pts[pts.length - 1];
  if (a.lat !== z.lat || a.lng !== z.lng) pts = [...pts, a]; // close the ring
  return pts.map(p => `${p.lat},${p.lng}`).join(';') + ';';
}

const fix12 = v => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v).toFixed(12));

export class GeoStore {
  constructor(rows) {
    this.byName = new Map();
    for (const r of rows) {
      const k = norm(r.name);
      if (!k) continue;
      (this.byName.get(k) || this.byName.set(k, []).get(k)).push(r);
    }
    this.size = rows.length;
    this.rows = rows;
  }

  static fromCsvFile(path) { return new GeoStore(GeoStore.readCsvRows(path)); }

  static readCsvRows(path) {
    // Geo.csv is exported from Windows tooling (cp1252), not UTF-8.
    const text = new TextDecoder('windows-1252').decode(readFileSync(path));
    const [head, ...body] = parseCsv(text);
    const ix = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
    const g = (r, k) => (r[ix[k]] ?? '').trim();
    const rows = body.filter(r => r.length > 5).map(r => ({
      code: g(r, 'Consignor/ee Code'),
      name: g(r, 'Consignor/ee Name'),
      type: g(r, 'Consignor/ee Type'),
      active: /^(yes|true|1)$/i.test(g(r, 'Consignor/ee Is Active')),
      address1: g(r, 'Consignor/ee Street Address 1'),
      city: g(r, 'City Name'),
      state: g(r, 'City State'),
      zip: g(r, 'Consignor/ee Zip'),
      polygon: polygon(g(r, 'Geo Location Consignee/or Coordinates List')),
      queuePolygon: polygon(g(r, 'Geo Location Consignee/or Coordinates List for Queue')),
      // The CSV export cuts cells at 2000 chars -> unparseable JSON. Never emit a partial fence.
      fenceBroken: (['Geo Location Consignee/or Coordinates List', 'Geo Location Consignee/or Coordinates List for Queue']
        .some(k => g(r, k) && !polygon(g(r, k)))),
      lat: g(r, 'Geo Location Consignee/or Latitude'),
      lng: g(r, 'Geo Location Consignee/or Longitude'),
      radius: g(r, 'Geo Location Consignee/or Radius'),
    }));
    return rows;
  }

  /** Find a location by the 204 N1 name (204 carries no location code), using address to break ties. */
  find(name, address, zip) {
    const c = this.byName.get(norm(name));
    if (!c) return null;
    const score = r =>
      (norm(r.address1) === norm(address) ? 4 : 0) + (zip && r.zip === zip ? 2 : 0) +
      (r.active ? 1 : 0) + (r.polygon ? 1 : 0);
    return [...c].sort((a, b) => score(b) - score(a))[0];
  }
}

/** Geo row -> the route-point fields of the mobile payload. */
export function geoFields(row) {
  if (!row) return {};
  const lat = fix12(row.lat), lng = fix12(row.lng);
  const out = {
    siteCode: row.code || undefined,
    siteType: FACILITY_TYPES.has(row.type.toUpperCase()) ? 'OperationalFacility' : 'CustomerFacility',
  };
  if (lat && lng) out.location = `${lat} : ${lng}`;
  if (row.polygon) out.geofence = row.polygon;
  else if (row.radius && Number(row.radius) > 0) out.geofenceRadiusMeters = Number(row.radius);
  if (row.queuePolygon) out.queuedFence = row.queuePolygon;
  return out;
}
