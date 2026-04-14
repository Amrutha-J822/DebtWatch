import { convert } from 'html-to-text';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { marked } from 'marked';
import pdfMake from 'pdfmake/build/pdfmake.js';
import { ensurePdfMakeVfs } from './explainOverviewExport';

marked.setOptions({ gfm: true, breaks: true });

export const SCAN_RESULTS_FILENAME_PDF = 'filename.pdf';

export type ScanFindingForExport = {
  type: string;
  severity: string;
  category?: string;
  file: string;
  line: number;
  match: string;
  context: string;
  verdict?: string;
  reason?: string;
  suggestedFix?: string;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdownToHtmlFragment(markdown: string): string {
  const out = marked.parse(markdown, { async: false });
  return typeof out === 'string' ? out : '';
}

function htmlToPdfText(html: string): string {
  return convert(html, {
    wordwrap: false,
    preserveNewlines: true,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  });
}

function severitySortKey(s: string): number {
  switch (s) {
    case 'CRITICAL':
      return 0;
    case 'HIGH':
      return 1;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 3;
    default:
      return 4;
  }
}

function sortedFindings(list: ScanFindingForExport[]): ScanFindingForExport[] {
  return [...list].sort((a, b) => {
    const d = severitySortKey(a.severity) - severitySortKey(b.severity);
    if (d !== 0) return d;
    return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
  });
}

export function buildScanResultsDocumentHtml(options: {
  targetLabel: string;
  findings: ScanFindingForExport[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
}): string {
  const { targetLabel, findings, summary } = options;
  const rows = sortedFindings(findings);
  const blocks = rows.map((f, i) => {
    const fixHtml = f.suggestedFix?.trim()
      ? `<div class="suggested-fix" style="margin-top:0.75rem;padding:0.75rem;border:1px solid #0891b2;border-radius:6px;background:#ecfeff;">${markdownToHtmlFragment(f.suggestedFix)}</div>`
      : '';
    return `
<section style="margin-bottom:1.5rem;">
  <h2 style="font-size:14pt;margin:0 0 0.35rem 0;">${i + 1}. ${escapeHtml(f.type)} <span style="color:#64748b;font-weight:normal;">(${escapeHtml(f.severity)})</span></h2>
  <p style="margin:0.25rem 0;"><strong>File:</strong> ${escapeHtml(f.file)} — line ${f.line}</p>
  ${f.category ? `<p style="margin:0.25rem 0;"><strong>Category:</strong> ${escapeHtml(f.category)}</p>` : ''}
  <p style="margin:0.25rem 0;"><strong>Match:</strong> <code>${escapeHtml(f.match)}</code></p>
  <p style="margin:0.25rem 0;"><strong>Context:</strong></p>
  <pre style="white-space:pre-wrap;font-family:Consolas,monospace;font-size:10pt;background:#f1f5f9;padding:0.5rem;border-radius:4px;">${escapeHtml(f.context?.trim() ? f.context : '(none)')}</pre>
  ${f.verdict ? `<p style="margin:0.35rem 0;font-style:italic;color:#475569;"><strong>Verdict:</strong> ${escapeHtml(f.verdict)}</p>` : ''}
  ${f.reason ? `<p style="margin:0.35rem 0;font-style:italic;color:#475569;"><strong>Devil&apos;s Advocate:</strong> ${escapeHtml(f.reason)}</p>` : ''}
  ${f.suggestedFix?.trim() ? `<p style="margin:0.5rem 0 0 0;font-weight:bold;">Suggested fix</p>${fixHtml}` : ''}
</section>`;
  });
  return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>DebtWatch — Scan complete</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111;">
<h1 style="margin-top:0;">DebtWatch — Scan complete</h1>
<p><strong>Target:</strong> ${escapeHtml(targetLabel)}</p>
<p>${summary.total} real finding${summary.total !== 1 ? 's' : ''} after Devil&apos;s Advocate review.</p>
<p><strong>Severity:</strong> Critical ${summary.critical} · High ${summary.high} · Medium ${summary.medium} · Low ${summary.low}</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:1rem 0;"/>
${blocks.join('')}
</body></html>`;
}

function buildScanResultsPlainText(options: {
  targetLabel: string;
  findings: ScanFindingForExport[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
}): string {
  const { targetLabel, findings, summary } = options;
  const rows = sortedFindings(findings);
  const header = [
    'DebtWatch — Scan complete',
    '',
    `Target: ${targetLabel}`,
    `${summary.total} real finding${summary.total !== 1 ? 's' : ''} after Devil's Advocate review.`,
    `Severity — Critical: ${summary.critical}, High: ${summary.high}, Medium: ${summary.medium}, Low: ${summary.low}`,
    '',
    '---',
    '',
  ].join('\n');
  const body = rows
    .map((f, i) => {
      const lines = [
        `${i + 1}. ${f.type} (${f.severity})`,
        `   File: ${f.file} — line ${f.line}`,
        f.category ? `   Category: ${f.category}` : '',
        `   Match: ${f.match}`,
        '   Context:',
        f.context?.trim() ? f.context.split('\n').map((l) => `     ${l}`).join('\n') : '     (none)',
        f.verdict ? `   Verdict: ${f.verdict}` : '',
        f.reason ? `   Devil's Advocate: ${f.reason}` : '',
        f.suggestedFix?.trim() ? ['   Suggested fix:', f.suggestedFix].join('\n') : '',
        '',
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n');
  return header + body;
}

export async function copyScanResultsToClipboard(options: {
  targetLabel: string;
  findings: ScanFindingForExport[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
}): Promise<void> {
  const htmlDoc = buildScanResultsDocumentHtml(options);
  const plain = buildScanResultsPlainText(options);
  const htmlBlob = new Blob([htmlDoc], { type: 'text/html' });
  const textBlob = new Blob([plain], { type: 'text/plain' });
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': htmlBlob,
        'text/plain': textBlob,
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plain);
  }
}

export function downloadScanResultsPdf(options: {
  targetLabel: string;
  findings: ScanFindingForExport[];
  summary: { critical: number; high: number; medium: number; low: number; total: number };
}): void {
  ensurePdfMakeVfs();
  const { targetLabel, findings, summary } = options;
  const rows = sortedFindings(findings);

  const content: Content[] = [
    { text: 'Scan complete', style: 'title', margin: [0, 0, 0, 6] },
    { text: `Target: ${targetLabel}`, style: 'meta', margin: [0, 0, 0, 10] },
    {
      text: `${summary.total} real finding${summary.total !== 1 ? 's' : ''} after Devil's Advocate review.`,
      style: 'body',
      margin: [0, 0, 0, 4],
    },
    {
      text: `Critical: ${summary.critical} · High: ${summary.high} · Medium: ${summary.medium} · Low: ${summary.low}`,
      style: 'meta',
      margin: [0, 0, 0, 14],
    },
  ];

  rows.forEach((f, i) => {
    content.push({
      text: `${i + 1}. ${f.type}`,
      style: 'findingTitle',
      margin: [0, 0, 0, 4],
    });
    content.push({
      text: `${f.severity}${f.category ? ` · ${f.category}` : ''}`,
      style: 'meta',
      margin: [0, 0, 0, 6],
    });
    content.push({
      text: `File: ${f.file} — line ${f.line}`,
      style: 'body',
      margin: [0, 0, 0, 4],
    });
    content.push({ text: `Match: ${f.match}`, style: 'body', margin: [0, 0, 0, 4] });
    content.push({
      text: 'Context:',
      style: 'label',
      margin: [0, 0, 0, 2],
    });
    content.push({
      text: f.context?.trim() ? f.context : '(none)',
      style: 'mono',
      margin: [0, 0, 0, 6],
    });
    if (f.verdict?.trim()) {
      content.push({ text: `Verdict: ${f.verdict}`, style: 'italic', margin: [0, 0, 0, 4] });
    }
    if (f.reason?.trim()) {
      content.push({
        text: `Devil's Advocate: ${f.reason}`,
        style: 'italic',
        margin: [0, 0, 0, 6],
      });
    }
    if (f.suggestedFix?.trim()) {
      content.push({ text: 'Suggested fix', style: 'label', margin: [0, 0, 0, 2] });
      const fixHtml = markdownToHtmlFragment(f.suggestedFix);
      const fixText = fixHtml ? htmlToPdfText(fixHtml) : f.suggestedFix;
      content.push({ text: fixText, style: 'body', margin: [0, 0, 0, 12] });
    } else {
      content.push({ text: '', margin: [0, 0, 0, 8] });
    }
  });

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 44],
    info: {
      title: 'Scan complete',
      creator: 'DebtWatch',
    },
    content,
    styles: {
      title: { fontSize: 18, bold: true, color: '#0f172a' },
      meta: { fontSize: 9, color: '#64748b' },
      body: { fontSize: 10, lineHeight: 1.35, alignment: 'left' },
      findingTitle: { fontSize: 12, bold: true, color: '#0f172a' },
      label: { fontSize: 9, bold: true, color: '#475569' },
      mono: { fontSize: 9, lineHeight: 1.3, font: 'Roboto' },
      italic: { fontSize: 9, italics: true, color: '#475569' },
    },
    defaultStyle: {
      font: 'Roboto',
    },
  };

  pdfMake.createPdf(docDefinition).download(SCAN_RESULTS_FILENAME_PDF);
}
