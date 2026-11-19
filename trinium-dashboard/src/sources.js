import { readdir, readFile, stat, open } from 'fs/promises';
import { join } from 'path';
import { withSftp, sftpDirs } from './sftp.js';

const exists = p => stat(p).then(() => true, () => false);

/** Newest trace records (JSONL written by both services). `full` bodies are dropped unless asked for. */
export async function readLogs({ dirs, limit = 200, kind = '', level = '', ref = '', full = false, maxBytes = 3_000_000 }) {
  const out = [];
  for (const dir of dirs) {
    if (!(await exists(dir))) continue;
    const files = (await readdir(dir)).filter(f => /^trace-\d{8}\.jsonl$/.test(f)).sort().reverse().slice(0, 3);
    for (const f of files) {
      const fh = await open(join(dir, f), 'r');
      try {
        const { size } = await fh.stat();
        const len = Math.min(size, maxBytes);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (size > len) lines.shift(); // first line is cut
        for (const l of lines) {
          if (!l.trim()) continue;
          try { out.push({ ...JSON.parse(l), _file: f }); } catch { /* partial line */ }
        }
      } finally { await fh.close(); }
    }
  }
  return out
    .filter(r => (!kind || r.kind === kind) && (!ref || String(r.ref) === ref) && (!level || (r.issues || []).some(i => i.level === level)))
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, limit)
    .map(r => (full ? r : { ...r, full: undefined }));
}

async function count(dir) { try { return (await readdir(dir)).filter(n => !n.startsWith('.') && !n.endsWith('.error.txt')).length; } catch { return null; } }

/** Local working folders of both services + recent rejection reasons. */
export async function fileStats({ ediDir, eventsDir, edi214Dir }) {
  const folders = {
    '204 input': join(ediDir, 'input'), '204 processed (json)': join(ediDir, 'processed'), '204 archive': join(ediDir, 'archive'), '204 error': join(ediDir, 'error'),
    'events input': join(eventsDir, 'input'), 'events processed': join(eventsDir, 'processed'), 'events error': join(eventsDir, 'error'), 'events received (kafka dump)': join(eventsDir, 'received'),
    '214 outbound': edi214Dir,
  };
  const counts = {};
  for (const [k, d] of Object.entries(folders)) counts[k] = await count(d);
  const rejected = [];
  for (const [label, d] of [['204', join(ediDir, 'error')], ['event', join(eventsDir, 'error')]]) {
    try {
      for (const f of (await readdir(d)).filter(n => n.endsWith('.error.txt'))) {
        const reason = (await readFile(join(d, f), 'utf8')).trim().split('\n');
        rejected.push({ kind: label, file: f.replace(/\.error\.txt$/, ''), at: reason[0], reason: reason.slice(1).join(' ') });
      }
    } catch { /* folder missing */ }
  }
  return { counts, rejected: rejected.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30) };
}

let cache = { at: 0, data: null };
/** Live, read-only listing of the Trinium SFTP folders (cached 30 s). */
export async function sftpLive({ client, ttlMs = 30000 } = {}) {
  if (cache.data && Date.now() - cache.at < ttlMs && !client) return cache.data;
  const d = sftpDirs();
  const folders = [d.in204, d.archive204, d.out214, '214archive'];
  try {
    const data = await withSftp(async c => {
      const res = {};
      for (const f of folders) {
        const items = (await c.list(f)).filter(i => i.type === '-').sort((a, b) => b.modifyTime - a.modifyTime);
        res[f] = { count: items.length, files: items.slice(0, 25).map(i => ({ name: i.name, size: i.size, modified: new Date(i.modifyTime).toISOString() })) };
      }
      return { ok: true, host: process.env.SFTP_HOST, checkedAt: new Date().toISOString(), folders: res, roles: { [d.in204]: 'Trinium 204 (we read)', [d.archive204]: '204 processed by us', [d.out214]: '214 we deliver', '214archive': '214 read by Trinium' } };
    }, { client });
    if (!client) cache = { at: Date.now(), data };
    return data;
  } catch (e) { return { ok: false, error: e.message, checkedAt: new Date().toISOString() }; }
}
