import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import SftpClient from 'ssh2-sftp-client';

// Trinium SFTP connection (public-key auth). Same file in both services.
//   SFTP_HOST, SFTP_PORT, SFTP_USERNAME
//   SFTP_PRIVATE_KEY_FILE (path) or SFTP_PRIVATE_KEY (PEM text, for container secrets), SFTP_PASSPHRASE (optional)
//   SFTP_HOST_KEY_SHA256  optional, comma separated "SHA256:..." fingerprints; when set, any other server key is refused

export function sftpConfig(e = process.env) {
  if (!e.SFTP_HOST || !e.SFTP_USERNAME) throw new Error('SFTP_HOST and SFTP_USERNAME are required when PROCESSING_MODE=kafka');
  const privateKey = e.SFTP_PRIVATE_KEY || (e.SFTP_PRIVATE_KEY_FILE ? readFileSync(e.SFTP_PRIVATE_KEY_FILE) : null);
  if (!privateKey) throw new Error('SFTP_PRIVATE_KEY_FILE (or SFTP_PRIVATE_KEY) is required when PROCESSING_MODE=kafka');
  const cfg = {
    host: e.SFTP_HOST,
    port: Number(e.SFTP_PORT || 22),
    username: e.SFTP_USERNAME,
    privateKey,
    passphrase: e.SFTP_PASSPHRASE || undefined,
    readyTimeout: Number(e.SFTP_TIMEOUT_MS || 20000),
    retries: 1,
  };
  const pins = (e.SFTP_HOST_KEY_SHA256 || '').split(',').map(s => s.trim().replace(/^SHA256:/, '')).filter(Boolean);
  if (pins.length) {
    const hexPins = pins.map(p => Buffer.from(p, 'base64').toString('hex'));
    cfg.hostHash = 'sha256';
    cfg.hostVerifier = hash => hexPins.includes(String(hash).toLowerCase());
  }
  return cfg;
}

export const sftpDirs = (e = process.env) => ({
  in204: e.SFTP_204_IN_DIR || '204out',          // where Trinium publishes 204 load tenders (we read)
  archive204: e.SFTP_204_ARCHIVE_DIR || '204archive', // where we move a 204 once processed
  out214: e.SFTP_214_OUT_DIR || '214in',         // where we deliver 214 status files
});

/** Open a session, run fn(client), always close. `client` can be injected (tests). */
export async function withSftp(fn, { client } = {}) {
  const c = client || new SftpClient();
  if (!client) await c.connect(sftpConfig());
  try { return await fn(c); } finally { if (!client) await c.end().catch(() => {}); }
}

export const sha256 = b => createHash('sha256').update(b).digest('hex');
