declare module 'html-to-text' {
  export interface HtmlToTextOptions {
    wordwrap?: number | false | null;
    preserveNewlines?: boolean;
    selectors?: Array<{ selector: string; options?: Record<string, unknown>; format?: string }>;
  }
  export function convert(html: string, options?: HtmlToTextOptions): string;
}
