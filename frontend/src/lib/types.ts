export type SourceType = "youtube" | "audio" | "video";

export interface TranscriptSegment {
  start: number; // seconds
  end: number;
  speaker: string;
  text: string;
}

export interface Summary {
  tldr: string;
  key_points: string[];
  topics: string[];
}

export interface VideoListItem {
  id: string;
  title: string;
  source_type: SourceType;
  source_ref: string;
  thumbnail: string | null;
  duration: number;
  created_at: string;
}

export interface Extras {
  action_items: string;
  decisions: string;
  questions: string;
}

export interface Video extends VideoListItem {
  youtube_id: string | null;
  summary: Summary;
  extras: Extras;
  transcript: TranscriptSegment[];
  media_url: string | null; // playable URL for uploaded files
  language: string | null;
}

export interface ChatMessage {
  id: string;
  video_id: string;
  role: "user" | "assistant";
  content: string;
  citations: number[]; // seconds
  created_at: string;
}

export interface JobStatus {
  id: string;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  progress: number;
  error: string | null;
  language: string | null;
}

/* ---------------------- Multi-agent research ---------------------- */

export interface ResearchResult {
  search_results: string;
  scraped_content: string;
  report: string; // markdown
  feedback: string; // the critic's raw text
}

export interface ResearchJob {
  id: string;
  topic: string;
  status: "running" | "done" | "error";
  /** 0 = starting, 1-4 = search / reader / writer / critic, 5 = finished */
  step: number;
  created_at: string; // ISO
  result: ResearchResult | null;
  error: string | null;
}

export interface ResearchListItem {
  id: string;
  topic: string;
  created_at: string; // ISO
}

export interface Critique {
  score: number | null; // out of 10
  strengths: string[];
  improvements: string[];
  verdict: string;
}

/* ---------------------- Knowledge-base chat ---------------------- */

export interface KbSource {
  source: string;
  filename: string;
  page: number; // 0 = the document has no pages
  page_end?: number; // last page of the passage (older saved chats don't have it)
  chunk_id: string;
  similarity: number; // cosine, 0-1
  text: string;
}

/** A file attached to a user message. */
export interface KbAttachment {
  id: string;
  name: string;
  kind: "image" | "document";
  mime: string;
  size: number;
  previewUrl?: string; // client-side only: a local preview for the message that was just sent
}

export interface KbMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: KbSource[];
  created_at: string;
  attachments?: KbAttachment[];
  stopped?: boolean; // generation was stopped by the user
  error?: string; // the request failed (shown in place of the answer)
  streaming?: boolean; // client-side only
  status?: string; // client-side only: e.g. "Reading report.pdf…" before the answer starts
}

export interface KbConversationItem {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface KbConversation extends KbConversationItem {
  messages: KbMessage[];
}

export interface KbDocument {
  source: string;
  filename: string;
  chunks: number;
  pages: number;
  created_at: string;
}

export interface KbDocuments {
  folder: string;
  folder_exists: boolean;
  documents: KbDocument[];
  pending: string[]; // new or changed files not yet ingested
  failed: { source: string; error: string }[]; // files that couldn't be read
  total_chunks: number;
}

export interface IngestResult {
  ingested: string[];
  skipped: string[];
  errors: { source: string; error: string }[];
  chunks: number;
}

export interface ChatDone {
  latency_ms: number;
  ttft_ms: number | null;
  usage: { prompt_tokens: number; completion_tokens: number; embedding_tokens: number; total_tokens: number };
}

/** Imperative controls the Media deck exposes to the rest of the workspace. */
export interface PlayerHandle {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setRate: (rate: number) => void;
}

/* ---- accounts ---- */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  plan: string; // "free" for now
  created_at: string;
}
