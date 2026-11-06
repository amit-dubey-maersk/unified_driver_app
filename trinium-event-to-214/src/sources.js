import { readdir, readFile, rename, mkdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { handleEvent, flushFiles, toEvents } from './processor.js';

export function eventFolders(base = process.env.EVENTS_BASE_DIR || './events') {
  return { input: join(base, 'input'), processed: join(base, 'processed'), error: join(base, 'error') };
}

/** Process order: per order by occurredAt then clientSequence, so offline bursts go out in event-time order. */
export const eventOrder = (a, b) =>
  String(a.order?.orderNumber).localeCompare(String(b.order?.orderNumber)) ||
  String(a.occurredAt).localeCompare(String(b.occurredAt)) ||
  (a.clientSequence ?? 0) - (b.clientSequence ?? 0);

/**
 * Dev/test source: *.json files (one event or an array) dropped in events/input - same payloads as the Kafka topic.
 * The Kafka consumer (kafka.js) goes through the same handleEvent().
 */
export async function scanEventFolder({ cfg, log = console, stableMs = Number(process.env.EDI_STABLE_MS ?? 1000) }) {
  const f = eventFolders();
  for (const d of Object.values(f)) await mkdir(d, { recursive: true });
  const names = (await readdir(f.input)).filter(n => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    const src = join(f.input, name);
    const st = await stat(src);
    if (Date.now() - st.mtimeMs < stableMs) continue;
    let events;
    try {
      const parsed = JSON.parse(await readFile(src, 'utf8'));
      events = (Array.isArray(parsed) ? parsed : [parsed]).map(x => (x && x.payload && x.description ? x.payload : x)) // accept examples.json shape
        .flatMap(toEvents); // Supplier Order Update messages are normalised here
    } catch (e) {
      await rename(src, join(f.error, name));
      await writeFile(join(f.error, `${name}.error.txt`), `${new Date().toISOString()}\nInvalid JSON: ${e.message}\n`);
      log.error(`[EVT] ${name} rejected: invalid JSON`);
      continue;
    }
    for (const ev of events.sort(eventOrder)) {
      const r = await handleEvent(ev, cfg);
      log.log(`[EVT] ${name} ${ev?.event?.eventStatus || ev?.eventType} ${ev?.order?.orderNumber} -> ${r.outcome}: ${r.detail}`);
      out.push({ file: name, eventId: ev?.eventId, ...r });
    }
    await rename(src, join(f.processed, name));
  }
  await flushFiles(cfg.outDir);
  return out;
}
