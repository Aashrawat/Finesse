import { request } from "@/lib/api";
import type {
  ChatDone,
  IngestResult,
  KbConversation,
  KbConversationItem,
  KbDocuments,
  KbSource,
} from "@/lib/types";

/* ---- per-user session id ------------------------------------------------------------------
 * Each browser makes a random id once and sends it as X-Session-Id. The server keeps
 * conversations private to that id. (Swap this for your real user id once you add accounts.) */

const SESSION_KEY = "finesse.session";
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function getSessionId(): string {
  try {
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing && /^[0-9a-f]{32}$/.test(existing)) return existing;
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    // storage blocked: a per-tab id still works, conversations just won't persist across visits
    return hex(crypto.getRandomValues(new Uint8Array(16)));
  }
}

const withSession = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string> | undefined), "X-Session-Id": getSessionId() },
});

/* ---- REST ---------------------------------------------------------------------------------- */

export const kbApi = {
  listConversations: () => request<KbConversationItem[]>("/api/conversations", withSession()),
  getConversation: (id: string) => request<KbConversation>(`/api/conversations/${id}`, withSession()),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, withSession({ method: "DELETE" })),
  documents: () => request<KbDocuments>("/api/documents"),
  ingest: (force = false) =>
    request<IngestResult>(
      "/api/ingest",
      withSession({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) }),
    ),
};

/* ---- streaming chat (Server-Sent Events over fetch, so we can POST and abort) ----------------- */

export interface StreamHandlers {
  onMeta?: (meta: { conversation_id: string; title: string }) => void;
  onToken?: (token: string) => void;
  onSources?: (sources: KbSource[]) => void;
  onDone?: (done: ChatDone) => void;
  onError?: (message: string) => void;
}

export async function streamChat(
  body: { message: string; conversation_id?: string },
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      "/api/chat",
      withSession({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new Error("Can't reach the server. Is the backend running?");
  }

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail) && data.detail[0]?.msg) message = String(data.detail[0].msg);
    } catch {
      /* no JSON body */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (raw: string) => {
    let event = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join("\n"));
    switch (event) {
      case "meta": handlers.onMeta?.(payload); break;
      case "token": handlers.onToken?.(payload.t); break;
      case "sources": handlers.onSources?.(payload.sources); break;
      case "done": handlers.onDone?.(payload); break;
      case "error": handlers.onError?.(payload.message); break;
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      if (raw.trim()) dispatch(raw);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}
