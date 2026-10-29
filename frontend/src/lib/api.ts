import { extractCitations } from "@/lib/format";
import type {
  ChatMessage,
  JobStatus,
  ResearchJob,
  ResearchListItem,
  Summary,
  TranscriptSegment,
  Video,
  VideoListItem,
} from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Raw backend shapes. Every adapter below maps one of these to the
 * UI types in lib/types.ts, so components never see backend formats.
 * ------------------------------------------------------------------ */
interface RawListItem {
  id: string;
  title: string;
  source_type: VideoListItem["source_type"];
  source_ref: string;
  thumbnail: string | null;
  duration: number;
  created_at: string;
}

interface RawVideo extends RawListItem {
  youtube_id: string | null;
  language: string | null;
  summary_text: string;
  action_items: string;
  decisions: string;
  questions: string;
  transcript: TranscriptSegment[];
  has_media: boolean;
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error("Can't reach the server. Is the backend running?");
  }
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") message = body.detail;
    } catch {
      /* no JSON body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------ adapters ---------------------------- */

const stripMarkdown = (text: string) =>
  text.replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").trim();

const firstSentence = (text: string) => text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;

function shortTopic(topic: string): string {
  const words = stripMarkdown(topic).replace(/[.:]+$/, "").split(/\s+/);
  return words.slice(0, 4).join(" ") + (words.length > 4 ? "…" : "");
}

/**
 * The backend summary is markdown bullets (a bold heading per topic with sub-bullets).
 * Heading -> topic tag, sub-bullets -> key points, first point -> TL;DR.
 */
export function adaptSummary(markdown: string): Summary {
  const topics: string[] = [];
  const points: string[] = [];

  for (const line of markdown.split("\n")) {
    const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
    if (!bullet) continue;
    const indent = bullet[1].length;
    const body = bullet[2].trim();
    const heading = body.match(/^\*\*(.+?)\*\*:?\s*(.*)$/);
    if (indent === 0 && heading) {
      topics.push(shortTopic(heading[1]));
      if (heading[2]) points.push(stripMarkdown(heading[2]));
    } else {
      points.push(stripMarkdown(body));
    }
  }

  if (points.length === 0) {
    // Not bullet-formatted: fall back to sentences
    const sentences = stripMarkdown(markdown).split(/(?<=[.!?])\s+/).filter(Boolean);
    points.push(...sentences);
  }
  if (points.length === 0) return { tldr: "", key_points: [], topics: [] };

  const [first, ...rest] = points;
  return {
    tldr: firstSentence(first),
    key_points: rest.length > 0 ? rest : [first],
    topics: [...new Set(topics)].slice(0, 6),
  };
}

const STOPWORDS = new Set(
  ("about above after again also always among another because been before being between both cannot could " +
    "does doing done down during each either else even ever every from further have having here however " +
    "into just like made make many might more most much must need never next once only other over please " +
    "really said same should since some still such than that their them then there these they thing think " +
    "this those through today under until upon very want well were what when where which while will with " +
    "within without would your yours yourself first second third fourth finally welcome thank joining " +
    "going gonna kind lets okay yeah right now").split(" "),
);

/** Fallback topic tags: the most repeated meaningful words in the transcript. */
function keywordTopics(segments: TranscriptSegment[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const word of segments.map((s) => s.text).join(" ").toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) {
    if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));
}

function adaptListItem(raw: RawListItem): VideoListItem {
  return {
    id: raw.id,
    title: raw.title,
    source_type: raw.source_type,
    source_ref: raw.source_ref,
    thumbnail: raw.thumbnail,
    duration: raw.duration,
    created_at: raw.created_at,
  };
}

function adaptVideo(raw: RawVideo): Video {
  const summary = adaptSummary(raw.summary_text);
  if (summary.topics.length === 0) summary.topics = keywordTopics(raw.transcript);
  return {
    ...adaptListItem(raw),
    youtube_id: raw.youtube_id,
    language: raw.language,
    summary,
    extras: { action_items: raw.action_items, decisions: raw.decisions, questions: raw.questions },
    transcript: raw.transcript,
    media_url: raw.has_media ? `/api/videos/${raw.id}/media` : null,
  };
}

/* ------------------------- research adapters ------------------------ */

interface RawResearch extends Omit<ResearchJob, "created_at"> {
  created_at: number; // epoch seconds
}

const adaptResearch = (raw: RawResearch): ResearchJob => ({
  ...raw,
  created_at: new Date(raw.created_at * 1000).toISOString(),
});

/* ------------------------------ endpoints --------------------------- */

export const api = {
  async startResearch(topic: string): Promise<ResearchJob> {
    return adaptResearch(
      await request<RawResearch>("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      }),
    );
  },

  async getResearch(id: string): Promise<ResearchJob> {
    return adaptResearch(await request<RawResearch>(`/api/research/${id}`));
  },

  async listResearch(): Promise<ResearchListItem[]> {
    const items = await request<{ id: string; topic: string; created_at: number }[]>("/api/research");
    return items.map((item) => ({ ...item, created_at: new Date(item.created_at * 1000).toISOString() }));
  },

  deleteResearch(id: string): Promise<{ ok: boolean }> {
    return request(`/api/research/${id}`, { method: "DELETE" });
  },

  startJob(input: { url?: string; file?: File }): Promise<JobStatus> {
    const form = new FormData();
    if (input.file) form.append("file", input.file);
    else form.append("url", input.url ?? "");
    return request<JobStatus>("/api/jobs", { method: "POST", body: form });
  },

  getJob(id: string): Promise<JobStatus> {
    return request<JobStatus>(`/api/jobs/${id}`);
  },

  async listVideos(query = ""): Promise<VideoListItem[]> {
    const url = query ? `/api/videos?q=${encodeURIComponent(query)}` : "/api/videos";
    return (await request<RawListItem[]>(url)).map(adaptListItem);
  },

  async getVideo(id: string): Promise<Video> {
    return adaptVideo(await request<RawVideo>(`/api/videos/${id}`));
  },

  deleteVideo(id: string): Promise<{ ok: boolean }> {
    return request(`/api/videos/${id}`, { method: "DELETE" });
  },

  async chat(videoId: string, question: string): Promise<ChatMessage> {
    const { answer } = await request<{ answer: string }>(`/api/videos/${videoId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    return {
      id: crypto.randomUUID(),
      video_id: videoId,
      role: "assistant",
      content: answer,
      citations: extractCitations(answer),
      created_at: new Date().toISOString(),
    };
  },
};
