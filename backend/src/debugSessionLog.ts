import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEBUG_LOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cursor', 'debug-1623b3.log');

export function appendDebugLine(payload: Record<string, unknown>): void {
  try {
    appendFileSync(
      DEBUG_LOG,
      JSON.stringify({ sessionId: '1623b3', timestamp: Date.now(), ...payload }) + '\n',
    );
  } catch {
    /* ignore */
  }
}

/** Decode JWT payload without verifying signature — log `aud` only (no secrets). */
export function peekJwtAud(token: string): { parts: number; aud: string | null } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { parts: parts.length, aud: null };
  }
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { aud?: string | string[] };
    const aud = payload.aud;
    if (typeof aud === 'string') return { parts: 3, aud };
    if (Array.isArray(aud)) return { parts: 3, aud: aud.join(',') };
    return { parts: 3, aud: null };
  } catch {
    return { parts: 3, aud: null };
  }
}
