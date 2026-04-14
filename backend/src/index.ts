import './env.js';
import express from 'express';
import cors from 'cors';
import scanRouter from './routes/scan.js';
import uploadScanRouter from './routes/uploadScan.js';
import { appendDebugLine, peekJwtAud } from './debugSessionLog.js';

const app = express();
app.set('trust proxy', 1);

const extraOrigins =
  process.env.CORS_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const frontend = process.env.FRONTEND_URL?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];

const allowedOrigins = [
  ...extraOrigins,
  ...frontend,
  'http://localhost:5173',
  'http://localhost:3000',
];

const allowList = new Set(allowedOrigins.filter(Boolean));
const allowVercelHosts =
  process.env.CORS_ALLOW_VERCEL === '1' || process.env.CORS_ALLOW_VERCEL === 'true';

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) {
        cb(null, true);
        return;
      }
      if (allowList.has(origin)) {
        cb(null, true);
        return;
      }
      if (allowVercelHosts) {
        try {
          const { hostname } = new URL(origin);
          if (hostname.endsWith('.vercel.app') || hostname === 'vercel.app') {
            cb(null, true);
            return;
          }
        } catch {
          /* invalid origin URL */
        }
      }
      cb(null, false);
    },
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);
app.use(express.json());

// #region agent log
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith('/api')) {
    next();
    return;
  }
  const raw = req.headers.authorization;
  const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : '';
  const peek = token ? peekJwtAud(token) : { parts: 0, aud: null as string | null };
  appendDebugLine({
    hypothesisId: 'H-backend-preflight',
    location: 'index.ts:apiPreflight',
    message: 'API request Authorization shape',
    data: {
      method: req.method,
      originalUrl: req.originalUrl,
      bearerLen: token.length,
      jwtParts: peek.parts,
      audPeek: peek.aud,
    },
  });
  next();
});
// #endregion

app.get('/api/meta', (_req, res) => {
  res.json({
    name: 'DebtWatch',
    slackAppUrl: process.env.SLACK_APP_URL || '',
  });
});

app.use('/api', scanRouter);
app.use('/api', uploadScanRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// #region agent log
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  appendDebugLine({
    hypothesisId: 'H2',
    location: 'index.ts:errorHandler',
    message: 'Express auth error',
    data: {
      originalUrl: req.originalUrl,
      errName: err instanceof Error ? err.name : typeof err,
      errMessage: err instanceof Error ? err.message : String(err),
      statusCode:
        err && typeof err === 'object' && 'statusCode' in err
          ? (err as { statusCode: number }).statusCode
          : undefined,
    },
  });
  if (res.headersSent) {
    return;
  }
  const status =
    err && typeof err === 'object' && 'statusCode' in err && typeof (err as { statusCode: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
  const message = err instanceof Error ? err.message : 'Error';
  res.status(status).json({ error: message });
});
// #endregion

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`DebtWatch backend running on port ${PORT}`);
});
// Default Node socket timeout can close long scans (GitHub + Claude); allow up to 15 minutes.
server.setTimeout(900_000);