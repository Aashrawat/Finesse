import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import MediaDeck from "@/components/studio/MediaDeck";
import SummaryPanel from "@/components/studio/SummaryPanel";
import TranscriptPanel, { type FocusRequest } from "@/components/studio/TranscriptPanel";
import ChatPanel from "@/components/studio/ChatPanel";
import SourceBadge from "@/components/studio/SourceBadge";
import { api } from "@/lib/api";
import { exportPdf, exportTxt } from "@/lib/exportUtils";
import { formatClock, relativeDate } from "@/lib/format";
import type { PlayerHandle } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";

type MobileTab = "summary" | "transcript" | "chat";

export default function Workspace() {
  const { id = "" } = useParams();
  // Keyed by id so switching reels resets the player, time and chat state
  return <WorkspaceInner key={id} id={id} />;
}

function WorkspaceInner({ id }: { id: string }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [tab, setTab] = useState<MobileTab>("summary");

  const { data: video, isPending, error, refetch } = useQuery({
    queryKey: ["video", id],
    queryFn: () => api.getVideo(id),
    retry: false,
  });
  const errorMessage = error instanceof Error ? error.message : undefined;
  const retry = useCallback(() => void refetch(), [refetch]);

  /* ---- One source of truth for playback time ---- */
  const playerRef = useRef<PlayerHandle>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);

  /** Every seek sets the time, starts playback and moves the real player. */
  const seek = useCallback((seconds: number) => {
    playerRef.current?.seek(seconds);
    playerRef.current?.play();
    setCurrentTime(Math.max(0, seconds));
  }, []);

  /** A chat citation: seek, then ask the transcript to scroll to and flash that row. */
  const cite = useCallback(
    (seconds: number) => {
      seek(seconds);
      setFocusRequest({ time: seconds, nonce: Date.now() });
    },
    [seek],
  );

  // Space toggles playback unless focus is somewhere that already uses the key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, button, a, [role='slider'], [contenteditable='true']")) return;
      e.preventDefault();
      playerRef.current?.toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- Export ---- */
  const [exporting, setExporting] = useState<"pdf" | "txt" | null>(null);
  async function runExport(kind: "pdf" | "txt") {
    if (!video || exporting) return;
    setExporting(kind);
    try {
      const filename = kind === "pdf" ? await exportPdf(video) : exportTxt(video);
      toast.success(`${kind.toUpperCase()} exported · ${filename}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Couldn't export the ${kind.toUpperCase()}`);
    } finally {
      setExporting(null);
    }
  }

  /* ---- Not found / failed ---- */
  if (!isPending && !video) {
    return (
      <StudioShell>
        <main className="grid flex-1 place-items-center px-4" data-testid="workspace-error">
          <div className="max-w-md space-y-4 text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Reel not found</p>
            <h1 className="text-4xl">That cut isn&apos;t in the archive.</h1>
            <p className="text-ink-muted">{errorMessage}</p>
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={retry}
                data-testid="workspace-retry-button"
                className="h-11 rounded-row border border-line px-5 text-sm font-semibold transition-colors duration-150 hover:border-lime hover:text-lime"
              >
                Retry
              </button>
              <Link
                to="/"
                className="inline-flex h-11 items-center rounded-row bg-lime px-5 font-heading font-bold text-black transition-transform duration-150 active:scale-95"
              >
                New reel
              </Link>
            </div>
          </div>
        </main>
      </StudioShell>
    );
  }

  const summaryPanel = <SummaryPanel video={video} loading={isPending} error={errorMessage} onRetry={retry} />;
  const transcriptPanel = (
    <TranscriptPanel
      segments={video?.transcript ?? []}
      currentTime={currentTime}
      onSeek={seek}
      focusRequest={focusRequest}
      loading={isPending}
      error={errorMessage}
      onRetry={retry}
      className={isDesktop ? "h-full" : "h-[70dvh]"}
    />
  );
  const chatPanel = <ChatPanel videoId={id} onCite={cite} className={isDesktop ? "h-full" : "h-[70dvh]"} />;

  const deck = video ? (
    <MediaDeck
      ref={playerRef}
      video={video}
      currentTime={currentTime}
      playing={playing}
      rate={rate}
      onTime={setCurrentTime}
      onPlaying={setPlaying}
      onRate={setRate}
      onSeek={seek}
    />
  ) : (
    <div className="aspect-video animate-pulse rounded-panel border border-line bg-panel" aria-hidden data-testid="media-loading" />
  );

  return (
    <StudioShell>
      <div className="flex flex-1 flex-col lg:h-[calc(100dvh-3.5rem)] lg:flex-none">
        {/* Media header */}
        <div className="flex flex-wrap items-end justify-between gap-4 px-4 pb-4 pt-6 md:px-8">
          <div className="min-w-0 space-y-2">
            {video ? (
              <div className="flex items-center gap-3">
                <SourceBadge type={video.source_type} />
                <span className="font-mono text-[11px] text-ink-faint">{relativeDate(video.created_at)}</span>
              </div>
            ) : (
              <div className="h-5 w-40 animate-pulse rounded bg-panel" aria-hidden />
            )}
            <h1 className="max-w-4xl text-3xl leading-tight md:text-4xl" data-testid="workspace-title">
              {video ? video.title : <span className="inline-block h-9 w-80 max-w-full animate-pulse rounded bg-panel align-middle" aria-hidden />}
            </h1>
            {video && (
              <p className="truncate font-mono text-xs text-ink-faint">
                {video.source_ref} · {formatClock(video.duration)}
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => runExport("txt")}
              disabled={!video || !!exporting}
              data-testid="export-txt-button"
              className="inline-flex h-10 items-center gap-2 rounded-row border border-line px-4 text-sm font-semibold text-ink transition-colors duration-150 hover:border-lime hover:text-lime active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileText className="size-4" aria-hidden /> TXT
            </button>
            <button
              type="button"
              onClick={() => runExport("pdf")}
              disabled={!video || !!exporting}
              data-testid="export-pdf-button"
              className="inline-flex h-10 items-center gap-2 rounded-row bg-lime px-4 text-sm font-bold text-black transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_24px_rgba(204,255,0,0.35)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="size-4" aria-hidden /> PDF
            </button>
          </div>
        </div>

        {isDesktop ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(340px,0.9fr)] gap-4 px-8 pb-4">
            <div className="studio-scroll min-h-0 space-y-4 overflow-y-auto pr-1">
              {deck}
              {summaryPanel}
            </div>
            {transcriptPanel}
            {chatPanel}
          </div>
        ) : (
          <div className="space-y-4 px-4 pb-8">
            {deck}
            <div
              className="sticky top-14 z-30 -mx-4 flex gap-1 border-b border-line bg-[rgba(11,12,16,0.92)] px-4 py-2 backdrop-blur-[24px]"
              role="tablist"
              aria-label="Workspace panels"
            >
              {(["summary", "transcript", "chat"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  data-testid={`workspace-tab-${t}`}
                  className={cn(
                    "h-9 flex-1 rounded-row text-sm font-semibold capitalize transition-colors duration-150",
                    tab === t ? "bg-lime text-black" : "text-ink-muted hover:bg-panel-hover",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "summary" && summaryPanel}
            {tab === "transcript" && transcriptPanel}
            {tab === "chat" && chatPanel}
          </div>
        )}
      </div>
    </StudioShell>
  );
}
