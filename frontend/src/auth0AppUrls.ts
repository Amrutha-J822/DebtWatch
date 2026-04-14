/**
 * Single source of truth for Auth0 login `redirect_uri` and logout `returnTo`.
 * Must match Allowed Callback URLs and Allowed Logout URLs exactly (Auth0 compares strings).
 *
 * Dev: set `VITE_AUTH0_REDIRECT_URI` to your SPA origin (e.g. `http://localhost:5173` with default
 * Vite) so login works even if you opened the tab
 * with `127.0.0.1` instead of `localhost` — those are different origins; whitelist both in Auth0
 * if you need both, or use one host only.
 */
export function auth0AppBaseUrl(): string {
  const explicit = import.meta.env.VITE_AUTH0_REDIRECT_URI?.trim();
  const raw = explicit || (typeof window !== 'undefined' ? window.location.origin : '');
  return normalizeSpaRedirectUri(raw);
}

/** Collapses `http://host/` → `http://host` so Auth0 matches Allowed Callback URLs without slash fights. */
function normalizeSpaRedirectUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.pathname === '/' || u.pathname === '') {
      return u.origin;
    }
    return uri.trim();
  } catch {
    return uri.trim();
  }
}
