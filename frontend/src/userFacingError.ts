/**
 * Never show raw Auth0/OAuth errors in the UI: they often embed client IDs, JWTs, or long opaque values.
 */

import { isAxiosError } from 'axios';

const JWT_LIKE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Long unbroken strings typical of Auth0 client IDs, API identifiers, and opaque resource names. */
const OPAQUE_AUTH0_LIKE = /\b[A-Za-z0-9_-]{22,40}\b/g;

export function scrubSecrets(message: string): string {
  let s = message;
  s = s.replace(JWT_LIKE, '[token redacted]');
  s = s.replace(/Client\s+"[^"]+"/gi, 'This application');
  s = s.replace(/client\s+"[^"]+"/gi, 'this application');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]');
  s = s.replace(/client_id=[A-Za-z0-9_-]+/gi, 'client_id=[redacted]');
  // "Service not found: <audience>" and similar — never show the raw identifier
  s = s.replace(/service not found\s*:\s*\S+/gi, 'service not found');
  s = s.replace(/unknown\s+client\s*:\s*\S+/gi, 'unknown client');
  // Trailing opaque id after colon (Auth0 often appends audience / client id)
  s = s.replace(/:\s*[A-Za-z0-9_-]{18,}(?=\s*$|[\s.,;)!]|$)/g, ': [redacted]');
  s = s.replace(OPAQUE_AUTH0_LIKE, '[redacted]');
  return s.trim();
}

const API_NOT_AUTHORIZED =
  'Auth0 rejected the access-token request for this API audience. Dashboard path: Applications → APIs → open the row whose Identifier matches your audience → Application Access (not a vague "authorize URL" toggle on the SPA). If user access is "Allow via client-grant", authorize your SPA there; for local dev you can use user access "Allow". Save, sign out, sign in, retry. See https://auth0.com/docs/get-started/apis/api-access-policies-for-applications';

const SERVICE_NOT_FOUND =
  'Auth0 could not find an API with that Identifier. Create an API (Dashboard → APIs), set its Identifier to match VITE_AUTH0_AUDIENCE, authorize your SPA (Applications → your app → APIs), then sign out and sign in again.';

const MISSING_VITE_AUTH0_AUDIENCE =
  'Set VITE_AUTH0_AUDIENCE to your Auth0 API Identifier (Dashboard → APIs). The backend only accepts JWT access tokens, which Auth0 issues when you request that API as the audience.';

const UNAUTHORIZED_401 =
  'Unauthorized (401). Use a JWT access token: set VITE_AUTH0_AUDIENCE to your Auth0 API Identifier, put the same value in backend AUTH0_AUDIENCE, authorize the SPA for that API, restart both apps, then sign out and sign in.';

const TIMEOUT_HINT =
  'The operation timed out. Token or network calls can be slow — wait a moment and try again. Repository scans can take several minutes on large repos.';

function looksLikeTimeout(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower === 'timeout' ||
    lower.includes('timeout exceeded') ||
    lower.includes('timed out') ||
    /timeout of \d+ms/.test(lower) ||
    (lower.includes('timeout') && lower.includes('exceeded'))
  );
}

export function formatUserFacingError(message: string): string {
  if (message === 'MISSING_VITE_AUTH0_AUDIENCE') {
    return MISSING_VITE_AUTH0_AUDIENCE;
  }
  const lower = message.toLowerCase();
  if (
    lower.includes('not authorized to access resource server') ||
    (lower.includes('not authorized') && lower.includes('resource server'))
  ) {
    return API_NOT_AUTHORIZED;
  }
  if (lower.includes('service not found')) {
    return SERVICE_NOT_FOUND;
  }
  if (lower.includes('consent_required') || lower.includes('login_required')) {
    return 'Your session must be renewed. Sign out, sign in again, and retry.';
  }
  if (looksLikeTimeout(message)) {
    return TIMEOUT_HINT;
  }
  return scrubSecrets(message);
}

export function formatClientCatchError(e: unknown, networkFallback: string): string {
  if (isAxiosError(e)) {
    if (e.code === 'ECONNABORTED' || looksLikeTimeout(e.message)) {
      return TIMEOUT_HINT;
    }
    const status = e.response?.status;
    if (status === 401) {
      return UNAUTHORIZED_401;
    }
    if (status === 408 || status === 504) {
      return TIMEOUT_HINT;
    }
    const data = e.response?.data as { error?: string; detail?: string } | undefined;
    const apiMsg = data?.error != null && data.error !== '' ? scrubSecrets(String(data.error)) : '';
    const detail = data?.detail ? scrubSecrets(String(data.detail)) : '';
    const base =
      apiMsg ||
      (e.code === 'ERR_NETWORK' ? networkFallback : scrubSecrets(e.message));
    return formatUserFacingError(`${base}${detail ? ` — ${detail}` : ''}`);
  }
  if (e instanceof Error) {
    return formatUserFacingError(e.message);
  }
  return formatUserFacingError(String(e));
}
