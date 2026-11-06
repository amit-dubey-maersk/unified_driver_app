import { readdir, readFile, writeFile, rename, mkdir, stat, access } from 'fs/promises';
import { join, basename } from 'path';
import { processFile } from './processor.js';
import { flushOutbox, kafkaEnabled } from '../kafka/publisher.js';
import { EdiParseError } from '../edi/parser.js';
import { metrics } from '../metrics.js';

// Folder source. When the real SFTP subscription arrives, only `listFiles/readFile/finish` change
// (download -> same processFile()); the pipeline below stays as is.

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

/** One pass over the input folder. Returns a summary of what happened. */
export async function scanOnce({ geo, topic, log = console, stableMs = Number(process.env.EDI_STABLE_MS ?? 1000) }) {
  const f = folders();
  await ensureFolders(f);
  const summary = [];
  const names = (await readdir(f.input)).filter(n => !n.startsWith('.')).sort();

  for (const name of names) {
    const src = join(f.input, name);
    const st = await stat(src);
    if (!st.isFile() || Date.now() - st.mtimeMs < stableMs) continue; // skip dirs and files still being written

    try {
      const raw = (await readFile(src)).toString('latin1');
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
      await rename(src, await uniquePath(f.archive, name));

      for (const r of results) metrics.outcomes.inc({ outcome: r.outcome });
      metrics.files.inc({ result: 'ok' });
      log.log(`[204] ${name} -> ${results.map(r => `${r.dispatchSeq}:${r.outcome}`).join(', ')}`);
      summary.push({ file: name, results });
    } catch (err) {
      if (err instanceof EdiParseError) {
        // Bad file: park it with the reason, keep going.
        const dst = await uniquePath(f.error, name);
        await rename(src, dst);
        await writeFile(`${dst}.error.txt`, `${new Date().toISOString()}\n${err.message}\n`);
        metrics.files.inc({ result: 'rejected' });
        log.error(`[204] ${name} rejected: ${err.message}`);
        summary.push({ file: name, error: err.message });
      } else {
        // Infrastructure failure (DB etc): leave the file in place, it is retried on the next pass.
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
