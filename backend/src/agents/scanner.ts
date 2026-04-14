import '../env.js';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Octokit } from '@octokit/rest';
import { glob } from 'glob';
import {
  gatherFindingsForFileContent,
  MAX_SCAN_FILE_BYTES,
  type RawFinding,
} from './patternScan.js';
import { isAllowedScanExtension } from '../upload/allowedExtensions.js';
import { MAX_FILES_IN_ARCHIVE } from '../upload/limits.js';
import { geminiReasoningText, geminiRepoInfographicStream } from '../utils/gemini.js';
import { enrichFindingsWithSuggestedFixes } from '../utils/geminiSuggestedFixes.js';

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

/** Scan a local directory tree (uploaded zip/folder), same modes as GitHub. */
export async function scanUploadWorkspace(
  rootDir: string,
  options?: { userQuery?: string },
): Promise<ScanResponse> {
  const abs = path.resolve(rootDir);
  const route = inferMode(options?.userQuery);
  if (route === 'explain') {
    const { explanation, visualExplanation } = await explainLocalProject(abs, options?.userQuery ?? '');
    return {
      mode: 'explain',
      findings: [],
      explanation,
      ...(visualExplanation ? { visualExplanation } : {}),
    };
  }
  const findings = await runLocalCredentialScan(abs, options?.userQuery);
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

async function explainLocalProject(
  rootDir: string,
  userQuery: string,
): Promise<{
  explanation: string;
  visualExplanation?: { mimeType: string; dataBase64: string };
}> {
  const label = path.basename(rootDir);
  let readmeSnippet = '';
  for (const name of ['README.md', 'README', 'readme.md', 'Readme.md']) {
    try {
      const p = path.join(rootDir, name);
      readmeSnippet = await readFile(p, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!readmeSnippet) readmeSnippet = '(No README found in upload.)';
  readmeSnippet = readmeSnippet.slice(0, 14_000);

  let pkgHint = '';
  try {
    const raw = await readFile(path.join(rootDir, 'package.json'), 'utf8');
    pkgHint = raw.slice(0, 4000);
  } catch {
    pkgHint = '';
  }

  const fileList = await glob('**/*', {
    cwd: rootDir,
    nodir: true,
    dot: true,
    ignore: ['**/node_modules/**'],
  });
  const topDirs = [...new Set(fileList.map((f) => f.split(/[/\\]/)[0]).filter(Boolean))].slice(0, 24);

  const prompt = `You help a developer understand a **local codebase** uploaded for review (not necessarily on GitHub).

Project folder: ${label}
Detected top-level paths (sample): ${topDirs.join(', ') || 'n/a'}
${pkgHint ? `\npackage.json (truncated):\n${pkgHint}\n` : ''}

README (truncated):
${readmeSnippet}

User request: ${userQuery.trim() || 'Give a clear overview of what this project does, suggested architecture/workflow in Markdown, and security considerations.'}

Respond in Markdown with sections:
## Overview
## Architecture & workflows (use mermaid code fences for 1–2 diagrams where helpful)
## Security / credentials angle
## Suggested next steps
Keep it structured and practical.`;

  const infographicPrompt = `You create one high-impact infographic for software developers: clean sans-serif typography, strong visual hierarchy, generous whitespace, readable labels.

Local project folder: ${label}
README (ground truth):
${readmeSnippet.slice(0, 8000)}

User request: ${userQuery.trim() || 'Explain this codebase and visualize workflows and structure.'}

Generate exactly ONE polished landscape infographic summarizing purpose, main structure, and workflows. Stay faithful to README and listed files; do not invent features.`;

  const [explanation, infographicOutcome] = await Promise.all([
    geminiReasoningText(prompt, { maxTokens: 8192 }),
    geminiRepoInfographicStream(infographicPrompt).catch((e) => {
      console.warn(
        '[explain local] infographic:',
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

async function githubFileContentsMap(
  octokit: Octokit,
  owner: string,
  repo: string,
  paths: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(paths)];
  for (const filePath of unique) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
      });
      if (Array.isArray(data) || !('content' in data)) continue;
      if (data.encoding !== 'base64' || !data.content) continue;
      const buf = Buffer.from(data.content, 'base64');
      if (buf.length > MAX_SCAN_FILE_BYTES) continue;
      map.set(filePath, buf.toString('utf8'));
    } catch {
      continue;
    }
  }
  return map;
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

      if ((blob.size ?? 0) > MAX_SCAN_FILE_BYTES) continue;
      const content = Buffer.from(blob.content, 'base64').toString('utf-8');
      findings.push(...gatherFindingsForFileContent(file.path, content));
    } catch {
      continue;
    }
  }

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

  let reviewed = await devilsAdvocate(findings as Record<string, unknown>[]);
  const q = userQuery?.trim().toLowerCase() ?? '';
  if (q && /\bcritical\b|\bhigh\b|\bvulnerabilit|\bexploit\b|\brce\b/i.test(q)) {
    reviewed = reviewed.filter(
      (f: { severity?: string }) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
    );
  }

  const paths = (reviewed as { file: string }[]).map((f) => f.file);
  const contentMap = await githubFileContentsMap(octokit, owner, repo, paths);
  reviewed = await enrichFindingsWithSuggestedFixes(reviewed as Record<string, unknown>[], contentMap);

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
  return reviewed;
}

async function localFileContentsMap(
  rootDir: string,
  paths: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const rel of new Set(paths)) {
    const safe = rel.replace(/\\/g, '/');
    const abs = path.join(rootDir, safe);
    if (!abs.startsWith(path.resolve(rootDir))) continue;
    try {
      const buf = await readFile(abs);
      if (buf.length > MAX_SCAN_FILE_BYTES) continue;
      map.set(safe, buf.toString('utf8'));
    } catch {
      continue;
    }
  }
  return map;
}

async function runLocalCredentialScan(rootDir: string, userQuery?: string): Promise<unknown[]> {
  const abs = path.resolve(rootDir);
  const findings: RawFinding[] = [];

  const files = await glob('**/*', {
    cwd: abs,
    nodir: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/.git/**'],
  });

  let seenFiles = 0;
  for (const rel of files) {
    const posixRel = rel.split(path.sep).join('/');
    if (!isAllowedScanExtension(posixRel)) continue;
    const full = path.join(abs, rel);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_SCAN_FILE_BYTES) continue;
    let content: string;
    try {
      content = await readFile(full, 'utf8');
    } catch {
      continue;
    }
    findings.push(...gatherFindingsForFileContent(posixRel, content));
    seenFiles += 1;
    if (seenFiles >= MAX_FILES_IN_ARCHIVE) break;
  }

  let reviewed = await devilsAdvocate(findings as Record<string, unknown>[]);
  const q = userQuery?.trim().toLowerCase() ?? '';
  if (q && /\bcritical\b|\bhigh\b|\bvulnerabilit|\bexploit\b|\brce\b/i.test(q)) {
    reviewed = reviewed.filter(
      (f: { severity?: string }) => f.severity === 'CRITICAL' || f.severity === 'HIGH',
    );
  }
  const paths = (reviewed as { file: string }[]).map((f) => f.file);
  const contentMap = await localFileContentsMap(abs, paths);
  return enrichFindingsWithSuggestedFixes(reviewed as Record<string, unknown>[], contentMap);
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
