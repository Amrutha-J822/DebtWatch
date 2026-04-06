import { useAuth0 } from '@auth0/auth0-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import axios, { isAxiosError } from 'axios';
import { auth0AppBaseUrl } from './auth0AppUrls';
import debtwatchLogoUrl from './assets/debtwatch-logo.png';
import { LoginScreen } from './LoginScreen';
import { MarkdownExplanation } from './MarkdownExplanation';
import { ThemeToggle } from './ThemeToggle';
import { APPEARANCE_STORAGE_KEY, readStoredAppearance, type Appearance } from './appearance';
import { formatClientCatchError, formatUserFacingError } from './userFacingError';
import './dashboard-layout.css';
import './scan-form.css';
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Grid,
  Separator,
  Spinner,
  Text,
  Theme,
} from '@radix-ui/themes';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** Scan walks the repo + runs Claude; allow long requests so axios does not abort early. */
const SCAN_HTTP_TIMEOUT_MS = 600_000;

const SCAN_HISTORY_KEY = 'debtwatch-scan-history';
const MAX_HISTORY = 80;

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

function severityToLevel(s: Severity): number {
  switch (s) {
    case 'CRITICAL':
      return 4;
    case 'HIGH':
      return 3;
    case 'MEDIUM':
      return 2;
    default:
      return 1;
  }
}

type ScanHistoryRecord = {
  id: string;
  repo: string;
  at: string;
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  /** Finding types from that scan (for analytics charts). Older history rows may omit this. */
  findingTypes?: { type: string; severity: Severity }[];
};

function loadScanHistory(): ScanHistoryRecord[] {
  try {
    const raw = localStorage.getItem(SCAN_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ScanHistoryRecord =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as ScanHistoryRecord).repo === 'string' &&
        typeof (r as ScanHistoryRecord).at === 'string',
    );
  } catch {
    return [];
  }
}

function saveScanHistory(rows: ScanHistoryRecord[]) {
  try {
    localStorage.setItem(SCAN_HISTORY_KEY, JSON.stringify(rows.slice(0, MAX_HISTORY)));
  } catch {
    /* ignore */
  }
}

interface Finding {
  type: string;
  severity: Severity;
  category?: string;
  file: string;
  line: number;
  match: string;
  context: string;
  verdict?: string;
  reason?: string;
}

function severityBadgeColor(s: Severity): 'red' | 'orange' | 'yellow' | 'gray' {
  switch (s) {
    case 'CRITICAL':
      return 'red';
    case 'HIGH':
      return 'orange';
    case 'MEDIUM':
      return 'yellow';
    default:
      return 'gray';
  }
}

function severityDotColor(s: Severity): string {
  switch (s) {
    case 'CRITICAL':
      return 'var(--red-9)';
    case 'HIGH':
      return 'var(--orange-9)';
    case 'MEDIUM':
      return 'var(--yellow-9)';
    default:
      return 'var(--gray-9)';
  }
}

function SeverityCount({
  label,
  count,
  accent,
}: {
  label: string;
  count: number;
  accent: 'red' | 'orange' | 'yellow' | 'gray';
}) {
  return (
    <Flex direction="column" align="center" gap="1">
      <Text size="6" weight="bold" color={accent} highContrast>
        {count}
      </Text>
      <Text
        size="1"
        color="gray"
        weight="medium"
        style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
      >
        {label}
      </Text>
    </Flex>
  );
}

function MiniBarChart({
  rows,
}: {
  rows: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Flex direction="column" gap="2">
      {rows.map((r) => (
        <Flex key={r.label} align="center" gap="2">
          <Text size="1" color="gray" style={{ width: 84, textAlign: 'right' }}>
            {r.label}
          </Text>
          <Box
            style={{
              height: 10,
              borderRadius: 9999,
              width: `${Math.max(6, Math.round((r.value / max) * 100))}%`,
              background: r.color,
              boxShadow: `0 0 10px ${r.color}55`,
            }}
          />
          <Text size="1" color="gray" style={{ minWidth: 18 }}>
            {r.value}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** Line chart: X = vulnerability name, Y = severity level (1=low … 4=critical). */
function VulnerabilitySeverityLineChart({
  points,
  color,
}: {
  points: { label: string; fullLabel: string; value: number }[];
  color: string;
}) {
  if (points.length === 0) {
    return (
      <Box
        style={{
          minHeight: 180,
          borderRadius: 'var(--radius-3)',
          background: 'var(--gray-a3)',
          display: 'grid',
          placeItems: 'center',
          padding: 'var(--space-4)',
        }}
      >
        <Text size="2" color="gray" align="center">
          Run more scans to plot vulnerability types. History from before this update has no saved
          finding names — scan once to populate the chart.
        </Text>
      </Box>
    );
  }

  const w = 600;
  const h = 220;
  const padL = 40;
  const padR = 20;
  const padT = 24;
  const padB = 72;
  const yMin = 1;
  const yMax = 4;
  const innerH = h - padT - padB;
  const innerW = w - padL - padR;

  const toY = (level: number) => {
    const v = Math.min(yMax, Math.max(yMin, level));
    return padT + ((yMax - v) / (yMax - yMin)) * innerH;
  };
  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const toX = (idx: number) => padL + idx * stepX;

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i)} ${toY(p.value)}`)
    .join(' ');

  const yTicks = [4, 3, 2, 1];

  return (
    <Box>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="severity by vulnerability type">
        {yTicks.map((tick) => {
          const y = toY(tick);
          return (
            <g key={tick}>
              <line x1={padL} y1={y} x2={w - padR} y2={y} stroke="var(--gray-a5)" strokeDasharray="4 4" />
              <text x={8} y={y + 4} fill="var(--gray-11)" fontSize="11">
                {tick}
              </text>
            </g>
          );
        })}
        <line x1={padL} y1={padT} x2={padL} y2={h - padB} stroke="var(--gray-a8)" />
        <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="var(--gray-a8)" />
        <text x={6} y={16} fill="var(--gray-11)" fontSize="10">
          Level (4=critical)
        </text>
        <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={`${p.fullLabel}-${i}`} cx={toX(i)} cy={toY(p.value)} r="5" fill={color} />
        ))}
        {points.map((p, i) => (
          <text
            key={`x-${p.fullLabel}-${i}`}
            x={toX(i)}
            y={h - padB + 14}
            fill="var(--gray-11)"
            fontSize="9"
            textAnchor="middle"
            transform={`rotate(-42 ${toX(i)} ${h - padB + 14})`}
          >
            {p.label}
          </text>
        ))}
      </svg>
    </Box>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const [expanded, setExpanded] = useState(false);
  const sev = finding.severity;
  const badgeColor = severityBadgeColor(sev);
  const dot = severityDotColor(sev);

  return (
    <Card size="2" variant="surface" style={{ overflow: 'hidden' }}>
      <Flex
        align="center"
        gap="3"
        p="3"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <Box
          style={{
            width: 10,
            height: 10,
            borderRadius: 9999,
            background: dot,
            flexShrink: 0,
            boxShadow: `0 0 12px ${dot}`,
          }}
        />
        <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <Flex gap="2" align="center" wrap="wrap">
            <Text weight="medium" size="2" highContrast>
              {finding.type}
            </Text>
            <Badge color={badgeColor} size="1" variant="soft" highContrast>
              {finding.severity}
            </Badge>
            {finding.category ? (
              <Badge color="cyan" size="1" variant="outline">
                {finding.category}
              </Badge>
            ) : null}
          </Flex>
          <Text size="1" color="gray" truncate>
            {finding.file} — line {finding.line}
          </Text>
        </Flex>
        <Text size="2" color="gray">
          {expanded ? '▲' : '▼'}
        </Text>
      </Flex>

      {expanded && (
        <>
          <Separator size="4" />
          <Box p="4" style={{ textAlign: 'left' }}>
            <Text size="1" weight="medium" color="gray" mb="2" style={{ textTransform: 'uppercase' }}>
              Match
            </Text>
            <Code
              size="2"
              variant="soft"
              style={{
                display: 'block',
                padding: 'var(--space-3)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {finding.match}
            </Code>
            <Text
              size="1"
              weight="medium"
              color="gray"
              mt="3"
              mb="2"
              style={{ textTransform: 'uppercase' }}
            >
              Context
            </Text>
            <Box
              p="3"
              style={{
                borderRadius: 'var(--radius-3)',
                background: 'var(--gray-a3)',
                fontFamily: 'var(--code-font-family, ui-monospace)',
                fontSize: 'var(--font-size-1)',
                color: 'var(--gray-12)',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto',
                minHeight: 120,
                maxHeight: 240,
                overflowY: 'auto',
              }}
            >
              {finding.context?.trim()
                ? finding.context
                : '(No context lines were captured for this match. Expand still shows the match text above.)'}
            </Box>
            {finding.reason ? (
              <Text size="1" color="gray" mt="3" style={{ fontStyle: 'italic' }}>
                Devil&apos;s Advocate: {finding.reason}
              </Text>
            ) : null}
          </Box>
        </>
      )}
    </Card>
  );
}

export default function App() {
  const {
    isAuthenticated,
    isLoading,
    user,
    error: auth0Error,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
  } = useAuth0();

  const [appearance, setAppearance] = useState<Appearance>(readStoredAppearance);
  const [repo, setRepo] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [error, setError] = useState('');
  const [scanHistory, setScanHistory] = useState<ScanHistoryRecord[]>([]);
  const [slackAppUrl, setSlackAppUrl] = useState('');
  const [mainTab, setMainTab] = useState('scan');

  // Email + Docs features removed by request.

  const [scanQuery, setScanQuery] = useState('');
  const [scanExplanation, setScanExplanation] = useState('');
  const [scanVisualExplanation, setScanVisualExplanation] = useState<{
    mimeType: string;
    dataBase64: string;
  } | null>(null);
  const [scanMode, setScanMode] = useState<'scan' | 'explain' | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  const auth0DefaultScope = 'openid profile email';

  useEffect(() => {
    setScanHistory(loadScanHistory());
  }, []);

  useEffect(() => {
    setAvatarBroken(false);
  }, [user?.picture]);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<{ slackAppUrl?: string }>(`${API_BASE}/api/meta`)
      .then((r) => {
        if (!cancelled && typeof r.data?.slackAppUrl === 'string') {
          setSlackAppUrl(r.data.slackAppUrl.trim());
        }
      })
      .catch(() => {
        /* optional: Slack link unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, []);


  const analyticsTotals = useMemo(() => {
    const sum = { critical: 0, high: 0, medium: 0, low: 0, scans: scanHistory.length };
    for (const r of scanHistory) {
      sum.critical += r.critical;
      sum.high += r.high;
      sum.medium += r.medium;
      sum.low += r.low;
    }
    return sum;
  }, [scanHistory]);

  /** Aggregate max severity level (1–4) per vulnerability type across saved scans. */
  const vulnerabilitySeverityLinePoints = useMemo(() => {
    const agg = new Map<string, number>();
    for (const row of scanHistory) {
      const types = row.findingTypes;
      if (!types?.length) continue;
      for (const { type, severity } of types) {
        const lvl = severityToLevel(severity);
        agg.set(type, Math.max(agg.get(type) ?? 0, lvl));
      }
    }
    const entries = [...agg.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 14);
    return entries.map(([fullLabel, value]) => ({
      fullLabel,
      label: fullLabel.length > 36 ? `${fullLabel.slice(0, 33)}…` : fullLabel,
      value,
    }));
  }, [scanHistory]);
  const avgBySeverity = useMemo(() => {
    const scans = Math.max(1, analyticsTotals.scans);
    return [
      { label: 'Critical avg', value: Number((analyticsTotals.critical / scans).toFixed(2)) },
      { label: 'High avg', value: Number((analyticsTotals.high / scans).toFixed(2)) },
      { label: 'Medium avg', value: Number((analyticsTotals.medium / scans).toFixed(2)) },
      { label: 'Low avg', value: Number((analyticsTotals.low / scans).toFixed(2)) },
    ];
  }, [analyticsTotals]);

  const onAppearanceChange = useCallback((value: Appearance) => {
    if (value !== 'light' && value !== 'dark') return;
    setAppearance(value);
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, value);
    } catch {
      /* ignore */
    }
  }, []);

  const loginWithGoogle = () => {
    loginWithRedirect({
      authorizationParams: {
        connection: 'google-oauth2',
        prompt: 'consent',
        access_type: 'offline',
        // Explicit provider scopes so Google consent includes mailbox access
        // when issuing the refresh token used by Token Vault exchange.
        connection_scope:
          'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.metadata',
        scope: auth0DefaultScope,
      },
    });
  };

  const loginWithGitHub = () => {
    loginWithRedirect({
      authorizationParams: {
        connection: 'github',
        scope: auth0DefaultScope,
      },
    });
  };

  const appendScanHistory = (repoNorm: string, list: Finding[]) => {
    const critical = list.filter((f) => f.severity === 'CRITICAL').length;
    const high = list.filter((f) => f.severity === 'HIGH').length;
    const medium = list.filter((f) => f.severity === 'MEDIUM').length;
    const low = list.filter((f) => f.severity === 'LOW').length;
    const byType = new Map<string, Severity>();
    for (const f of list) {
      const prev = byType.get(f.type);
      if (!prev || severityToLevel(f.severity) > severityToLevel(prev)) {
        byType.set(f.type, f.severity);
      }
    }
    const findingTypes = [...byType.entries()].map(([type, severity]) => ({ type, severity }));
    const row: ScanHistoryRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      repo: repoNorm,
      at: new Date().toISOString(),
      total: list.length,
      critical,
      high,
      medium,
      low,
      findingTypes,
    };
    setScanHistory((prev) => {
      const next = [row, ...prev].slice(0, MAX_HISTORY);
      saveScanHistory(next);
      return next;
    });
  };

  /**
   * Scan uses Token Vault when signed in: sends the Auth0 API access JWT (audience) so the backend
   * can exchange it for the user's GitHub token. Without it, GitHub REST uses anonymous rate limits.
   */
  const scan = async () => {
    if (!repo.trim()) return;
    setLoading(true);
    setError('');
    setScanned(false);
    setScanExplanation('');
    setScanVisualExplanation(null);
    setScanMode(null);

    const repoInput = repo.trim();
    const repoNormalized = /^https?:\/\//i.test(repoInput)
      ? repoInput
      : repoInput.replace(/\s+/g, '/').replace(/\/+/g, '/');

    try {
      const headers: Record<string, string> = {};
      const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim();
      let sentAuthHeader = false;
      let silentTokenError: string | null = null;
      if (isAuthenticated) {
        try {
          const accessToken = await getAccessTokenSilently(
            audience ? { authorizationParams: { audience } } : undefined,
          );
          if (accessToken) {
            headers.Authorization = `Bearer ${accessToken}`;
            sentAuthHeader = true;
          }
        } catch (e) {
          silentTokenError = e instanceof Error ? e.message : String(e);
          /* scan without Token Vault — anonymous GitHub limits may apply */
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
          hypothesisId: 'H_scan_client_auth',
          location: 'App.tsx:scan:beforePost',
          message: 'Scan POST auth header decision',
          data: {
            isAuthenticated,
            sentAuthHeader,
            hasAudienceConfig: Boolean(audience),
            silentTokenError: silentTokenError?.slice(0, 120) ?? null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion

      const { data } = await axios.post<{
        findings: Finding[];
        mode?: 'scan' | 'explain';
        explanation?: string;
        visualExplanation?: { mimeType: string; dataBase64: string };
      }>(
        `${API_BASE}/api/scan`,
        { repo: repoNormalized, query: scanQuery.trim() || undefined },
        {
          timeout: SCAN_HTTP_TIMEOUT_MS,
          headers: Object.keys(headers).length ? headers : undefined,
        },
      );
      const mode = data.mode ?? 'scan';
      setScanMode(mode);
      if (mode === 'explain') {
        setScanExplanation(data.explanation ?? '');
        setScanVisualExplanation(data.visualExplanation ?? null);
        setFindings([]);
      } else {
        setFindings(data.findings ?? []);
        appendScanHistory(repoNormalized, (data.findings ?? []) as Finding[]);
      }
      setScanned(true);
    } catch (e: unknown) {
      // #region agent log
      if (isAxiosError(e)) {
        fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': '1623b3',
          },
          body: JSON.stringify({
            sessionId: '1623b3',
            hypothesisId: 'H2',
            location: 'App.tsx:scan:axiosError',
            message: 'Scan request failed (axios)',
            data: {
              status: e.response?.status ?? null,
              apiError:
                typeof (e.response?.data as { error?: string } | undefined)?.error === 'string'
                  ? (e.response?.data as { error: string }).error
                  : null,
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
      } else {
        const o = e as Record<string, unknown>;
        fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Debug-Session-Id': '1623b3',
          },
          body: JSON.stringify({
            sessionId: '1623b3',
            hypothesisId: 'H4',
            location: 'App.tsx:scan:nonAxiosError',
            message: 'Scan failed before/during token (non-axios)',
            data: {
              name: o?.['name'],
              message: typeof o?.['message'] === 'string' ? o['message'] : String(e),
            },
            timestamp: Date.now(),
          }),
        }).catch(() => {});
      }
      // #endregion
      setError(
        formatClientCatchError(
          e,
          'Cannot reach the API. Start the backend (cd backend && npm run dev) and try again.',
        ),
      );
    } finally {
      setLoading(false);
    }
  };

  const counts = {
    CRITICAL: findings.filter((f) => f.severity === 'CRITICAL').length,
    HIGH: findings.filter((f) => f.severity === 'HIGH').length,
    MEDIUM: findings.filter((f) => f.severity === 'MEDIUM').length,
    LOW: findings.filter((f) => f.severity === 'LOW').length,
  };

  const greetingName = useMemo(() => {
    const n = user?.name?.trim();
    if (n) return n.split(/\s+/)[0] ?? 'there';
    const e = user?.email?.split('@')[0];
    if (e) return e;
    return 'there';
  }, [user?.name, user?.email]);

  return (
    <Theme
      appearance={!isAuthenticated ? 'dark' : appearance}
      accentColor="cyan"
      grayColor="slate"
      radius="medium"
      panelBackground="solid"
      scaling="100%"
    >
      {isLoading ? (
        <Box
          style={{
            minHeight: '100dvh',
            background: '#06061a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner size="3" />
        </Box>
      ) : !isAuthenticated ? (
        <LoginScreen
          auth0Error={auth0Error ?? undefined}
          onLoginGitHub={loginWithGitHub}
          onLoginGoogle={loginWithGoogle}
        />
      ) : (
      <Box className="dw-shell">
        <aside className="dw-sidebar" aria-label="Main navigation">
          <div className="dw-sidebar__brand">
            <img
              className="dw-sidebar__logo-img"
              src={debtwatchLogoUrl}
              alt=""
              width={44}
              height={44}
              decoding="async"
            />
            <div className="dw-sidebar__wordmark" translate="no">
              <span className="dw-sidebar__wordmark-debt">Debt</span>
              <span className="dw-sidebar__wordmark-watch">Watch</span>
            </div>
          </div>
          <nav className="dw-sidebar__nav">
            <button
              type="button"
              className={`dw-sidebar__link${mainTab === 'scan' ? ' dw-sidebar__link--active' : ''}`}
              onClick={() => setMainTab('scan')}
            >
              Scan
            </button>
            <button
              type="button"
              className={`dw-sidebar__link${mainTab === 'analytics' ? ' dw-sidebar__link--active' : ''}`}
              onClick={() => setMainTab('analytics')}
            >
              Analytics
            </button>
            <button
              type="button"
              className={`dw-sidebar__link${mainTab === 'history' ? ' dw-sidebar__link--active' : ''}`}
              onClick={() => setMainTab('history')}
            >
              History
            </button>
          </nav>
          {slackAppUrl.startsWith('http') ? (
            <div className="dw-sidebar__footer">
              <a
                className="dw-sidebar__slack"
                href={slackAppUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                DebtWatch in Slack
              </a>
            </div>
          ) : null}
        </aside>

        <div className="dw-main-area">
          <header className="dw-topbar">
            <span className="dw-topbar__hello">Hello, {greetingName}!</span>
            <div className="dw-topbar__actions">
              <ThemeToggle value={appearance} onChange={onAppearanceChange} />
              {user?.picture && !avatarBroken ? (
                <img
                  className="dw-avatar"
                  src={user.picture}
                  alt=""
                  onError={() => setAvatarBroken(true)}
                />
              ) : (
                <div
                  className="dw-avatar dw-avatar--fallback"
                  aria-hidden
                  title={user?.name || user?.email || ''}
                >
                  {(user?.name?.[0] || user?.email?.[0] || '?').toUpperCase()}
                </div>
              )}
              <Button
                size="2"
                variant="ghost"
                color="gray"
                onClick={() =>
                  logout({
                    logoutParams: {
                      returnTo: auth0AppBaseUrl(),
                    },
                  })
                }
              >
                Log out
              </Button>
            </div>
          </header>

          <main className="dw-main-scroll">
            <div className="dw-main-inner">
              {auth0Error ? (
                <Callout.Root color="red" role="alert" mb="4" style={{ width: '100%' }}>
                  <Callout.Text>{formatUserFacingError(auth0Error.message)}</Callout.Text>
                </Callout.Root>
              ) : null}

              {mainTab === 'scan' ? (
                <Flex direction="column" gap="4" align="stretch" width="100%">
                  <Card
                    size="3"
                    variant="surface"
                    style={{ width: '100%', maxWidth: 520, overflow: 'visible' }}
                  >
                    <Flex direction="column" gap="4" align="stretch">
                      <Flex direction="column" gap="2" align="start" style={{ width: '100%' }}>
                        <Text as="label" size="2" weight="medium" htmlFor="repo" highContrast>
                          Repository
                        </Text>
                        <textarea
                          id="repo"
                          className="dw-scan-textarea"
                          rows={2}
                          placeholder="owner/repo or GitHub URL"
                          value={repo}
                          onChange={(e) => setRepo(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              scan();
                            }
                          }}
                          disabled={isLoading}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Flex>

                      <Flex direction="column" gap="2" align="start" style={{ width: '100%' }}>
                        <Text as="label" size="2" weight="medium" htmlFor="scanQuery" highContrast>
                          Prompt (optional)
                        </Text>
                        <textarea
                          id="scanQuery"
                          className="dw-scan-textarea dw-scan-textarea--prompt"
                          placeholder="Explain overview, or focus on vulnerabilities… (drag corner to resize)"
                          value={scanQuery}
                          onChange={(e) => setScanQuery(e.target.value)}
                          disabled={isLoading}
                          autoComplete="off"
                        />
                      </Flex>

                      <Button
                        size="3"
                        variant="solid"
                        color="indigo"
                        disabled={loading || !repo.trim() || isLoading}
                        onClick={scan}
                        style={{
                          borderRadius: 12,
                          cursor: loading || !repo.trim() || isLoading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {loading ? (
                          <Flex align="center" gap="2" justify="center">
                            <Spinner />
                            Scanning…
                          </Flex>
                        ) : (
                          'Scan'
                        )}
                      </Button>
                    </Flex>
                  </Card>

                  {error ? (
                    <Callout.Root color="red" role="alert" style={{ width: '100%', maxWidth: 520 }}>
                      <Callout.Text>{error}</Callout.Text>
                    </Callout.Root>
                  ) : null}

                  {scanned ? (
                    <Flex direction="column" gap="4" style={{ width: '100%', maxWidth: 880 }}>
                      {scanMode === 'explain' ? (
                        scanExplanation || scanVisualExplanation ? (
                          <Box className="dw-explain-card">
                            <Text size="2" weight="bold" highContrast mb="3">
                              Repository overview
                            </Text>
                            {scanVisualExplanation ? (
                              <Box mb="3" className="dw-visual-frame">
                                <img
                                  src={`data:${scanVisualExplanation.mimeType};base64,${scanVisualExplanation.dataBase64}`}
                                  alt="Visual summary of the repository generated by Gemini"
                                  style={{
                                    width: '100%',
                                    height: 'auto',
                                    display: 'block',
                                    verticalAlign: 'top',
                                  }}
                                />
                              </Box>
                            ) : null}
                            {scanExplanation ? (
                              <MarkdownExplanation
                                markdown={scanExplanation}
                                isDark={appearance === 'dark'}
                              />
                            ) : null}
                          </Box>
                        ) : (
                          <Callout.Root color="gray" style={{ width: '100%' }}>
                            <Callout.Text>
                              No overview text was returned. Try again in a moment.
                            </Callout.Text>
                          </Callout.Root>
                        )
                      ) : null}

                      {scanMode === 'scan' && findings.length === 0 ? (
                        <Callout.Root color="green" style={{ width: '100%' }}>
                          <Callout.Text>
                            <Text weight="bold" highContrast as="span" mr="2">
                              No real credentials found
                            </Text>
                            <Text color="gray" as="span">
                              Devil&apos;s Advocate filtered all findings as false positives.
                            </Text>
                          </Callout.Text>
                        </Callout.Root>
                      ) : null}

                      {scanMode === 'scan' && findings.length > 0 ? (
                        <>
                          <Card size="3" variant="surface">
                            <Flex direction="column" gap="4">
                              <Flex justify="between" align="start" wrap="wrap" gap="3">
                                <Flex direction="column" gap="1" align="start">
                                  <Text size="4" weight="bold" highContrast>
                                    Scan complete
                                  </Text>
                                  <Text size="2" color="gray">
                                    {findings.length} real finding{findings.length !== 1 ? 's' : ''}{' '}
                                    after Devil&apos;s Advocate review
                                  </Text>
                                </Flex>
                                <Badge size="2" color="cyan" variant="solid" highContrast>
                                  {findings.length}
                                </Badge>
                              </Flex>
                              <Separator size="4" />
                              <Grid columns={{ initial: '2', sm: '4' }} gap="4" width="100%">
                                <SeverityCount label="Critical" count={counts.CRITICAL} accent="red" />
                                <SeverityCount label="High" count={counts.HIGH} accent="orange" />
                                <SeverityCount label="Medium" count={counts.MEDIUM} accent="yellow" />
                                <SeverityCount label="Low" count={counts.LOW} accent="gray" />
                              </Grid>
                            </Flex>
                          </Card>

                          <Flex direction="column" gap="3" width="100%">
                            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).flatMap((sev) =>
                              findings
                                .filter((f) => f.severity === sev)
                                .map((f, i) => <FindingCard key={`${sev}-${i}`} finding={f} />),
                            )}
                          </Flex>
                        </>
                      ) : null}
                    </Flex>
                  ) : null}
                </Flex>
              ) : null}

              {mainTab === 'analytics' ? (
                <Flex direction="column" gap="4" align="stretch" width="100%">
                  <Card size="3" variant="surface">
                    <Flex direction="column" gap="4">
                      <Flex justify="between" align="center" wrap="wrap" gap="3">
                        <Flex direction="column" gap="1" align="start">
                          <Text size="4" weight="bold" highContrast>
                            Analytics
                          </Text>
                          <Text size="2" color="gray">
                            Totals across saved scans on this browser ({analyticsTotals.scans} scan
                            {analyticsTotals.scans !== 1 ? 's' : ''})
                          </Text>
                        </Flex>
                      </Flex>
                      <Separator size="4" />
                      <Grid columns={{ initial: '2', sm: '4' }} gap="4" width="100%">
                        <SeverityCount
                          label="Critical (total)"
                          count={analyticsTotals.critical}
                          accent="red"
                        />
                        <SeverityCount
                          label="High (total)"
                          count={analyticsTotals.high}
                          accent="orange"
                        />
                        <SeverityCount
                          label="Medium (total)"
                          count={analyticsTotals.medium}
                          accent="yellow"
                        />
                        <SeverityCount label="Low (total)" count={analyticsTotals.low} accent="gray" />
                      </Grid>
                      <Separator size="4" />
                      <Grid columns={{ initial: '1', sm: '2' }} gap="4">
                        <Card size="1" variant="surface">
                          <Text size="2" weight="medium" highContrast mb="2">
                            Severity distribution
                          </Text>
                          <MiniBarChart
                            rows={[
                              { label: 'Critical', value: analyticsTotals.critical, color: 'var(--red-9)' },
                              { label: 'High', value: analyticsTotals.high, color: 'var(--orange-9)' },
                              { label: 'Medium', value: analyticsTotals.medium, color: 'var(--yellow-9)' },
                              { label: 'Low', value: analyticsTotals.low, color: 'var(--gray-9)' },
                            ]}
                          />
                        </Card>
                        <Card size="1" variant="surface">
                          <Text size="2" weight="medium" highContrast mb="2">
                            Average findings per scan
                          </Text>
                          <MiniBarChart
                            rows={avgBySeverity.map((p, idx) => ({
                              label: p.label,
                              value: p.value,
                              color:
                                idx === 0
                                  ? 'var(--red-9)'
                                  : idx === 1
                                    ? 'var(--orange-9)'
                                    : idx === 2
                                      ? 'var(--yellow-9)'
                                      : 'var(--gray-9)',
                            }))}
                          />
                        </Card>
                      </Grid>
                      <Card size="1" variant="surface">
                        <Text size="2" weight="medium" highContrast mb="2">
                          Severity level by vulnerability type
                        </Text>
                        <Text size="1" color="gray" mb="2">
                          X-axis: finding name · Y-axis: level (1=low … 4=critical), highest seen across
                          your saved scans.
                        </Text>
                        <VulnerabilitySeverityLineChart
                          points={vulnerabilitySeverityLinePoints}
                          color="var(--cyan-9)"
                        />
                      </Card>
                    </Flex>
                  </Card>
                </Flex>
              ) : null}

              {mainTab === 'history' ? (
                <Flex direction="column" gap="4" align="stretch" width="100%">
                  {scanHistory.length === 0 ? (
                    <Callout.Root color="gray">
                      <Callout.Text>
                        Run a repo scan on the <strong>Scan</strong> tab. Each result is stored here for
                        trend-style analytics (local only).
                      </Callout.Text>
                    </Callout.Root>
                  ) : (
                    <Card size="2" variant="surface">
                      <Flex justify="between" align="center" wrap="wrap" gap="3" mb="3">
                        <Text size="2" weight="bold" highContrast>
                          Recent scans
                        </Text>
                        <Button
                          size="2"
                          variant="soft"
                          color="red"
                          onClick={() => {
                            setScanHistory([]);
                            saveScanHistory([]);
                          }}
                        >
                          Clear history
                        </Button>
                      </Flex>
                      <Flex direction="column" gap="2">
                        {scanHistory.slice(0, 25).map((r) => (
                          <Flex
                            key={r.id}
                            justify="between"
                            align="center"
                            wrap="wrap"
                            gap="2"
                            py="2"
                            style={{ borderBottom: '1px solid var(--gray-a5)' }}
                          >
                            <Text size="2" weight="medium" highContrast style={{ fontFamily: 'var(--code-font-family, ui-monospace)' }}>
                              {r.repo}
                            </Text>
                            <Flex gap="2" wrap="wrap" align="center">
                              <Badge color="red" variant="soft" size="1">
                                C {r.critical}
                              </Badge>
                              <Badge color="orange" variant="soft" size="1">
                                H {r.high}
                              </Badge>
                              <Text size="1" color="gray">
                                {new Date(r.at).toLocaleString()}
                              </Text>
                            </Flex>
                          </Flex>
                        ))}
                      </Flex>
                    </Card>
                  )}
                </Flex>
              ) : null}
            </div>
          </main>
        </div>
      </Box>
      )}
    </Theme>
  );
}
