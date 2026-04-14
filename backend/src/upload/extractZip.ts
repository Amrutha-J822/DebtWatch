import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import {
  MAX_EXTRACTED_TOTAL_BYTES,
  MAX_FILES_IN_ARCHIVE,
  MAX_SINGLE_FILE_BYTES,
} from './limits.js';
import { isAllowedScanExtension } from './allowedExtensions.js';
import { isSafeResolvedPath } from './pathUtils.js';

function openZipFromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) reject(err);
      else if (!zipfile) reject(new Error('Invalid zip'));
      else resolve(zipfile);
    });
  });
}

function readEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else if (!stream) reject(new Error('No stream'));
      else resolve(stream);
    });
  });
}

/**
 * Validates every entry (rejects whole archive on traversal or limits), then extracts
 * only allowlisted text/source files.
 */
export async function extractZipBufferToDir(buffer: Buffer, extractDir: string): Promise<void> {
  const zip = await openZipFromBuffer(buffer);
  const extractRoot = path.resolve(extractDir);

  const toExtract: yauzl.Entry[] = [];
  let sumAllUncompressed = 0;

  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.readEntry();
    zip.on('entry', (entry: yauzl.Entry) => {
      try {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        const rel = entry.fileName.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('\0') || rel.includes('..')) {
          throw new Error('ZIP_REJECTED: unsafe path');
        }
        const dest = path.resolve(extractRoot, rel);
        if (!isSafeResolvedPath(dest, extractRoot)) {
          throw new Error('ZIP_REJECTED: path traversal');
        }
        sumAllUncompressed += entry.uncompressedSize;
        if (sumAllUncompressed > MAX_EXTRACTED_TOTAL_BYTES) {
          throw new Error('ZIP_REJECTED: uncompressed size exceeds limit');
        }
        if (isAllowedScanExtension(rel)) {
          if (entry.uncompressedSize > MAX_SINGLE_FILE_BYTES) {
            throw new Error('ZIP_REJECTED: single file too large');
          }
          toExtract.push(entry);
          if (toExtract.length > MAX_FILES_IN_ARCHIVE) {
            throw new Error('ZIP_REJECTED: too many files');
          }
        }
      } catch (e) {
        reject(e);
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve());
  });

  for (const entry of toExtract) {
    const rel = entry.fileName.replace(/\\/g, '/').replace(/^\/+/, '');
    const dest = path.resolve(extractRoot, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const rs = await readEntryStream(zip, entry);
    const ws = createWriteStream(dest);
    await pipeline(rs, ws);
  }

  zip.close();
}
