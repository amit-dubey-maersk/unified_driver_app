import { readdir, readFile, writeFile, rename, mkdir, stat, access } from 'fs/promises';
import { join, basename } from 'path';
import { processFile } from './processor.js';
import { flushOutbox, kafkaEnabled } from '../kafka/publisher.js';
import { EdiParseError } from '../edi/parser.js';
import { metrics } from '../metrics.js';
import { isKafkaMode } from '../mode.js';
import { withSftp, sftpDirs } from '../sftp.js';

// Two sources feed the same processFile() pipeline:
//   PROCESSING_MODE=local : files dropped in the local input folder (moved to the local archive when done)
//   PROCESSING_MODE=kafka : files polled from the Trinium SFTP 204 folder (moved to the SFTP 204 archive when done);
//                           a copy of the raw file and the processed JSON are always kept in our local folders as well.

export function folders(base = process.env.EDI_BASE_DIR || './edi') {
  return {
    input: process.env.EDI_INPUT_DIR || join(base, 'input'),
    processed: process.env.EDI_PROCESSED_DIR || join(base, 'processed'),
    archive: process.env.EDI_ARCHIVE_DIR || join(base, 'archive'),
    error: process.env.EDI_ERROR_DIR || join(base, 'error'),
  };
}

export async function ensureFolders(f) {
  for (const d of Object.values(f)) await mkdir(d, { recursive: true });
}

const exists = p => access(p).then(() => true, () => false);
async function uniquePath(dir, name) {
  let p = join(dir, name);
  if (!(await exists(p))) return p;
  const i = name.lastIndexOf('.');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  return join(dir, i > 0 ? `${name.slice(0, i)}.${stamp}${name.slice(i)}` : `${name}.${stamp}`);
}

const stamp = () => new Date().toISOString().replace(/[-:.TZ]/g, '');
const joinPosix = (...p) => p.join('/').replace(/\/+/g, '/');

/** Local folder source. */
function localSource(f, stableMs) {
  return {
    label: f.input,
    async list() {
      const out = [];
      for (const name of (await readdir(f.input)).filter(n => !n.startsWith('.')).sort()) {
        const st = await stat(join(f.input, name));
        if (!st.isFile() || Date.now() - st.mtimeMs < stableMs) continue; // skip dirs and files still being written
        out.push({ name });
      }
      return out;
    },
    read: async name => (await readFile(join(f.input, name))).toString('latin1'),
    // done: file leaves the input folder -> local archive
    done: async name => { await rename(join(f.input, name), await uniquePath(f.archive, name)); },
    // rejected: park it locally with the reason
    reject: async (name, reason) => {
      const dst = await uniquePath(f.error, name);
      await rename(join(f.input, name), dst);
      await writeFile(`${dst}.error.txt`, `${new Date().toISOString()}\n${reason}\n`);
    },
  };
}

/** Trinium SFTP source. `c` is a connected ssh2-sftp-client. */
function sftpSource(c, f, stableMs) {
  const d = sftpDirs();
  const arch = async name => {
    let target = joinPosix(d.archive204, name);
    if (await c.exists(target)) { // never overwrite an earlier archived file of the same name
      const i = name.lastIndexOf('.');
      target = joinPosix(d.archive204, i > 0 ? `${name.slice(0, i)}.${stamp()}${name.slice(i)}` : `${name}.${stamp()}`);
    }
    await c.rename(joinPosix(d.in204, name), target);
  };
  return {
    label: `sftp:${d.in204}`,
    async list() {
      const items = await c.list(d.in204);
      return items.filter(x => x.type === '-' && !x.name.startsWith('.') && Date.now() - x.modifyTime >= stableMs)
        .sort((a, b) => a.name.localeCompare(b.name)).map(x => ({ name: x.name }));
    },
    read: async name => (await c.get(joinPosix(d.in204, name))).toString('latin1'),
    // done: keep our own raw copy locally, then move the file to the SFTP archive
    done: async (name, raw) => {
      await writeFile(await uniquePath(f.archive, name), raw, 'latin1');
      await arch(name);
    },
    // rejected: local error copy + reason, and move it out of the 204 folder so it is not retried forever
    reject: async (name, reason, raw) => {
      const dst = await uniquePath(f.error, name);
      await writeFile(dst, raw ?? '', 'latin1');
      await writeFile(`${dst}.error.txt`, `${new Date().toISOString()}\n${reason}\n`);
      await c.rename(joinPosix(d.in204, name), joinPosix(d.archive204, `REJECTED_${stamp()}_${name}`));
    },
  };
}

/** One pass over the input (local folder, or the SFTP 204 folder in kafka mode). Returns a summary of what happened. */
export async function scanOnce({ geo, topic, log = console, stableMs = Number(process.env.EDI_STABLE_MS ?? 1000), sftpClient } = {}) {
  const f = folders();
  await ensureFolders(f);
  if (!isKafkaMode()) return scanSource({ src: localSource(f, stableMs), f, geo, topic, log });
  try {
    return await withSftp(c => scanSource({ src: sftpSource(c, f, stableMs), f, geo, topic, log }), { client: sftpClient });
  } catch (err) {
    // SFTP unreachable / auth failure: nothing was consumed, the next pass retries. Still push what is already queued.
    metrics.files.inc({ result: 'retry' });
    log.error(`[204] SFTP pass failed, will retry: ${err.message}`);
    if (kafkaEnabled()) await flushOutbox();
    return [];
  }
}

async function scanSource({ src, f, geo, topic, log }) {
  const summary = [];
  for (const { name } of await src.list()) {
    let raw;
    try {
      raw = await src.read(name);
      const results = await processFile({ fileName: name, raw, geo, topic });

      const doc = {
        file: name,
        processedAt: new Date().toISOString(),
        topic,
        transactions: results.map(r => ({
          dispatchSequence: r.dispatchSeq,
          outcome: r.outcome,
          queuedForKafka: r.published,
          warnings: r.warnings?.length ? r.warnings : undefined,
          payload: r.payload,
        })),
      };
      const out = await uniquePath(f.processed, `${basename(name, '.txt')}.json`);
      await writeFile(out, JSON.stringify(doc, null, 2));
      await src.done(name, raw);

      for (const r of results) metrics.outcomes.inc({ outcome: r.outcome });
      metrics.files.inc({ result: 'ok' });
      log.log(`[204] ${name} -> ${results.map(r => `${r.dispatchSeq}:${r.outcome}`).join(', ')}`);
      summary.push({ file: name, results });
    } catch (err) {
      if (err instanceof EdiParseError) {
        // Bad file: park it with the reason, keep going.
        await src.reject(name, err.message, raw);
        metrics.files.inc({ result: 'rejected' });
        log.error(`[204] ${name} rejected: ${err.message}`);
        summary.push({ file: name, error: err.message });
      } else {
        // Infrastructure failure (DB, SFTP move...): leave the file in place, it is retried on the next pass
        // (re-processing the same 204 is idempotent: same version -> NOOP).
        metrics.files.inc({ result: 'retry' });
        log.error(`[204] ${name} failed, will retry: ${err.stack || err.message}`);
        summary.push({ file: name, error: err.message, retry: true });
        break;
      }
    }
  }

  if (kafkaEnabled()) await flushOutbox();
  return summary;
}
