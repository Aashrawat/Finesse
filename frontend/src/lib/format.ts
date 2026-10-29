import { formatDistanceToNowStrict } from "date-fns";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 02:15, or 1:02:15 for anything an hour or longer. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** LED timecode HH:MM:SS.FF with frames out of 24. */
export function ledTimecode(seconds: number): string {
  const t = Math.max(0, seconds);
  const whole = Math.floor(t);
  const frames = Math.min(23, Math.floor((t - whole) * 24));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  return `${pad(h)}:${pad(m)}:${pad(whole % 60)}.${pad(frames)}`;
}

export function relativeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Cut ${formatDistanceToNowStrict(date, { addSuffix: true })}`;
}

/** Strip the markdown the LLM likes to add (bold, headings, code ticks). */
export function plainText(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "").trim();
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "reel"
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "[02:15]" or "[1:02:15]" -> seconds */
export function clockToSeconds(clock: string): number {
  const parts = clock.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const TIMESTAMP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

export type TextToken = { type: "text"; value: string } | { type: "time"; label: string; seconds: number };

/** Split assistant text into plain text and clickable [mm:ss] timestamp tokens. */
export function tokenizeTimestamps(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP_RE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ type: "text", value: text.slice(last, index) });
    tokens.push({ type: "time", label: match[1], seconds: clockToSeconds(match[1]) });
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ type: "text", value: text.slice(last) });
  return tokens;
}

export function extractCitations(text: string): number[] {
  const seconds = [...text.matchAll(TIMESTAMP_RE)].map((m) => clockToSeconds(m[1]));
  return [...new Set(seconds)];
}

const YOUTUBE_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{11}/i;

export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_RE.test(url.trim());
}
