import { request } from "@/lib/api";
import type {
  ChatDone,
  ChatQuota,
  IngestResult,
  KbConversation,
  KbConversationItem,
  KbDocuments,
  KbGeneratedImage,
  KbSource,
  ExternalSource,
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
  quota: () => request<ChatQuota>("/api/chat/quota", withSession()),
  /** Send photos to Cloudinary. The response is the URL and public id — the file is not kept on the server. */
  uploadImages: async (files: File[]): Promise<UploadedImage[]> => {
    const form = new FormData();
    files.forEach((file) => form.append("images", file));
    const res = await fetch("/api/upload", withSession({ method: "POST", body: form }));
    let body: { images?: UploadedImage[]; error?: string; detail?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* no JSON body */
    }
    if (!res.ok || !body.images || body.images.length !== files.length) {
      throw new Error(body.error || (typeof body.detail === "string" ? body.detail : "Couldn't upload the image."));
    }
    return body.images;
  },
  /** An image attached in a conversation. The session header can't go on an <img src>, so fetch it as a blob. */
  attachmentBlob: async (conversationId: string, attachmentId: string): Promise<Blob> => {
    const res = await fetch(`/api/conversations/${conversationId}/attachments/${attachmentId}`, withSession());
    if (!res.ok) throw new Error("Couldn't load the attachment");
    return res.blob();
  },
  ingest: (force = false) =>
    request<IngestResult>(
      "/api/ingest",
      withSession({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force }) }),
    ),
  /** Spoken reply (Pro). Returns an MP3 blob. */
  speak: async (text: string): Promise<Blob> => {
    const res = await fetch("/api/chat/speech", withSession({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }));
    if (!res.ok) {
      let message = "Couldn't create the voice reply.";
      try {
        const body = await res.json();
        if (typeof body.detail === "string") message = body.detail;
      } catch {
        /* no JSON body */
      }
      throw new Error(message);
    }
    return res.blob();
  },
};

/* ---- streaming chat (Server-Sent Events over fetch, so we can POST and abort) ----------------- */

export interface StreamHandlers {
  onMeta?: (meta: { conversation_id: string; title: string; model?: string }) => void;
  onStatus?: (text: string) => void;
  onImage?: (image: KbGeneratedImage) => void;
  onToken?: (token: string) => void;
  onSources?: (sources: KbSource[]) => void;
  onExternalSources?: (sources: ExternalSource[]) => void;
  onDone?: (done: ChatDone) => void;
  onError?: (message: string) => void;
}

export interface UploadedImage {
  url: string;
  public_id: string;
  bytes: number;
  format?: string;
  mime: string;
  original_name: string;
}

export async function streamChat(
  body: { message: string; conversation_id?: string; files?: File[]; images?: UploadedImage[]; model?: string },
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  // Documents travel with the question. Images are already on Cloudinary; only the link is sent.
  const form = new FormData();
  form.append("message", body.message);
  if (body.conversation_id) form.append("conversation_id", body.conversation_id);
  if (body.model) form.append("model", body.model);
  if (body.images?.length) {
    form.append(
      "cloud_images",
      JSON.stringify(
        body.images.map((img) => ({
          name: img.original_name,
          url: img.url,
          public_id: img.public_id,
          mime: img.mime,
          size: img.bytes,
        })),
      ),
    );
  }
  body.files?.forEach((f) => form.append("files", f));

  let res: Response;
  try {
    res = await fetch(
      "/api/chat",
      withSession({
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: form,
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
      else if (typeof data.detail?.message === "string") message = data.detail.message; // e.g. the guest limit
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
      case "status": handlers.onStatus?.(payload.text); break;
      case "image": handlers.onImage?.(payload); break;
      case "token": handlers.onToken?.(payload.t); break;
      case "sources": handlers.onSources?.(payload.sources); break;
      case "external_sources": handlers.onExternalSources?.(payload.sources); break;
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
