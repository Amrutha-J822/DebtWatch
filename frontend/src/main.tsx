import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Auth0Provider } from '@auth0/auth0-react';
import '@radix-ui/themes/styles.css';
import './index.css';
import { auth0AppBaseUrl } from './auth0AppUrls';
import App from './App.tsx';

const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim();
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim();
const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim();

function EnvMissing({ missing }: { missing: string[] }) {
  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, maxWidth: 560, margin: '10vh auto' }}>
      <h1 style={{ fontSize: 20 }}>Missing Auth0 environment variables</h1>
      <p style={{ color: '#555', lineHeight: 1.5 }}>
        Vite only reads files under the <code>frontend/</code> folder. It does <strong>not</strong> use{' '}
        <code>backend/.env</code>.
      </p>
      <p style={{ color: '#555', lineHeight: 1.5, marginTop: 12 }}>
        <strong>Not set or empty:</strong>
      </p>
      <ul style={{ color: '#333' }}>
        {missing.map((k) => (
          <li key={k}>
            <code>{k}</code>
          </li>
        ))}
      </ul>
      <p style={{ color: '#555', lineHeight: 1.5, marginTop: 12 }}>
        Fix: create <code>frontend/.env.local</code> with at least:
      </p>
      <pre
        style={{
          background: '#f4f4f5',
          padding: 12,
          borderRadius: 8,
          fontSize: 13,
          overflow: 'auto',
        }}
      >
        {`VITE_AUTH0_CLIENT_ID=<Auth0 → Applications → your SPA → Client ID>`}
      </pre>
      <p style={{ color: '#666', fontSize: 14, marginTop: 12 }}>
        Also set <code>VITE_AUTH0_AUDIENCE</code> to your Auth0 API Identifier (Dashboard → APIs). The
        backend expects JWT access tokens. After editing env files, <strong>stop and restart</strong>{' '}
        <code>npm run dev</code>.
      </p>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);

const missingKeys = [
  !domain && 'VITE_AUTH0_DOMAIN',
  !clientId && 'VITE_AUTH0_CLIENT_ID',
  !audience && 'VITE_AUTH0_AUDIENCE',
].filter(Boolean) as string[];

if (missingKeys.length > 0) {
  root.render(
    <StrictMode>
      <EnvMissing missing={missingKeys} />
    </StrictMode>,
  );
} else {
  // StrictMode must NOT wrap Auth0Provider: React 19 remounts children and re-runs the SDK init
  // effect, which races PKCE / code exchange and leaves you stuck on the app “logged out”.
  // Include `audience` on login so the session (and refresh token, when enabled) is tied to your
  // custom API. Otherwise getAccessTokenSilently({ audience }) can fail with “not authorized to
  // access resource server” even when Application Access shows AUTHORIZED — the grant must apply
  // to the tokens issued at login, not only to a later silent exchange. Requires the SPA to be
  // authorized for that API (Dashboard → APIs → Application Access).
  root.render(
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      httpTimeoutInSeconds={120}
      authorizationParams={{
        redirect_uri: auth0AppBaseUrl(),
        audience,
        scope: 'openid profile email',
      }}
      cacheLocation="localstorage"
    >
      <StrictMode>
        <App />
      </StrictMode>
    </Auth0Provider>,
  );
}
