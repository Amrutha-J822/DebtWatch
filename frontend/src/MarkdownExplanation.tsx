import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import mermaid from 'mermaid';

function MermaidBlock({ chart, isDark }: { chart: string; isDark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, '');

  useEffect(() => {
    const el = ref.current;
    if (!el || !chart.trim()) return;
    let cancelled = false;
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    });
    const id = `dw-mer-${uid}-${Date.now().toString(36)}`;
    mermaid
      .render(id, chart)
      .then(({ svg }) => {
        if (!cancelled && el) el.innerHTML = svg;
      })
      .catch(() => {
        if (!cancelled && el) {
          el.innerHTML = '';
          const pre = document.createElement('pre');
          pre.className = 'dw-md-mermaid-fallback';
          pre.textContent = chart;
          el.appendChild(pre);
        }
      });
    return () => {
      cancelled = true;
      if (el) el.innerHTML = '';
    };
  }, [chart, isDark, uid]);

  return <div className="dw-mermaid-block" ref={ref} />;
}

export const MarkdownExplanation = memo(function MarkdownExplanation({
  markdown,
  isDark,
}: {
  markdown: string;
  isDark: boolean;
}) {
  const components: Components = useMemo(
    () => ({
      h1: ({ children }) => <h1 className="dw-md-h1">{children}</h1>,
      h2: ({ children }) => <h2 className="dw-md-h2">{children}</h2>,
      h3: ({ children }) => <h3 className="dw-md-h3">{children}</h3>,
      h4: ({ children }) => <h4 className="dw-md-h4">{children}</h4>,
      p: ({ children }) => <p className="dw-md-p">{children}</p>,
      ul: ({ children }) => <ul className="dw-md-ul">{children}</ul>,
      ol: ({ children }) => <ol className="dw-md-ol">{children}</ol>,
      li: ({ children }) => <li className="dw-md-li">{children}</li>,
      a: ({ href, children }) => (
        <a className="dw-md-a" href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
      blockquote: ({ children }) => <blockquote className="dw-md-bq">{children}</blockquote>,
      hr: () => <hr className="dw-md-hr" />,
      strong: ({ children }) => <strong className="dw-md-strong">{children}</strong>,
      table: ({ children }) => (
        <div className="dw-md-table-wrap">
          <table className="dw-md-table">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead>{children}</thead>,
      tbody: ({ children }) => <tbody>{children}</tbody>,
      tr: ({ children }) => <tr>{children}</tr>,
      th: ({ children }) => <th>{children}</th>,
      td: ({ children }) => <td>{children}</td>,
      pre: ({ children }) => {
        const arr = Children.toArray(children);
        const first = arr[0];
        if (isValidElement(first)) {
          const p = first.props as { className?: string; children?: ReactNode };
          if (typeof p.className === 'string' && p.className.includes('language-mermaid')) {
            const raw = String(p.children).replace(/\n$/, '');
            return <MermaidBlock chart={raw} isDark={isDark} />;
          }
        }
        return <pre className="dw-md-pre">{children}</pre>;
      },
      code: ({ className, children, ...props }) => {
        const block = typeof className === 'string' && /language-/.test(className);
        if (block) {
          return (
            <code className={`dw-md-code-fenced ${className || ''}`} {...props}>
              {children}
            </code>
          );
        }
        return (
          <code className="dw-md-code-inline" {...props}>
            {children}
          </code>
        );
      },
    }),
    [isDark],
  );

  return (
    <div className="dw-md-root">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
