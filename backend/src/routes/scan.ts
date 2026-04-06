import type { Request } from 'express';
import { Router } from 'express';
import { getGitHubTokenFromVault } from '../auth/tokenVault.js';
import { scanRepository } from '../agents/scanner.js';

const router = Router();

function readBearerApiJwt(req: Request): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return undefined;
  const t = raw.slice(7).trim();
  return t || undefined;
}

/** Octokit HttpError: invalid PAT, revoked token, or wrong token type. */
function isGitHubBadCredentials(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (msg.includes('bad credentials')) return true;
  const status =
    err && typeof err === 'object' && 'status' in err ? (err as { status: unknown }).status : undefined;
  return status === 401;
}

function scanCatchMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

function isGeminiQuotaOrRateLimit(lower: string): boolean {
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('quota exceeded') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('quota failure') ||
    (lower.includes('"code"') &&
      lower.includes('429') &&
      (lower.includes('generativelanguage') || lower.includes('gemini')))
  );
}

/**
 * Scan flow: frontend sends owner/repo or a GitHub repo URL.
 * If the request includes `Authorization: Bearer <Auth0 API access token>`, the backend loads the
 * user's GitHub token from Auth0 Token Vault (same as Email/Docs). Otherwise it uses optional
 * GITHUB_TOKEN / GH_TOKEN in backend/.env, or unauthenticated GitHub (strict rate limits).
 *
 * If GITHUB_TOKEN or GH_TOKEN is set and the client sends a Bearer JWT, the scan uses the env PAT
 * first and does not call Token Vault (avoids Vault errors and log spam). Set
 * SCAN_TRY_TOKEN_VAULT_FIRST=true to try Vault first and fall back to env on failure.
 */
router.post('/scan', async (req, res) => {
  const { repo, query } = req.body as { repo?: string; query?: string };

  if (!repo?.trim()) {
    return res
      .status(400)
      .json({ error: 'repo is required (GitHub URL or owner/repo)' });
  }

  const repoRaw = String(repo).trim();
  const repoNormalized =
    /^https?:\/\//i.test(repoRaw)
      ? repoRaw
      : repoRaw.replace(/\s+/g, '/').replace(/\/+/g, '/');

  try {
    const apiJwt = readBearerApiJwt(req);
    let githubTokenForScan: string | undefined;
    let tokenSource:
      | 'vault'
      | 'env_after_vault_fail'
      | 'env_preferred'
      | null = null;

    const envTok = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
    const tryVaultFirst =
      process.env.SCAN_TRY_TOKEN_VAULT_FIRST === '1' ||
      process.env.SCAN_TRY_TOKEN_VAULT_FIRST === 'true';

    if (apiJwt) {
      if (envTok && !tryVaultFirst) {
        githubTokenForScan = envTok;
        tokenSource = 'env_preferred';
      } else {
        try {
          githubTokenForScan = await getGitHubTokenFromVault(apiJwt);
          tokenSource = 'vault';
        } catch (vaultErr) {
          const vm = vaultErr instanceof Error ? vaultErr.message : String(vaultErr);
          if (envTok) {
            console.warn(
              '[scan] Token Vault (github) failed; using GITHUB_TOKEN / GH_TOKEN from env.',
              vm.slice(0, 160),
            );
            githubTokenForScan = envTok;
            tokenSource = 'env_after_vault_fail';
          } else {
            console.error('[scan] Token Vault (github):', vm.slice(0, 240));
            if (/refresh token not found/i.test(vm)) {
              return res.status(503).json({
                error:
                  'GitHub is not available from Auth0 Token Vault for this login (refresh token missing).',
                detail:
                  'In Auth0 Dashboard, enable Token Vault for the GitHub connection, then sign out, sign in, and complete the GitHub consent screen. For local development you can set GITHUB_TOKEN in backend/.env. https://auth0.com/docs/secure/tokens/token-vault/refresh-token-exchange-with-token-vault',
              });
            }
            return res.status(503).json({
              error: 'Could not load your GitHub token from Auth0 Token Vault.',
              detail:
                'Link GitHub in Auth0, sign out and sign in again, or set GITHUB_TOKEN in backend/.env for local development.',
            });
          }
        }
      }
    }

    // #region agent log
    fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '1623b3',
      },
      body: JSON.stringify({
        sessionId: '1623b3',
        hypothesisId: 'H_public_scan',
        location: 'scan.ts:beforeScanRepository',
        message: 'scan route GitHub auth source',
        data: {
          repo: repoNormalized,
          hasQuery: Boolean(query?.trim()),
          hasApiJwt: Boolean(apiJwt),
          tokenSource,
          hasGithubTokenArg: Boolean(githubTokenForScan),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    const q = typeof query === 'string' ? query.trim() : '';
    const result = await scanRepository(
      repoNormalized,
      githubTokenForScan,
      q ? { userQuery: q } : {},
    );
    if (result.mode === 'explain') {
      return res.json({
        mode: 'explain' as const,
        findings: [],
        explanation: result.explanation,
        total: 0,
        ...(result.visualExplanation
          ? { visualExplanation: result.visualExplanation }
          : {}),
      });
    }
    res.json({
      mode: 'scan' as const,
      findings: result.findings,
      total: result.findings.length,
    });
  } catch (error: unknown) {
    const message = scanCatchMessage(error);
    const lower = message.toLowerCase();

    // #region agent log
    fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': '1623b3',
      },
      body: JSON.stringify({
        sessionId: '1623b3',
        hypothesisId: 'H_public_scan',
        location: 'scan.ts:catch',
        message: 'scan route error',
        data: {
          startsWith: message.slice(0, 120),
          githubUnauthorized: isGitHubBadCredentials(error),
          geminiQuota: isGeminiQuotaOrRateLimit(message.toLowerCase()),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    if (isGitHubBadCredentials(error)) {
      console.warn('[scan] GitHub 401 Bad credentials — invalid or expired PAT, or wrong token in .env');
      return res.status(502).json({
        error:
          'GitHub rejected the token (401 Bad credentials). Regenerate a personal access token with read access to this repo, set GITHUB_TOKEN or GH_TOKEN in backend/.env (no quotes, no trailing spaces), and restart the server. Fine-grained tokens must explicitly include the repository or organization you scan.',
      });
    }

    if (lower.includes('invalid repo')) {
      return res.status(400).json({
        error: 'Invalid repository: use owner/repo or a full GitHub repository URL.',
      });
    }

    if (
      lower.includes('not found') ||
      lower.includes('404') ||
      lower.includes('private repository') ||
      lower.includes('forbidden')
    ) {
      return res.status(404).json({
        error:
          'Repository not accessible. Use a public GitHub repository URL/owner-repo, or make the repo public.',
      });
    }

    if (
      lower.includes('rate limit') ||
      lower.includes('api rate limit exceeded') ||
      lower.includes('secondary rate limit')
    ) {
      console.error('[scan] github rate limit:', message.slice(0, 200));
      return res.status(429).json({
        error:
          'GitHub API rate limit reached. Sign in so we can use your GitHub token from Token Vault, or set GITHUB_TOKEN in backend/.env, wait, or retry later.',
      });
    }

    if (isGeminiQuotaOrRateLimit(lower)) {
      console.warn('[scan] Gemini quota / rate limit:', message.slice(0, 400));
      return res.status(429).json({
        error:
          'Gemini quota or rate limit exceeded for the configured model (often free tier limits or previews). Wait a minute and retry, check usage and billing in Google AI Studio, or set GEMINI_REASONING_MODEL in backend/.env to a model your project can use (for example a Flash-tier model). https://ai.google.dev/gemini-api/docs/rate-limits',
      });
    }

    if (
      lower.includes('gemini_api_key') ||
      lower.includes('anthropic_api_key') ||
      lower.includes('anthropic')
    ) {
      console.error('[scan] ai:', message.slice(0, 500));
      return res.status(503).json({ error: 'AI service is not configured on the server.' });
    }

    if (lower.includes('generativelanguage.googleapis.com')) {
      console.warn('[scan] Gemini API error:', message.slice(0, 400));
      return res.status(502).json({
        error:
          'Gemini request failed. Check GEMINI_API_KEY and GEMINI_REASONING_MODEL in backend/.env and your Google Cloud / AI Studio project settings.',
      });
    }

    console.error('[scan]', error);
    res.status(500).json({ error: 'Scan failed. Try again or check server logs.' });
  }
});

export default router;
