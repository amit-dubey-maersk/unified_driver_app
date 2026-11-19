import { appendFile, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from './db/index.js';

// Processing trace: for every file/event one record of  what came IN, what went OUT, and what looks wrong (issues).
// Same file in both services. Destinations (all best-effort: a logging failure never breaks processing):
//   console  one line per record (TRACE_CONSOLE=false to silence)
//   JSONL    LOG_DIR/trace-YYYYMMDD.jsonl, one JSON object per line incl. the FULL incoming + outgoing bodies when TRACE_FULL=true
//   DB       table processing_trace (shared by both services) with the summaries + issues, query it with:
//              SELECT * FROM processing_trace WHERE ref = '<dispatch seq>' ORDER BY id;
//              SELECT * FROM processing_trace WHERE jsonb_array_length(issues) > 0 ORDER BY id DESC;
// Env: LOG_DIR (default ./logs, empty = no file), TRACE_FULL (default true), TRACE_DB (default true), TRACE_CONSOLE (default true).

const on = (v, d = true) => (v === undefined || v === '' ? d : v !== 'false');
const SERVICE = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name; } catch { return process.env.npm_package_name || 'trinium-service'; }
})();

/** issues: [{ level: 'error'|'warn'|'info', code, message }] */
export async function trace({ kind, ref, source, outcome, incoming, outgoing, issues = [], full }) {
  const rec = { ts: new Date().toISOString(), service: SERVICE, kind, ref: ref ?? null, source: source ?? null, outcome: outcome ?? null, issues, incoming, outgoing };

  if (on(process.env.TRACE_CONSOLE)) {
    const worst = issues.some(i => i.level === 'error') ? 'ERROR' : issues.some(i => i.level === 'warn') ? 'WARN' : 'ok';
    console.log(`[TRACE] ${kind} ref=${ref ?? '-'} ${source ?? ''} -> ${outcome ?? ''} issues=${issues.length}(${worst})${issues.length ? ' | ' + issues.map(i => `${i.level}:${i.code}`).join(', ') : ''}`);
    for (const i of issues) console[i.level === 'error' ? 'error' : 'warn'](`[TRACE]   ${i.level.toUpperCase()} ${i.code}: ${i.message}`);
  }

  const dir = process.env.LOG_DIR ?? './logs';
  if (dir) {
    try {
      await mkdir(dir, { recursive: true });
      const line = on(process.env.TRACE_FULL) ? { ...rec, full } : rec;
      await appendFile(join(dir, `trace-${rec.ts.slice(0, 10).replace(/-/g, '')}.jsonl`), JSON.stringify(line) + '\n');
    } catch (e) { console.warn(`[TRACE] file log failed: ${e.message}`); }
  }

  if (on(process.env.TRACE_DB)) {
    try {
      await db().query(
        `INSERT INTO processing_trace (service, kind, ref, source, outcome, issues, incoming, outgoing) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
        [SERVICE, kind, rec.ref, rec.source, rec.outcome, JSON.stringify(issues), JSON.stringify(incoming ?? null), JSON.stringify(outgoing ?? null)]);
    } catch (e) { console.warn(`[TRACE] db log failed: ${e.message}`); }
  }
  return rec;
}
export const issue = (level, code, message) => ({ level, code, message });
