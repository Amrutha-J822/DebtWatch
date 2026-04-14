import path from 'node:path';

/** Only these extensions are extracted and scanned (text-ish sources). */
const ALLOWED = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.java',
  '.cs',
  '.php',
  '.env',
  '.yaml',
  '.yml',
  '.toml',
  '.json',
  '.properties',
  '.xml',
  '.sh',
  '.bash',
  '.md',
  '.ini',
  '.cfg',
  '.cpp',
  '.c',
  '.h',
]);

export function isAllowedScanExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED.has(ext);
}
