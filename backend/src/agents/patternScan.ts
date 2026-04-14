/** Shared regex scan over a single file’s text (GitHub tree or local upload). */

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM';
export type FindingCategory =
  | 'Secrets'
  | 'Injection'
  | 'XSS'
  | 'Command Execution'
  | 'Crypto'
  | 'Auth'
  | 'Deserialization'
  | 'Config'
  | 'Dependency';

export type RawFinding = {
  type: string;
  category: FindingCategory;
  severity: FindingSeverity;
  file: string;
  line: number;
  match: string;
  context: string;
};

export const SECRET_PATTERNS: { name: string; regex: RegExp; severity: FindingSeverity }[] = [
  { name: 'Slack token', regex: /xox[bpsa]-[0-9A-Za-z\-]{10,48}/g, severity: 'CRITICAL' },
  { name: 'GitHub PAT', regex: /ghp_[A-Za-z0-9]{36}/g, severity: 'CRITICAL' },
  {
    name: 'GitHub OAuth / fine-grained token',
    regex: /\bgho_[A-Za-z0-9_]{36,}\b|\bghu_[A-Za-z0-9_]{36,}\b|\bghs_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    severity: 'CRITICAL',
  },
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

export const VULN_PATTERNS: {
  name: string;
  regex: RegExp;
  severity: FindingSeverity;
  category: FindingCategory;
}[] = [
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

const AUTH_TODO_KEYWORDS =
  /(oauth|credential|secret|password|jwt|bearer|rotate|client_secret|access_token|refresh_token|api[_-]?key|apikey|authorization|\bpat\b|\bauth\b|\btoken\b)/i;

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

/** Max bytes read per file (aligned with GitHub blob scan). */
export const MAX_SCAN_FILE_BYTES = 350_000;

export function gatherFindingsForFileContent(filePath: string, content: string): RawFinding[] {
  const findings: RawFinding[] = [];
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
        file: filePath,
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
        file: filePath,
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
      file: filePath,
      line: lineNum,
      match: lineText.trim().slice(0, 80),
      context: lineText,
    });
  });

  return findings;
}
