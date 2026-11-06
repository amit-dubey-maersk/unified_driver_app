import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(here, 'schema', 'update-event.schema.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const check = ajv.compile(schema);

/** Validate an incoming event against the agreed driver-app update/event schema. */
export function validateEvent(obj) {
  if (check(obj)) return { ok: true };
  const errors = check.errors.map(e => `${e.instancePath || '/'} ${e.message}`).slice(0, 8);
  return { ok: false, errors };
}
