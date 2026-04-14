import path from 'node:path';

/** Reject null bytes and Windows device names; normalize to forward slashes for comparison. */
export function normalizeUploadRelativePath(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.includes('\0')) return null;
  const s = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!s || s.startsWith('..') || s.includes('/../') || /(^|\/)..\//.test(s)) return null;
  const segments = s.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '') return null;
  }
  return s;
}

export function isSafeResolvedPath(resolvedFile: string, rootDir: string): boolean {
  const r = path.resolve(resolvedFile);
  const base = path.resolve(rootDir);
  return r === base || r.startsWith(base + path.sep);
}
