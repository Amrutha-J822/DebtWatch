import '../env.js';
import { Auth0AI } from '@auth0/ai-vercel';
import { getAccessTokenFromTokenVault } from '@auth0/ai/TokenVault';

const auth0AI = new Auth0AI();

// One wrapper per service
export const withGitHub = auth0AI.withTokenVault({
  connection: 'github',
  scopes: [],  // GitHub uses app-level permissions, not scopes
  refreshToken: getRefreshToken,
});

export const withGoogle = auth0AI.withTokenVault({
  connection: 'google-oauth2',
  scopes: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ],
  refreshToken: getRefreshToken,
});

export const withSlack = auth0AI.withTokenVault({
  connection: 'slack',
  scopes: ['chat:write', 'channels:read', 'users:read'],
  refreshToken: getRefreshToken,
});

// Helper to get refresh token from request session
function getRefreshToken() {
  // This gets populated from the Auth0 session in each request
  return process.env.AUTH0_REFRESH_TOKEN || '';
}

/** Use inside a function wrapped by `withGitHub`, `withGoogle`, or `withSlack`. */
export { getAccessTokenFromTokenVault };