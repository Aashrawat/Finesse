import { memo } from "react";
import { RefreshCw } from "lucide-react";
import { plainText } from "@/lib/format";
import type { Video } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  video?: Video;
  loading: boolean;
  error?: string;
  onRetry: () => void;
}

const TAG_COLOURS = [
  "border-lime/60 text-lime",
  "border-cyan/60 text-cyan",
  "border-amber/60 text-amber",
];

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden data-testid="summary-loading">
      <div className="h-6 w-4/5 rounded bg-track" />
      <div className="h-4 w-full rounded bg-track" />
      <div className="h-4 w-11/12 rounded bg-track" />
      <div className="h-4 w-3/4 rounded bg-track" />
    </div>
  );
}

function SummaryPanel({ video, loading, error, onRetry }: Props) {
  const words = video ? video.transcript.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0) : 0;
  const voices = video ? new Set(video.transcript.map((s) => s.speaker)).size : 0;
  const summary = video?.summary;
  const empty = !!summary && !summary.tldr && summary.key_points.length === 0;

  const tldrSentence = summary?.tldr.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? summary?.tldr ?? "";
  const tldrRest = summary ? summary.tldr.slice(tldrSentence.length) : "";

  const extras = video
    ? ([
        ["Action items", video.extras.action_items],
        ["Key decisions", video.extras.decisions],
        ["Open questions", video.extras.questions],
      ] as const)
        .map(([title, body]) => [title, plainText(body)] as const)
        .filter(([, body]) => body.length > 0)
    : [];

  return (
    <section className="rounded-panel border border-line bg-panel p-5" data-testid="summary-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">Director&apos;s cut</p>
          <h2 className="mt-1 text-[22px]">Summary</h2>
        </div>
        {video && (
          <p className="text-right font-mono text-[11px] text-ink-faint">
            {words.toLocaleString()} words
            <br />
            {voices} {voices === 1 ? "voice" : "voices"}
          </p>
        )}
      </div>

      <div className="mt-4">
        {loading && <Skeleton />}

        {!loading && error && (
          <div className="flex items-center justify-between gap-3 rounded-row border border-danger/30 bg-danger/5 p-3 text-sm text-danger" data-testid="summary-error">
            <span>Couldn&apos;t load the summary: {error}</span>
            <button
              type="button"
              onClick={onRetry}
              data-testid="summary-retry-button"
              className="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-3 py-1.5 text-xs font-semibold transition-colors duration-150 hover:bg-danger/10"
            >
              <RefreshCw className="size-3.5" aria-hidden /> Retry
            </button>
          </div>
        )}

        {!loading && !error && empty && (
          <p className="text-sm text-ink-muted" data-testid="summary-empty">No summary yet</p>
        )}

        {!loading && !error && summary && !empty && (
          <div className="space-y-6">
            <div>
              <h3 className="font-mono text-[10px] font-normal uppercase tracking-[0.2em] text-ink-muted">TL;DR</h3>
              <p className="mt-2 font-heading text-2xl font-bold leading-snug text-ink" data-testid="summary-tldr">
                <span className="hl">{tldrSentence}</span>
                {tldrRest}
              </p>
            </div>

            {summary.key_points.length > 0 && (
              <div>
                <h3 className="font-mono text-[10px] font-normal uppercase tracking-[0.2em] text-ink-muted">Key points</h3>
                <ol className="mt-3 space-y-2.5">
                  {summary.key_points.map((point, i) => (
                    <li key={i} className="group flex gap-3">
                      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-track font-mono text-[11px] font-bold text-lime transition-colors duration-150 group-hover:bg-lime group-hover:text-black">
                        {i + 1}
                      </span>
                      <span className="text-[15px] leading-relaxed text-ink-body">{point}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {summary.topics.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="summary-topics">
                {summary.topics.map((topic, i) => (
                  <span
                    key={topic}
                    className={cn(
                      "rounded-full border px-3 py-1 font-mono text-xs transition-transform duration-150 hover:-translate-y-0.5",
                      TAG_COLOURS[i % TAG_COLOURS.length],
                    )}
                  >
                    #{topic}
                  </span>
                ))}
              </div>
            )}

            {extras.map(([title, body]) => (
              <details key={title} className="group rounded-row border border-line bg-track" data-testid={`summary-extra-${title.toLowerCase().replace(/\s+/g, "-")}`}>
                <summary className="cursor-pointer list-none px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted transition-colors duration-150 hover:text-ink">
                  <span className="mr-2 inline-block transition-transform duration-150 group-open:rotate-90">›</span>
                  {title}
                </summary>
                <p className="whitespace-pre-line px-4 pb-4 text-sm leading-relaxed text-ink-body">{body}</p>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(SummaryPanel);
