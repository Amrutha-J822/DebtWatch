/** Heuristic extraction of HTTP route definitions for duplicate-endpoint analysis. */

export type ExtractedRoute = {
  method: string;
  path: string;
  file: string;
  line: number;
  snippet: string;
};

function lineAtIndex(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}

function snippetLine(content: string, line: number): string {
  const lines = content.split('\n');
  const row = lines[line - 1];
  if (!row) return '';
  const t = row.trim();
  return t.length > 220 ? `${t.slice(0, 217)}…` : t;
}

const SKIP_PATH = /node_modules|\/dist\/|\/build\/|\/coverage\/|\.next\/|\/vendor\/|\/__tests__\//i;
const SKIP_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i;

export function shouldScanRoutesForFile(filePath: string): boolean {
  if (SKIP_PATH.test(filePath) || SKIP_FILE.test(filePath)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/i.test(filePath);
}

/**
 * Pull likely HTTP routes from source text (Express/Fastify/Nest/Flask/Gin-style).
 * False positives are filtered later by the model pass.
 */
export function extractRoutesFromFileContent(filePath: string, content: string): ExtractedRoute[] {
  if (!shouldScanRoutesForFile(filePath)) return [];

  const out: ExtractedRoute[] = [];
  const seen = new Set<string>();

  const push = (method: string, pathStr: string, index: number) => {
    const p = pathStr.trim();
    if (!p || p.length > 512) return;
    if (/\$\{|`\s*\+/.test(p)) return;
    const line = lineAtIndex(content, index);
    const key = `${line}:${method}:${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      method: method.toUpperCase(),
      path: p,
      file: filePath,
      line,
      snippet: snippetLine(content, line),
    });
  };

  // Express / Fastify / Hapi-style: app.get('/path' or router.post("/path"
  const reExpress =
    /\b(?:app|router|r|api|server|fastify|route)\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`\n]+)['"`]/gi;
  let m: RegExpExecArray | null;
  while ((m = reExpress.exec(content)) !== null) {
    if (m[1] && m[2] && m.index !== undefined) push(m[1], m[2], m.index);
  }

  // NestJS @Get('path')
  const reNest = /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = reNest.exec(content)) !== null) {
    if (m[1] && m[2] && m.index !== undefined) push(m[1], m[2], m.index);
  }

  // FastAPI / Starlette: @router.get("/path"
  const reFastApi = /@(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = reFastApi.exec(content)) !== null) {
    if (m[1] && m[2] && m.index !== undefined) push(m[1], m[2], m.index);
  }

  // Flask: @app.route("/path" — avoid overlapping FastAPI @app.get (handled above)
  const reFlask = /@(?:app|bp|blueprint|router)\.route\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((m = reFlask.exec(content)) !== null) {
    if (m[1] && m.index !== undefined) push('GET', m[1], m.index);
  }

  // Go Gin: r.GET("/path"
  const reGin = /\br\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/gi;
  while ((m = reGin.exec(content)) !== null) {
    if (m[1] && m[2] && m.index !== undefined) push(m[1], m[2], m.index);
  }

  return out;
}

/** Avoid huge route lists on monorepos (mechanical dedupe still works on a capped set). */
export function capExtractedRoutes(routes: ExtractedRoute[], max: number): ExtractedRoute[] {
  if (routes.length <= max) return routes;
  const priority = (f: string) => {
    const s = f.toLowerCase();
    if (/\/(routes?|api|controllers?|handlers?)\//.test(s)) return 0;
    if (/\b(api|server|route|controller)\b/.test(s)) return 1;
    return 2;
  };
  return [...routes]
    .sort((a, b) => {
      const pa = priority(a.file) - priority(b.file);
      if (pa !== 0) return pa;
      return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
    })
    .slice(0, max);
}
