import { auth } from 'express-oauth2-jwt-bearer';

function authOptions() {
  const domain = process.env.AUTH0_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain) {
    throw new Error('AUTH0_DOMAIN is required');
  }

  // Comma-separated: API Identifier + optional SPA Client ID so tokens with aud = either pass.
  // Example: AUTH0_AUDIENCE=https://debtwatch-api,PJXx9S1ldl40FyDRzQhgd5NWHpn7sDcN
  const audiences = [
    ...new Set(
      process.env.AUTH0_AUDIENCE?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    ),
  ];

  if (audiences.length === 0) {
    throw new Error('AUTH0_AUDIENCE is required (comma-separate API identifier and SPA Client ID if needed)');
  }

  return {
    audience: audiences.length === 1 ? audiences[0]! : audiences,
    issuerBaseURL: `https://${domain}`,
    tokenSigningAlg: 'RS256' as const,
  };
}

export const requireAuth = auth(authOptions());
