import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { Pause, Play, RotateCcw, RotateCw } from "lucide-react";
import { formatClock, ledTimecode } from "@/lib/format";
import type { PlayerHandle, Video } from "@/lib/types";
import { cn } from "@/lib/utils";

/* Minimal typings for the YouTube IFrame API (loaded on demand) */
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youTubeReady: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!youTubeReady) {
    youTubeReady = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    });
  }
  return youTubeReady;
}

const RATES = [1, 1.25, 1.5, 2];
const BARS = 96;

/** Deterministic pseudo-random bar heights so a reel's waveform is stable between renders. */
function waveformFor(seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: BARS }, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const r = ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    return 18 + Math.round(r * 82);
  });
}

interface Props {
  video: Video;
  currentTime: number;
  playing: boolean;
  rate: number;
  onTime: (seconds: number) => void;
  onPlaying: (playing: boolean) => void;
  onRate: (rate: number) => void;
  /** Seek and start playback (used by the scrubber and skip buttons). */
  onSeek: (seconds: number) => void;
}

const MediaDeck = forwardRef<PlayerHandle, Props>(function MediaDeck(
  { video, currentTime, playing, rate, onTime, onPlaying, onRate, onSeek },
  ref,
) {
  const isYouTube = video.source_type === "youtube" && !!video.youtube_id;
  const hasMedia = isYouTube || !!video.media_url;
  const duration = Math.max(video.duration, 1);

  const ytHost = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ytPlayer = useRef<any>(null);
  const mediaEl = useRef<HTMLMediaElement | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const callbacks = useRef({ onTime, onPlaying });
  callbacks.current = { onTime, onPlaying };

  /* ----- YouTube player ----- */
  useEffect(() => {
    if (!isYouTube || !ytHost.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const host = document.createElement("div");
    ytHost.current.appendChild(host);

    loadYouTubeApi().then(() => {
      if (cancelled) return;
      ytPlayer.current = new window.YT.Player(host, {
        videoId: video.youtube_id,
        width: "100%",
        height: "100%",
        playerVars: { enablejsapi: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: () => ytPlayer.current?.setPlaybackRate(rateRef.current),
          onStateChange: (e: { data: number }) => callbacks.current.onPlaying(e.data === 1),
        },
      });
      timer = setInterval(() => {
        const p = ytPlayer.current;
        if (p?.getCurrentTime && playingRef.current) callbacks.current.onTime(p.getCurrentTime());
      }, 250);
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      ytPlayer.current?.destroy?.();
      ytPlayer.current = null;
      host.remove();
    };
  }, [isYouTube, video.youtube_id]);

  /* ----- Controls exposed to the workspace ----- */
  useImperativeHandle(
    ref,
    () => ({
      seek: (seconds) => {
        const t = Math.min(Math.max(0, seconds), duration);
        if (isYouTube) ytPlayer.current?.seekTo?.(t, true);
        else if (mediaEl.current) mediaEl.current.currentTime = t;
      },
      play: () => {
        if (isYouTube) ytPlayer.current?.playVideo?.();
        else void mediaEl.current?.play();
      },
      pause: () => {
        if (isYouTube) ytPlayer.current?.pauseVideo?.();
        else mediaEl.current?.pause();
      },
      toggle: () => {
        const handle = playingRef.current ? "pause" : "play";
        if (isYouTube) ytPlayer.current?.[handle === "pause" ? "pauseVideo" : "playVideo"]?.();
        else if (handle === "pause") mediaEl.current?.pause();
        else void mediaEl.current?.play();
      },
      setRate: (r) => {
        if (isYouTube) ytPlayer.current?.setPlaybackRate?.(r);
        else if (mediaEl.current) mediaEl.current.playbackRate = r;
      },
    }),
    [isYouTube, duration],
  );

  // Keep the real player's speed in sync with the speed buttons
  useEffect(() => {
    if (isYouTube) ytPlayer.current?.setPlaybackRate?.(rate);
    else if (mediaEl.current) mediaEl.current.playbackRate = rate;
  }, [rate, isYouTube]);

  const togglePlay = () => {
    if (!hasMedia) return;
    if (isYouTube) {
      const p = ytPlayer.current;
      if (playing) p?.pauseVideo?.();
      else p?.playVideo?.();
    } else if (playing) mediaEl.current?.pause();
    else void mediaEl.current?.play();
  };

  /* ----- Scrubber ----- */
  const ticks = useMemo(() => video.transcript.map((s) => (s.start / duration) * 100), [video.transcript, duration]);
  const progress = Math.min(100, (currentTime / duration) * 100);

  const onScrubClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };
  const onScrubKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      onSeek(currentTime + 5);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onSeek(currentTime - 5);
    }
  };

  const waveform = useMemo(() => waveformFor(video.id), [video.id]);
  const playedBars = Math.floor((currentTime / duration) * BARS);

  const bigPlay = (
    <button
      type="button"
      onClick={togglePlay}
      aria-label={playing ? "Pause" : "Play"}
      data-testid="media-big-play-button"
      className="glow-lime grid size-16 place-items-center rounded-full bg-lime text-black transition-transform duration-150 hover:scale-105 active:scale-95"
    >
      {playing ? <Pause className="size-7" aria-hidden /> : <Play className="size-7 translate-x-0.5" aria-hidden />}
    </button>
  );

  return (
    <section className="overflow-hidden rounded-panel border border-line bg-panel" data-testid="media-deck">
      <div className="relative aspect-video bg-black">
        {isYouTube && <div ref={ytHost} className="absolute inset-0 [&>iframe]:size-full" data-testid="media-youtube-player" />}

        {!isYouTube && video.media_url && video.source_type === "video" && (
          <>
            <video
              ref={(el) => { mediaEl.current = el; }}
              src={video.media_url}
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
              onPlay={() => onPlaying(true)}
              onPause={(e) => { onPlaying(false); onTime(e.currentTarget.currentTime); }}
              onSeeked={(e) => onTime(e.currentTarget.currentTime)}
              onEnded={() => onPlaying(false)}
              className="absolute inset-0 size-full object-contain"
              data-testid="media-video-element"
            />
            {!playing && <div className="absolute inset-0 grid place-items-center bg-black/30">{bigPlay}</div>}
          </>
        )}

        {!isYouTube && video.media_url && video.source_type !== "video" && (
          <>
            <audio
              ref={(el) => { mediaEl.current = el; }}
              src={video.media_url}
              preload="metadata"
              onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
              onPlay={() => onPlaying(true)}
              onPause={(e) => { onPlaying(false); onTime(e.currentTarget.currentTime); }}
              onSeeked={(e) => onTime(e.currentTarget.currentTime)}
              onEnded={() => onPlaying(false)}
              data-testid="media-audio-element"
            />
            {video.thumbnail && (
              <img src={video.thumbnail} alt="" className="absolute inset-0 size-full object-cover opacity-40" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/30" aria-hidden />
            <div className="absolute inset-x-6 bottom-6 flex h-24 items-center gap-[2px]" aria-hidden data-testid="media-waveform">
              {waveform.map((height, i) => (
                <span
                  key={i}
                  className={cn("flex-1 rounded-full", i < playedBars ? "bg-lime" : "bg-white/15")}
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
            <div className="absolute inset-0 grid place-items-center pb-16">{bigPlay}</div>
          </>
        )}

        {!hasMedia && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-muted" data-testid="media-unavailable">
            The original media isn&apos;t available for this reel. The summary, transcript and chat still work.
          </div>
        )}
      </div>

      <div className="space-y-3 p-4">
        {/* Transport row */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "rounded-full bg-black px-3 py-1 font-mono text-sm text-lime",
                playing && "animate-led-pulse",
              )}
              data-testid="media-timecode"
            >
              {ledTimecode(currentTime)}
            </span>
            <span className="font-mono text-xs text-ink-faint">/ {formatClock(video.duration)}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSeek(currentTime - 10)}
              disabled={!hasMedia}
              aria-label="Back 10 seconds"
              data-testid="media-back-button"
              className="grid size-10 place-items-center rounded-row border border-line text-ink-body transition-colors duration-150 hover:bg-panel-hover active:scale-95 disabled:opacity-40"
            >
              <RotateCcw className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={togglePlay}
              disabled={!hasMedia}
              aria-label={playing ? "Pause" : "Play"}
              data-testid="media-play-button"
              className="grid size-11 place-items-center rounded-row bg-ink text-black transition-transform duration-150 hover:scale-105 active:scale-95 disabled:opacity-40"
            >
              {playing ? <Pause className="size-5" aria-hidden /> : <Play className="size-5 translate-x-px" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => onSeek(currentTime + 10)}
              disabled={!hasMedia}
              aria-label="Forward 10 seconds"
              data-testid="media-forward-button"
              className="grid size-10 place-items-center rounded-row border border-line text-ink-body transition-colors duration-150 hover:bg-panel-hover active:scale-95 disabled:opacity-40"
            >
              <RotateCw className="size-4" aria-hidden />
            </button>
          </div>

          <div className="flex rounded-row bg-track p-0.5" role="group" aria-label="Playback speed">
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => onRate(r)}
                aria-pressed={rate === r}
                data-testid={`media-speed-${r}`}
                className={cn(
                  "h-8 rounded-md px-2 font-mono text-xs transition-colors duration-150",
                  rate === r ? "bg-lime font-bold text-black" : "text-ink-muted hover:text-ink",
                )}
              >
                {r}x
              </button>
            ))}
          </div>
        </div>

        {/* Scrubber */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration)}`}
          onClick={onScrubClick}
          onKeyDown={onScrubKey}
          data-testid="media-scrubber"
          className="relative h-8 cursor-pointer overflow-hidden rounded-row bg-track"
        >
          {ticks.map((left, i) => (
            <span key={i} className="absolute inset-y-2 w-px bg-white/10" style={{ left: `${left}%` }} aria-hidden />
          ))}
          <div className="absolute inset-y-0 left-0 bg-lime/15" style={{ width: `${progress}%` }} aria-hidden />
          <div
            className="glow-lime absolute inset-y-0 w-0.5 bg-lime transition-[left] duration-200 ease-linear"
            style={{ left: `calc(${progress}% - 1px)` }}
            aria-hidden
          >
            <span className="absolute -top-0.5 left-1/2 size-2 -translate-x-1/2 rotate-45 bg-lime" />
          </div>
        </div>
      </div>
    </section>
  );
});

export default MediaDeck;
