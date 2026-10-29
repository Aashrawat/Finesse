import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, X } from "lucide-react";
import { formatClock } from "@/lib/format";
import type { TranscriptSegment } from "@/lib/types";
import { cn, escapeRegExp, speakerColour } from "@/lib/utils";

export interface FocusRequest {
  time: number;
  nonce: number;
}

interface Props {
  segments: TranscriptSegment[];
  currentTime: number;
  onSeek: (seconds: number) => void;
  focusRequest: FocusRequest | null;
  loading: boolean;
  error?: string;
  onRetry: () => void;
  className?: string;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="hit">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export default function TranscriptPanel({ segments, currentTime, onSeek, focusRequest, loading, error, onRetry, className }: Props) {
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim();

  const speakers = useMemo(() => [...new Set(segments.map((s) => s.speaker))], [segments]);

  const activeIndex = useMemo(
    () => segments.findIndex((s) => currentTime >= s.start && currentTime < s.end),
    [segments, currentTime],
  );

  const { rows, hits } = useMemo(() => {
    if (!q) return { rows: segments.map((segment, index) => ({ segment, index })), hits: 0 };
    const pattern = escapeRegExp(q);
    const test = new RegExp(pattern, "i");
    const count = new RegExp(pattern, "gi");
    const matched = segments.map((segment, index) => ({ segment, index })).filter(({ segment }) => test.test(segment.text));
    const total = matched.reduce((n, { segment }) => n + (segment.text.match(count)?.length ?? 0), 0);
    return { rows: matched, hits: total };
  }, [segments, q]);

  // Cmd/Ctrl+K focuses the search box
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A chat citation asked us to jump to a time: scroll that row to the centre and flash it
  useEffect(() => {
    if (!focusRequest || segments.length === 0) return;
    setQuery("");
    let target = segments.findIndex((s) => focusRequest.time >= s.start && focusRequest.time < s.end);
    if (target === -1) {
      const before = segments.filter((s) => s.start <= focusRequest.time).length;
      target = Math.max(0, before - 1);
    }
    setFlash(null);
    const raf = requestAnimationFrame(() => {
      document.getElementById(`seg-${target}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      setFlash(target);
    });
    const clear = setTimeout(() => setFlash(null), 1400);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(clear);
    };
  }, [focusRequest, segments]);

  return (
    <section
      className={cn("flex min-h-0 flex-col rounded-panel border border-line bg-panel", className)}
      data-testid="transcript-panel"
    >
      <div className="space-y-3 border-b border-line p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[22px]">Transcript</h2>
          {!loading && !error && (
            <p className="font-mono text-[11px] text-ink-faint" data-testid="transcript-meta">
              {segments.length} cuts · {speakers.length} {speakers.length === 1 ? "voice" : "voices"}
            </p>
          )}
        </div>
        <label className="relative block">
          <span className="sr-only">Search transcript</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search transcript"
            data-testid="transcript-search-input"
            className="h-10 w-full rounded-row border border-line bg-track pl-9 pr-24 text-sm text-ink placeholder:text-ink-faint focus:border-lime/60 focus:outline-none"
          />
          <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
            {q ? (
              <>
                <span className="font-mono text-[11px] font-semibold text-lime" data-testid="transcript-hit-count">
                  {hits} {hits === 1 ? "hit" : "hits"}
                </span>
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  data-testid="transcript-search-clear"
                  className="grid size-6 place-items-center rounded text-ink-muted transition-colors duration-150 hover:text-ink"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </>
            ) : (
              <kbd className="rounded border border-line px-1.5 font-mono text-[10px] text-ink-faint">⌘K</kbd>
            )}
          </span>
        </label>
      </div>

      <div className="studio-scroll min-h-0 flex-1 overflow-y-auto py-1" data-testid="transcript-list">
        {loading &&
          [0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="grid animate-pulse grid-cols-[64px_1fr] gap-3 px-4 py-3" aria-hidden data-testid="transcript-loading">
              <div className="h-4 w-12 rounded bg-track" />
              <div className="space-y-2">
                <div className="h-3 w-16 rounded bg-track" />
                <div className="h-3 w-full rounded bg-track" />
                <div className="h-3 w-2/3 rounded bg-track" />
              </div>
            </div>
          ))}

        {!loading && error && (
          <div className="m-4 flex items-center justify-between gap-3 rounded-row border border-danger/30 bg-danger/5 p-3 text-sm text-danger" data-testid="transcript-error">
            <span>Couldn&apos;t load the transcript: {error}</span>
            <button
              type="button"
              onClick={onRetry}
              data-testid="transcript-retry-button"
              className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-semibold transition-colors duration-150 hover:bg-danger/10"
            >
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </button>
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="p-6 text-center text-sm text-ink-muted" data-testid="transcript-no-results">
            {q ? `Nothing in this reel says “${q}”.` : "No transcript available."}
          </p>
        )}

        {!loading &&
          !error &&
          rows.map(({ segment, index }) => {
            const active = index === activeIndex;
            const colour = speakerColour(speakers.indexOf(segment.speaker));
            return (
              <div
                key={index}
                id={`seg-${index}`}
                data-testid={`transcript-segment-${index}`}
                className={cn(
                  "relative grid grid-cols-[64px_1fr] gap-3 px-4 py-2.5 transition-colors duration-150",
                  active ? "bg-[#24293D]" : "hover:bg-panel-hover/60",
                  flash === index && "animate-lime-flash",
                )}
              >
                {active && <span className="glow-lime absolute inset-y-0 left-0 w-0.5 bg-lime" aria-hidden />}
                <button
                  type="button"
                  onClick={() => onSeek(segment.start)}
                  data-testid={`transcript-segment-timestamp-${index}`}
                  aria-label={`Jump to ${formatClock(segment.start)}`}
                  className={cn(
                    "h-6 self-start rounded px-1.5 text-left font-mono text-xs transition-colors duration-150",
                    active ? "bg-lime font-bold text-black" : "text-cyan hover:bg-cyan/10",
                  )}
                >
                  {formatClock(segment.start)}
                </button>
                <div className="min-w-0">
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.15em]" style={{ color: colour }}>
                    {segment.speaker}
                  </p>
                  <p className="mt-0.5 text-[15px] leading-relaxed text-ink-body">
                    <Highlighted text={segment.text} query={q} />
                  </p>
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}
