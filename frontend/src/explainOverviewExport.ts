import { convert } from 'html-to-text';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { marked } from 'marked';
// pdfmake browser build + virtual file system for Roboto fonts
import pdfMake from 'pdfmake/build/pdfmake.js';
import pdfVfs from 'pdfmake/build/vfs_fonts.js';

marked.setOptions({ gfm: true, breaks: true });

export const OVERVIEW_FILENAME_PDF = 'filename.pdf';

/** Attach bundled fonts (required for pdfmake in the browser). */
export function ensurePdfMakeVfs(): void {
  const vfs = pdfVfs as unknown as Record<string, string> & { default?: Record<string, string> };
  const fonts = (vfs.default ?? vfs) as Record<string, string>;
  (pdfMake as unknown as { vfs: Record<string, string> }).vfs = fonts;
}

function markdownToHtml(markdown: string): string {
  const out = marked.parse(markdown, { async: false });
  return typeof out === 'string' ? out : '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

export function buildOverviewDocumentHtml(options: {
  title: string;
  markdown: string;
  image?: { mimeType: string; dataBase64: string };
}): string {
  const mdHtml = markdownToHtml(options.markdown);
  const img =
    options.image ?
      `<figure style="margin:0 0 1rem 0;"><img src="data:${options.image.mimeType};base64,${options.image.dataBase64}" alt="Repository overview diagram" style="max-width:100%;height:auto;display:block;" /></figure>`
    : '';
  return `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.45;color:#111;">${img}<div class="markdown-body">${mdHtml}</div></body></html>`;
}

export async function copyRepoOverviewToClipboard(options: {
  markdown: string;
  image?: { mimeType: string; dataBase64: string };
}): Promise<void> {
  const htmlDoc = buildOverviewDocumentHtml({
    title: 'Repository overview',
    markdown: options.markdown,
    image: options.image,
  });
  const plain = [
    options.image ? '[Diagram included when pasting rich HTML into Word, Docs, etc.]\n\n' : '',
    options.markdown,
  ].join('');

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

/**
 * Builds a PDF with pdfmake: embedded infographic (if any) + flowing text from Markdown.
 * Avoids html2canvas/jsPDF raster issues in production builds.
 */
export function downloadRepoOverviewPdf(options: {
  markdown: string;
  image?: { mimeType: string; dataBase64: string };
}): void {
  ensurePdfMakeVfs();

  const html = markdownToHtml(options.markdown || '');
  const bodyText = html ? htmlToPdfText(html) : '(No overview text.)';

  const content: Content[] = [
    { text: 'Repository overview', style: 'title', margin: [0, 0, 0, 10] },
  ];

  if (options.image?.dataBase64 && options.image.mimeType) {
    content.push({
      image: `data:${options.image.mimeType};base64,${options.image.dataBase64}`,
      fit: [515, 720],
      alignment: 'center',
      margin: [0, 0, 0, 14],
    });
  }

  content.push({
    text: bodyText,
    style: 'body',
  });

  const docDefinition: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 44],
    info: {
      title: 'Repository overview',
      creator: 'DebtWatch',
    },
    content,
    styles: {
      title: { fontSize: 18, bold: true, color: '#0f172a' },
      body: { fontSize: 10, lineHeight: 1.35, alignment: 'left' },
    },
    defaultStyle: {
      font: 'Roboto',
    },
  };

  pdfMake.createPdf(docDefinition).download(OVERVIEW_FILENAME_PDF);
}
