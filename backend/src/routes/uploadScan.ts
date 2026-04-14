import type { Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanUploadWorkspace } from '../agents/scanner.js';
import { requireAuth } from '../auth/jwt.js';
import {
  MAX_EXTRACTED_TOTAL_BYTES,
  MAX_FILES_IN_ARCHIVE,
  MAX_SINGLE_FILE_BYTES,
  MAX_ZIP_BYTES,
} from '../upload/limits.js';
import { extractZipBufferToDir } from '../upload/extractZip.js';
import { isSafeResolvedPath, normalizeUploadRelativePath } from '../upload/pathUtils.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ZIP_BYTES,
    files: MAX_FILES_IN_ARCHIVE,
    fieldSize: 64_000,
  },
});

const uploadScanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX ?? 8),
  standardHeaders: true,
  legacyHeaders: false,
});

function scanCatchMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

router.post(
  '/scan/upload',
  requireAuth,
  uploadScanLimiter,
  upload.fields([
    { name: 'archive', maxCount: 1 },
    { name: 'files', maxCount: MAX_FILES_IN_ARCHIVE },
  ]),
  async (req: Request, res: Response) => {
    const body = req.body as { query?: string };
    const query = typeof body.query === 'string' ? body.query : '';
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const archive = files?.archive?.[0];
    const folderFiles = files?.files;

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'debtwatch-ul-'));

    try {
      if (archive?.buffer?.length) {
        if (archive.size > MAX_ZIP_BYTES) {
          return res.status(413).json({ error: 'Zip file exceeds maximum allowed size.' });
        }
        await extractZipBufferToDir(archive.buffer, tmpDir);
      } else if (folderFiles?.length) {
        let cumulative = 0;
        const normalized: { rel: string; buf: Buffer }[] = [];
        for (const f of folderFiles) {
          if (f.size > MAX_SINGLE_FILE_BYTES) {
            return res.status(413).json({ error: `File too large: ${f.originalname}` });
          }
          const rel = normalizeUploadRelativePath(f.originalname);
          if (!rel) {
            return res.status(400).json({ error: 'Invalid or unsafe file path in upload.' });
          }
          const dest = path.resolve(tmpDir, rel);
          if (!isSafeResolvedPath(dest, tmpDir)) {
            return res.status(400).json({ error: 'Path traversal rejected.' });
          }
          cumulative += f.size;
          if (cumulative > MAX_EXTRACTED_TOTAL_BYTES) {
            return res.status(413).json({ error: 'Total upload size exceeds limit.' });
          }
          normalized.push({ rel, buf: f.buffer });
        }
        for (const { rel, buf } of normalized) {
          const dest = path.resolve(tmpDir, rel);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, buf);
        }
      } else {
        return res.status(400).json({
          error: 'Provide a zip in field "archive" or a folder in field "files" (multipart).',
        });
      }

      const q = query.trim();
      const result = await scanUploadWorkspace(tmpDir, q ? { userQuery: q } : {});

      if (result.mode === 'explain') {
        return res.json({
          mode: 'explain' as const,
          findings: [],
          explanation: result.explanation,
          total: 0,
          ...(result.visualExplanation ? { visualExplanation: result.visualExplanation } : {}),
        });
      }
      return res.json({
        mode: 'scan' as const,
        findings: result.findings,
        total: Array.isArray(result.findings) ? result.findings.length : 0,
      });
    } catch (error: unknown) {
      const msg = scanCatchMessage(error);
      if (msg.startsWith('ZIP_REJECTED')) {
        return res.status(400).json({ error: msg.replace(/^ZIP_REJECTED:\s*/, '') });
      }
      console.error('[upload/scan]', error);
      return res.status(500).json({ error: 'Scan failed. Try a smaller archive or fewer files.' });
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

export default router;
