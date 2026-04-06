/**
 * Access token exchange with Auth0 Token Vault (SPA → API JWT → provider token).
 * @see https://auth0.com/docs/secure/tokens/token-vault/access-token-exchange-with-token-vault
 */
function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
) {
  // #region agent log
  fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '1623b3',
    },
    body: JSON.stringify({
      sessionId: '1623b3',
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

export async function getConnectionAccessToken(
  auth0AccessToken: string,
  connection: string,
): Promise<string> {
  const domain = process.env.AUTH0_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const clientId = process.env.AUTH0_CUSTOM_API_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CUSTOM_API_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error(
      'Missing AUTH0_DOMAIN, AUTH0_CUSTOM_API_CLIENT_ID, or AUTH0_CUSTOM_API_CLIENT_SECRET',
    );
  }

  debugLog('H_conn_exchange', 'tokenVault.ts:getConnectionAccessToken:start', 'Token Vault exchange start', {
    connection,
    clientIdPrefix: clientId ? clientId.slice(0, 6) : null,
    clientIdTail: clientId ? clientId.slice(-6) : null,
    domain,
    hasSubjectToken: Boolean(auth0AccessToken),
  });

  async function exchangeForConnection(connectionName: string) {
    const res = await fetch(`https://${domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        subject_token: auth0AccessToken,
        grant_type:
          'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
        connection: connectionName,
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    return { res, body };
  }

  const { res, body } = await exchangeForConnection(connection);

  const parsedJwt = auth0AccessToken.split('.');
  const jwtAudPreview =
    parsedJwt.length === 3
      ? (() => {
          try {
            const payload = JSON.parse(Buffer.from(parsedJwt[1]!, 'base64url').toString('utf8')) as {
              aud?: string | string[];
              sub?: string;
            };
            return {
              aud: Array.isArray(payload.aud) ? payload.aud.join(',') : payload.aud ?? null,
              subPrefix: payload.sub ? payload.sub.split('|')[0] : null,
            };
          } catch {
            return { aud: null, subPrefix: null };
          }
        })()
      : { aud: null, subPrefix: null };

  if (!res.ok) {
    debugLog(
      'H_conn_exchange',
      'tokenVault.ts:getConnectionAccessToken:exchangeFail',
      'Token Vault exchange failed',
      {
        connection,
        attemptedFallbackConnection: null,
        status: res.status,
        error: body.error ?? null,
        error_description: body.error_description ?? null,
        jwtAud: jwtAudPreview.aud,
        jwtSubPrefix: jwtAudPreview.subPrefix,
      },
    );
    const msg =
      body.error_description ||
      body.error ||
      `Token Vault exchange failed (${res.status})`;
    throw new Error(msg);
  }

  if (!body.access_token) {
    debugLog(
      'H_conn_exchange',
      'tokenVault.ts:getConnectionAccessToken:noAccessToken',
      'Token Vault returned no access token',
      { connection, status: res.status },
    );
    throw new Error('Token Vault returned no access_token');
  }

  debugLog(
    'H_conn_exchange',
    'tokenVault.ts:getConnectionAccessToken:exchangeOk',
    'Token Vault exchange succeeded',
    { connection, tokenLength: body.access_token.length },
  );
  return body.access_token;
}

export function getGitHubTokenFromVault(auth0AccessToken: string) {
  return getConnectionAccessToken(auth0AccessToken, 'github');
}

export function getGoogleTokenFromVault(auth0AccessToken: string) {
  return getConnectionAccessToken(auth0AccessToken, 'google-oauth2');
}

export function getSlackTokenFromVault(auth0AccessToken: string) {
  return getConnectionAccessToken(auth0AccessToken, 'slack');
}
