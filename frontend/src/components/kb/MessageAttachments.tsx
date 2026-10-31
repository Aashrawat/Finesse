import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { kbApi } from "@/lib/kbApi";
import type { KbAttachment } from "@/lib/types";

export const formatSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const fileLabel = (a: { name: string; mime: string }) =>
  a.mime === "application/pdf" || /\.pdf$/i.test(a.name) ? "PDF" : (a.name.split(".").pop() ?? "File").toUpperCase();

/** The image for a sent message: the local preview if we just sent it, else fetched from the server. */
function useImageUrl(conversationId: string | undefined, a: KbAttachment): string | null {
  const [url, setUrl] = useState<string | null>(a.previewUrl ?? null);

  useEffect(() => {
    if (a.previewUrl) {
      setUrl(a.previewUrl);
      return;
    }
    if (!conversationId) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    kbApi
      .attachmentBlob(conversationId, a.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [conversationId, a.id, a.previewUrl]);

  return url;
}

function ImageThumb({ conversationId, attachment }: { conversationId?: string; attachment: KbAttachment }) {
  const url = useImageUrl(conversationId, attachment);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom]);

  if (!url) return <div className="size-28 animate-pulse rounded-xl bg-panel" aria-label={`Loading ${attachment.name}`} />;

  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label={`Enlarge ${attachment.name}`}
        className="overflow-hidden rounded-xl border border-line"
      >
        <img src={url} alt={attachment.name} className="size-28 object-cover md:size-36" />
      </button>
      {zoom && (
        <div className="fixed inset-0 z-[70] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={attachment.name}>
          <button type="button" aria-label="Close" onClick={() => setZoom(false)} className="absolute inset-0 bg-black/85" />
          <img src={url} alt={attachment.name} className="relative max-h-[90dvh] max-w-[92vw] rounded-lg object-contain" />
          <button
            type="button"
            onClick={() => setZoom(false)}
            aria-label="Close"
            className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-panel text-ink hover:bg-panel-hover"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}

/** Files attached to a user message: image thumbnails and document chips. */
export default function MessageAttachments({
  attachments,
  conversationId,
}: {
  attachments: KbAttachment[];
  conversationId?: string;
}) {
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.kind === "image");
  const documents = attachments.filter((a) => a.kind === "document");

  return (
    <div className="flex flex-col items-end gap-2" data-testid="kb-message-attachments">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {images.map((a) => (
            <ImageThumb key={a.id} conversationId={conversationId} attachment={a} />
          ))}
        </div>
      )}
      {documents.map((a) => (
        <div key={a.id} className="flex max-w-full items-center gap-3 rounded-xl border border-line bg-panel py-2 pl-2.5 pr-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-lime/10 text-lime">
            <FileText className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block max-w-[220px] truncate text-sm font-medium text-ink">{a.name}</span>
            <span className="block text-xs text-ink-muted">
              {fileLabel(a)} · {formatSize(a.size)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
