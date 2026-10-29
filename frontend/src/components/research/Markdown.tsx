import { useState, type ReactNode } from "react";
import { Check, Copy, FileText } from "lucide-react";

/**
 * Small, safe markdown renderer for LLM output. Supports headings, bullet / numbered lists,
 * paragraphs, fenced code blocks (with a copy button), tables, block quotes, **bold**, *italic*,
 * `inline code`, links, and `[source: file, page]` citations (rendered as chips).
 *
 * Everything is rendered as React nodes (never raw HTML) and only http(s) links are clickable.
 * It tolerates half-finished input, so it can render a streaming answer on every token.
 */

const INLINE =
  /\*\*(.+?)\*\*|`([^`\n]+)`|\[source:\s*([^\]]+)\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>\]]+)|(?<![*\w])\*([^*\n]+)\*(?![*\w])/g;

function Citation({ raw }: { raw: string }) {
  // "handbook.pdf, page 3" / "handbook.pdf, pages 3-4"  ->  handbook.pdf · p.3 / p.3-4
  const match = raw.match(/^(.*?),\s*pages?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*$/i);
  const file = (match ? match[1] : raw).trim();
  const page = match?.[2];
  return (
    <span
      data-testid="citation-chip"
      title={`Source: ${raw}`}
      className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-lime/30 bg-lime/10 px-1.5 py-px align-baseline font-mono text-[11px] text-lime"
    >
      <FileText className="size-3" aria-hidden />
      {file}
      {page && <span className="text-lime/70">· p.{page}</span>}
    </span>
  );
}

function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++} className="font-semibold text-ink">{m[1]}</strong>);
    } else if (m[2] !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-track px-1.5 py-0.5 font-mono text-[0.85em] text-cyan">
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined) {
      nodes.push(<Citation key={key++} raw={m[3]} />);
    } else if (m[7] !== undefined) {
      nodes.push(<em key={key++}>{m[7]}</em>);
    } else {
      const href = m[5] ?? m[6];
      const label = m[4] ?? m[6];
      nodes.push(
        <a
          key={key++}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-cyan underline decoration-cyan/40 underline-offset-2 hover:decoration-cyan"
        >
          {label}
        </a>,
      );
    }
    last = index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; lang: string; code: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "rule" }
  | { type: "paragraph"; text: string };

const splitRow = (line: string) =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
const isTableSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push({ type: "list", ...list });
    if (quote.length) blocks.push({ type: "quote", text: quote.join(" ") });
    paragraph = [];
    list = null;
    quote = [];
  };

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Fenced code block. An unclosed fence (still streaming) runs to the end of the text.
    const fence = line.match(/^```\s*([\w+#.-]*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ type: "code", lang: fence[1], code: code.join("\n") });
      continue;
    }

    if (!line) {
      flush();
      continue;
    }
    if (/^[-_*]{3,}$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].replace(/\*\*/g, "") });
      continue;
    }

    // Table: a row of cells followed by a |---|---| separator row
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const quoted = line.match(/^>\s?(.*)$/);
    if (quoted) {
      if (paragraph.length || list) flush();
      quote.push(quoted[1]);
      continue;
    }

    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      if (paragraph.length || quote.length) flush();
      const ordered = !bullet;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (list || quote.length) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) */
    }
  }
  return (
    <div className="overflow-hidden rounded-row border border-line bg-track" data-testid="code-block">
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">{lang || "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          data-testid="code-copy-button"
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
        >
          {copied ? <Check className="size-3.5 text-lime" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="studio-scroll overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-ink-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

interface Props {
  text: string;
  /** Drop a leading "# Title" the page already shows. */
  skipTitle?: boolean;
}

export default function Markdown({ text, skipTitle }: Props) {
  const blocks = parse(text);
  if (skipTitle && blocks[0]?.type === "heading" && blocks[0].level === 1) blocks.shift();

  return (
    <div className="space-y-4 text-[15px] leading-relaxed text-ink-body" data-testid="markdown">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            // The page already shows the report title, so # and ## both render as section headings.
            return block.level <= 2 ? (
              <h2 key={i} className="border-t border-line pt-5 font-heading text-2xl text-ink first:border-t-0 first:pt-0">
                {block.text}
              </h2>
            ) : (
              <h3 key={i} className="pt-1 font-heading text-lg text-ink">
                {block.text}
              </h3>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag
                key={i}
                className={block.ordered ? "list-decimal space-y-1.5 pl-5 marker:text-lime" : "list-disc space-y-1.5 pl-5 marker:text-lime"}
              >
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return <CodeBlock key={i} lang={block.lang} code={block.code} />;
          case "table":
            return (
              <div key={i} className="studio-scroll overflow-x-auto rounded-row border border-line">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-track text-ink">
                    <tr>
                      {block.header.map((cell, j) => (
                        <th key={j} className="border-b border-line px-3 py-2 font-semibold">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r} className="border-b border-line last:border-b-0">
                        {row.map((cell, j) => (
                          <td key={j} className="px-3 py-2 align-top">
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-lime/60 pl-4 text-ink-muted">
                {inline(block.text)}
              </blockquote>
            );
          case "rule":
            return <hr key={i} className="border-line" />;
          default:
            return <p key={i}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
