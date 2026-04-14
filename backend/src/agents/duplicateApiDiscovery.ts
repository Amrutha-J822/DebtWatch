import { geminiReasoningText } from '../utils/gemini.js';
import type { RawFinding } from './patternScan.js';
import type { ExtractedRoute } from './routeExtraction.js';

const MAX_ROUTES_FOR_LLM = 200;
const MAX_SEMANTIC_GROUPS = 12;

function extractJsonArray(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  return t.trim();
}

function mechanicalDuplicateFindings(routes: ExtractedRoute[]): RawFinding[] {
  const byKey = new Map<string, ExtractedRoute[]>();
  for (const r of routes) {
    const k = `${r.method}::${r.path}`;
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }

  const out: RawFinding[] = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const locs = new Set(group.map((g) => `${g.file}:${g.line}`));
    if (locs.size < 2) continue;

    const primary = group[0]!;
    const involvedFiles = [...new Set(group.map((g) => g.file))];
    const lines = group
      .map((g) => `${g.method} ${g.path} — ${g.file}:${g.line}`)
      .join('\n');
    out.push({
      type: 'Identical HTTP route registered more than once',
      category: 'Architecture',
      severity: 'MEDIUM',
      file: primary.file,
      line: primary.line,
      match: `${primary.method} ${primary.path} (${group.length} registrations)`,
      context: lines,
      involvedFiles,
    });
  }
  return out;
}

function sampleRoutesForSemantic(routes: ExtractedRoute[], max: number): ExtractedRoute[] {
  if (routes.length <= max) return routes;
  const priority = (f: string) => {
    const s = f.toLowerCase();
    if (/\/(routes?|api|controllers?|handlers?)\//.test(s)) return 0;
    if (/\b(api|server|route|controller)\b/.test(s)) return 1;
    return 2;
  };
  const sorted = [...routes].sort((a, b) => {
    const pa = priority(a.file) - priority(b.file);
    if (pa !== 0) return pa;
    return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
  });
  return sorted.slice(0, max);
}

type SemanticGroup = {
  summary: string;
  endpoints: { method: string; path: string; file: string; line: number }[];
  confidence?: string;
};

async function semanticDuplicateFindings(routes: ExtractedRoute[]): Promise<RawFinding[]> {
  if (routes.length < 3) return [];

  const sampled = sampleRoutesForSemantic(routes, MAX_ROUTES_FOR_LLM);
  const payload = sampled.map((r) => ({
    method: r.method,
    path: r.path,
    file: r.file,
    line: r.line,
    snippet: r.snippet,
  }));

  const raw = await geminiReasoningText(
    `You analyze HTTP API route definitions from a codebase (multiple frameworks possible).

Given this JSON array of routes, find groups where **different paths or handlers implement the same business capability** — i.e. redundant duplicate endpoints (not just REST versioning). Ignore identical method+path pairs (those are handled separately).

Rules:
- Each group must have at least 2 endpoints from the list.
- Prefer high-confidence overlaps (same DTOs, same handler names, copy-pasted logic suggested by path names).
- Do NOT group unrelated resources (e.g. /users vs /products) unless they clearly duplicate the same operation.
- Skip groups that only differ by normal REST sub-resources unless you see clear redundancy.

Routes JSON:
${JSON.stringify(payload, null, 2)}

Return ONLY a JSON array (max ${MAX_SEMANTIC_GROUPS} groups). Each element:
{ "summary": "short label", "confidence": "high" | "medium" | "low", "endpoints": [ { "method", "path", "file", "line" } ] }

Use exact file paths and line numbers from the input. Return [] if no semantic duplicates.`,
    { maxTokens: 8192 },
  );

  try {
    const parsed = JSON.parse(extractJsonArray(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RawFinding[] = [];

    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const g = item as SemanticGroup;
      if (!g.summary || !Array.isArray(g.endpoints) || g.endpoints.length < 2) continue;
      const eps = g.endpoints.filter(
        (e) =>
          e &&
          typeof e.method === 'string' &&
          typeof e.path === 'string' &&
          typeof e.file === 'string' &&
          typeof e.line === 'number',
      );
      if (eps.length < 2) continue;

      const primary = eps[0]!;
      const involvedFiles = [...new Set(eps.map((e) => e.file))];
      const conf = (g.confidence ?? 'medium').toLowerCase();
      const sev = conf === 'high' ? 'HIGH' : 'MEDIUM';

      const ctx = eps.map((e) => `${e.method} ${e.path} — ${e.file}:${e.line}`).join('\n');
      out.push({
        type: `Duplicate API behavior: ${g.summary.trim().slice(0, 200)}`,
        category: 'Architecture',
        severity: sev,
        file: primary.file,
        line: primary.line,
        match: eps.map((e) => `${e.method} ${e.path}`).join(' | '),
        context: ctx,
        involvedFiles,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Mechanical (same method + path) and semantic (Gemini) duplicate API findings.
 */
export async function discoverDuplicateApiFindings(routes: ExtractedRoute[]): Promise<RawFinding[]> {
  if (routes.length < 2) return [];

  const mechanical = mechanicalDuplicateFindings(routes);
  let semantic: RawFinding[] = [];
  try {
    semantic = await semanticDuplicateFindings(routes);
  } catch {
    /* Gemini optional; mechanical still useful */
  }

  return [...mechanical, ...semantic];
}
