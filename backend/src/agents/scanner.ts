import '../env.js';
import { Octokit } from '@octokit/rest';
import { geminiReasoningText, geminiRepoInfographicStream } from '../utils/gemini.js';

type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
type FindingCategory =
  | 'Secrets'
  | 'Injection'
  | 'XSS'
  | 'Command Execution'
  | 'Crypto'
  | 'Auth'
  | 'Deserialization'
  | 'Config'
  | 'Dependency';

type RawFinding = {
  type: string;
  category: FindingCategory;
  severity: FindingSeverity;
  file: string;
  line: number;
  match: string;
  context: string;
};

// Secret patterns (generic — no path or repo-specific strings)
const SECRET_PATTERNS: { name: string; regex: RegExp; severity: FindingSeverity }[] = [
  { name: 'Slack token', regex: /xox[bpsa]-[0-9A-Za-z\-]{10,48}/g, severity: 'CRITICAL' },
  { name: 'GitHub PAT', regex: /ghp_[A-Za-z0-9]{36}/g, severity: 'CRITICAL' },
  { name: 'GitHub OAuth / fine-grained token', regex: /\bgho_[A-Za-z0-9_]{36,}\b|\bghu_[A-Za-z0-9_]{36,}\b|\bghs_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, severity: 'CRITICAL' },
  { name: 'OpenAI key', regex: /sk-[a-zA-Z0-9]{48}/g, severity: 'CRITICAL' },
  { name: 'AWS key', regex: /AKIA[0-9A-Z]{16}/g, severity: 'CRITICAL' },
  {
    name: 'OAuth client_secret in config',
    regex: /["']client_secret["']\s*:\s*["']([^"'\\\n]{12,})["']/gi,
    severity: 'HIGH',
  },
  {
    name: 'Generic high-entropy secret value',
    regex: /["'](secret|client_secret|api_secret|password|api_key|access_token|refresh_token)["']\s*:\s*["']([^"'\\\n]{16,})["']/gi,
    severity: 'HIGH',
  },
  {
    name: 'Generic secret assignment',
    regex: /["'](secret|token|password|api_key)["']\s*[:=]\s*["']([A-Za-z0-9+/=_-]{16,})["']/gi,
    severity: 'HIGH',
  },
];

const VULN_PATTERNS: { name: string; regex: RegExp; severity: FindingSeverity; category: FindingCategory }[] = [
  {
    name: 'Potential SQL injection (raw concatenated query)',
    regex: /\b(select|update|insert|delete)\b[\s\S]{0,120}(\+|\$\{|\breq\.(query|params|body)\b)/gi,
    severity: 'CRITICAL',
    category: 'Injection',
  },
  {
    name: 'Potential reflected/stored XSS sink',
    regex: /\b(innerHTML|outerHTML|document\.write)\b[\s\S]{0,120}(req\.(query|params|body)|location\.search|\+)/gi,
    severity: 'HIGH',
    category: 'XSS',
  },
  {
    name: 'Command execution with dynamic input',
    regex: /\b(exec|execSync|spawn|spawnSync)\s*\([\s\S]{0,120}(\+|\$\{|req\.(query|params|body))/gi,
    severity: 'CRITICAL',
    category: 'Command Execution',
  },
  {
    name: 'Unsafe deserialization/load',
    regex: /\b(pickle\.loads|yaml\.load\(|java\.io\.ObjectInputStream|BinaryFormatter)\b/gi,
    severity: 'HIGH',
    category: 'Deserialization',
  },
  {
    name: 'Weak crypto hash/signature',
    regex: /\b(md5|sha1)\b/gi,
    severity: 'MEDIUM',
    category: 'Crypto',
  },
  {
    name: 'Insecure JWT/crypto verification option',
    regex: /\b(jwt\.verify|verify)\b[\s\S]{0,100}(ignoreExpiration|none|allowInsecureKeySizes)/gi,
    severity: 'HIGH',
    category: 'Auth',
  },
  {
    name: 'Permissive CORS + credentials',
    regex: /\bcors\s*\([\s\S]{0,180}(origin\s*:\s*['"`]\*['"`]|origin\s*:\s*true)[\s\S]{0,120}credentials\s*:\s*true/gi,
    severity: 'HIGH',
    category: 'Config',
  },
  {
    name: 'Known vulnerability note in docs/readme',
    regex: /\b(sql injection|cross[\s-]?site scripting|xss|command injection|rce|path traversal)\b/gi,
    severity: 'HIGH',
    category: 'Dependency',
  },
];

/** Security-related TODOs (avoid bare "key" → false positives like "monkey") */
const AUTH_TODO_KEYWORDS =
  /(oauth|credential|secret|password|jwt|bearer|rotate|client_secret|access_token|refresh_token|api[_-]?key|apikey|authorization|\bpat\b|\bauth\b|\btoken\b)/i;

function inferMode(userQuery: string | undefined): 'explain' | 'security' {
  const q = (userQuery ?? '').trim().toLowerCase();
  if (!q) return 'security';
  if (
    /\b(explain only|overview only|readme summary|architecture summary)\b/i.test(q) ||
    /\b(visualize|infographic|diagram)\b/i.test(q) ||
    /\bexplain\b.*\b(repo|repository|codebase|project)\b/i.test(q) ||
    /\b(repo|repository)\b.*\b(explain|overview|summary|describe)\b/i.test(q) ||
    /\b(what is this repo|what does this repo|tell me about (this |the )?repo)\b/i.test(q)
  ) {
    return 'explain';
  }
  return 'security';
}

/** JS/TS/C-style // TODO and Python/shell # TODO */
function lineHasAuthTodo(line: string): boolean {
  const trimmed = line.trim();
  const todo =
    /^\s*\/\/\s*TODO\b/i.test(line) ||
    /^#\s*TODO\b/i.test(trimmed) ||
    /\bTODO\b/i.test(line);
  return todo && AUTH_TODO_KEYWORDS.test(line);
}

function lineIndexContaining(lines: string[], needle: string): number {
  const i = lines.findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : 1;
}

export type ScanResponse =
  | { mode: 'scan'; findings: unknown[] }
  | {
      mode: 'explain';
      findings: [];
      explanation: string;
      visualExplanation?: { mimeType: string; dataBase64: string };
    };

function toRepoParts(input: string): { owner: string; repo: string } {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Invalid repo: expected "owner/repo" or GitHub repository URL');
  }
  const noGit = raw.replace(/\.git$/i, '');
  const fromUrl = noGit.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)$/i);
  if (fromUrl?.[1] && fromUrl?.[2]) {
    return { owner: fromUrl[1], repo: fromUrl[2] };
  }
  const compact = noGit.replace(/\s+/g, '/').replace(/\/+/g, '/');
  const [owner, repo] = compact.split('/');
  if (!owner || !repo) {
    throw new Error('Invalid repo: expected "owner/repo" or GitHub repository URL');
  }
  return { owner, repo };
}

function getOctokit(githubToken?: string): Octokit {
  const token = githubToken?.trim() || process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  return token ? new Octokit({ auth: token }) : new Octokit();
}

export async function scanRepository(
  repoFullName: string,
  githubToken: string | undefined,
  options?: { userQuery?: string },
): Promise<ScanResponse> {
  const route = inferMode(options?.userQuery);
  if (route === 'explain') {
    const { explanation, visualExplanation } = await explainRepository(
      repoFullName,
      githubToken,
      options?.userQuery ?? '',
    );
    return {
      mode: 'explain',
      findings: [],
      explanation,
      ...(visualExplanation ? { visualExplanation } : {}),
    };
  }
  const findings = await runCredentialScan(repoFullName, githubToken, options?.userQuery);
  return { mode: 'scan', findings };
}

async function explainRepository(
  repoFullName: string,
  githubToken: string | undefined,
  userQuery: string,
): Promise<{
  explanation: string;
  visualExplanation?: { mimeType: string; dataBase64: string };
}> {
  const octokit = getOctokit(githubToken);
  const { owner, repo } = toRepoParts(repoFullName);

  const { data: meta } = await octokit.rest.repos.get({ owner, repo });
  let readmeSnippet = '';
  try {
    const { data } = await octokit.rest.repos.getReadme({
      owner,
      repo,
      mediaType: { format: 'raw' },
    });
    readmeSnippet = typeof data === 'string' ? data : String(data);
  } catch {
    readmeSnippet = '(No README found.)';
  }
  readmeSnippet = readmeSnippet.slice(0, 14_000);

  const prompt = `You help a developer understand a GitHub repository.

Repository: ${owner}/${repo}
Description: ${meta.description ?? 'none'}
Default branch: ${meta.default_branch}
Language: ${meta.language ?? 'unknown'}
Topics: ${(meta.topics ?? []).join(', ') || 'none'}

README (truncated):
${readmeSnippet}

User request: ${userQuery.trim() || 'Give a clear overview of what this repo does and how it is organized.'}

Respond in Markdown with sections:
## Overview
## Main parts of the codebase
## Security / credentials angle (what to watch for)
## Suggested next steps for a new contributor
Keep it concise and practical.`;

  const infographicPrompt = `You create one high-impact infographic for software developers: clean sans-serif typography, strong visual hierarchy, generous whitespace, readable labels.

Repository: ${owner}/${repo}
URL: https://github.com/${owner}/${repo}
Description: ${meta.description ?? 'none'}
Default branch: ${meta.default_branch}
Primary language: ${meta.language ?? 'unknown'}
Topics: ${(meta.topics ?? []).join(', ') || 'none'}

README (ground truth — stay faithful; do not invent features not implied here):
${readmeSnippet.slice(0, 8000)}

User request: ${userQuery.trim() || 'Explain this repository and visualize your explanation.'}

Generate exactly ONE polished landscape infographic that summarizes purpose, main structure or capabilities, and key takeaways. Use simple icons or diagrams where helpful. The image should feel like a professional one-pager a team would share.

You may include brief supporting text in the model response, but the infographic image should carry the main visual story. If search helps confirm public facts, use it; prioritize README and metadata.`;

  const [explanation, infographicOutcome] = await Promise.all([
    geminiReasoningText(prompt, { maxTokens: 8192 }),
    geminiRepoInfographicStream(infographicPrompt).catch((e) => {
      console.warn(
        '[explain] infographic:',
        e instanceof Error ? e.message : String(e),
      );
      return { text: '', image: null };
    }),
  ]);

  if (!infographicOutcome.image) {
    return { explanation };
  }
  return {
    explanation,
    visualExplanation: {
      mimeType: infographicOutcome.image.mimeType,
      dataBase64: infographicOutcome.image.dataBase64,
    },
  };
}

async function runCredentialScan(
  repoFullName: string,
  githubToken: string | undefined,
  userQuery?: string,
): Promise<unknown[]> {
  const octokit = getOctokit(githubToken);
  const { owner, repo } = toRepoParts(repoFullName);

  const findings: RawFinding[] = [];

  const { data: repoMeta } = await octokit.rest.repos.get({ owner, repo });
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${repoMeta.default_branch}`,
  });
  const commitSha = ref.object.sha;

  const { data: tree } = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: commitSha,
    recursive: 'true',
  });

  for (const file of tree.tree) {
    if (
      !file.path?.match(
        /\.(ts|tsx|js|jsx|mjs|cjs|py|env|json|yaml|yml|toml|properties|java|go|rb|php|cs|cpp|c|h|sh|ini|cfg|xml|md)$/i,
      ) ||
      !file.sha
    ) {
      continue;
    }

    try {
      const { data: blob } = await octokit.rest.git.getBlob({
        owner,
        repo,
        file_sha: file.sha,
      });

      if ((blob.size ?? 0) > 350_000) continue;
      const content = Buffer.from(blob.content, 'base64').toString('utf-8');
      const lines = content.split('\n');

      for (const pattern of SECRET_PATTERNS) {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((m = re.exec(content)) !== null) {
          const full = m[0];
          const lineNum = lineIndexContaining(lines, full);
          const dedupeKey = `${lineNum}:${full}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const ctxStart = Math.max(0, lineNum - 3);
          const ctxEnd = Math.min(lines.length, lineNum + 2);
          const context = lines.slice(ctxStart, ctxEnd).join('\n');

          findings.push({
            type: pattern.name,
            category: 'Secrets',
            severity: pattern.severity,
            file: file.path,
            line: lineNum,
            match: full.length > 48 ? `${full.slice(0, 48)}…` : full,
            context,
          });
        }
      }

      for (const pattern of VULN_PATTERNS) {
        const re = new RegExp(pattern.regex.source, pattern.regex.flags);
        let m: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((m = re.exec(content)) !== null) {
          const full = m[0];
          const lineNum = lineIndexContaining(lines, full);
          const dedupeKey = `${lineNum}:${full}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const ctxStart = Math.max(0, lineNum - 3);
          const ctxEnd = Math.min(lines.length, lineNum + 2);
          const context = lines.slice(ctxStart, ctxEnd).join('\n');

          findings.push({
            type: pattern.name,
            category: pattern.category,
            severity: pattern.severity,
            file: file.path,
            line: lineNum,
            match: full.length > 64 ? `${full.slice(0, 64)}…` : full,
            context,
          });
        }
      }

      lines.forEach((lineText, idx) => {
        if (!lineHasAuthTodo(lineText)) return;
        const lineNum = idx + 1;
        findings.push({
          type: 'Auth TODO',
          category: 'Auth',
          severity: 'MEDIUM',
          file: file.path,
          line: lineNum,
          match: lineText.trim().slice(0, 80),
          context: lineText,
        });
      });
    } catch {
      continue;
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '1623b3' },
    body: JSON.stringify({
      sessionId: '1623b3',
      hypothesisId: 'H_scanner_signal_strength',
      location: 'scanner.ts:runCredentialScan:preReview',
      message: 'Raw findings before model triage',
      data: { rawFindings: findings.length, repo: `${owner}/${repo}` },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  let reviewed = await devilsAdvocate(findings as Record<string, unknown>[]);
  const q = userQuery?.trim().toLowerCase() ?? '';
  if (q && /\bcritical\b|\bhigh\b|\bvulnerabilit|\bexploit\b|\brce\b/i.test(q)) {
    reviewed = reviewed.filter(
      (f: { severity?: string }) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
    );
  }
  // #region agent log
  fetch('http://127.0.0.1:7739/ingest/aa9c7ad1-d90c-453c-ae07-9977acb5e540', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '1623b3' },
    body: JSON.stringify({
      sessionId: '1623b3',
      hypothesisId: 'H_scanner_signal_strength',
      location: 'scanner.ts:runCredentialScan:postReview',
      message: 'Final findings after model triage',
      data: { finalFindings: reviewed.length, queryFiltered: Boolean(q) },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  return reviewed;
}

function extractJsonArray(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  return t.trim();
}

async function devilsAdvocate(findings: Record<string, unknown>[]) {
  if (findings.length === 0) return [];

  const raw = await geminiReasoningText(
    `You review static-analysis security findings. For each item, add "verdict": "REAL" or "FALSE_POSITIVE" and a short "reason".

FALSE_POSITIVE only when the **matched secret/value** is clearly a non-credential placeholder: e.g. YOUR_KEY_HERE, changeme, xxx, <redacted>, example.com samples, or obviously fake low-entropy strings.

REAL when the match has real credential shape (prefixes like xoxb-, ghp_, gho_, length/entropy) **even in tests/, fixtures/, or sample files** — those often hold synthetic bad examples on purpose and scanners should still flag them.

For vulnerability categories (Injection/XSS/Command Execution/Deserialization/Auth/Crypto/Config/Dependency): mark REAL when code indicates a dangerous sink/pattern or explicit known-vulnerability statements in repository docs.
FALSE_POSITIVE only if clearly safe or unrelated.

For type "Auth TODO": REAL if the TODO mentions secrets, tokens, OAuth, rotation, credentials, PATs, JWT, or auth work. FALSE_POSITIVE only if the TODO is unrelated to security (e.g. generic refactor with no auth context).

Findings: ${JSON.stringify(findings, null, 2)}

Return ONLY a JSON array (same objects, plus verdict and reason on each). No markdown, no commentary.`,
    { maxTokens: 8192 },
  );

  try {
    const parsed = JSON.parse(extractJsonArray(raw));
    if (!Array.isArray(parsed)) return findings;
    return parsed.filter((f: { verdict?: string }) => f.verdict === 'REAL');
  } catch {
    return findings;
  }
}
