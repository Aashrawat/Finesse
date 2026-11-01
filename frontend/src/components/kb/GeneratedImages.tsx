import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { useImageUrl } from "@/components/kb/MessageAttachments";
import type { KbGeneratedImage } from "@/lib/types";

function GeneratedImage({ conversationId, image }: { conversationId?: string; image: KbGeneratedImage }) {
  const url = useImageUrl(conversationId, { id: image.id, name: image.name, kind: "image", mime: image.mime, size: image.size });
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [zoom]);

  if (!url) {
    return <div className="aspect-square w-full max-w-md animate-pulse rounded-xl bg-panel" aria-label="Loading the generated image" />;
  }

  const alt = image.prompt ? `Generated image: ${image.prompt}` : "Generated image";
  return (
    <>
      <div className="group/img relative w-full max-w-md" data-testid="kb-generated-image">
        <button
          type="button"
          onClick={() => setZoom(true)}
          aria-label="Enlarge the generated image"
          className="block w-full overflow-hidden rounded-xl border border-line"
        >
          <img src={url} alt={alt} className="h-auto w-full" />
        </button>
        <a
          href={url}
          download={`finesse-${image.id}.png`}
          aria-label="Download image"
          title="Download"
          className="absolute right-2 top-2 grid size-9 place-items-center rounded-full bg-black/60 text-white opacity-0 backdrop-blur transition-opacity duration-150 hover:bg-black/80 focus-visible:opacity-100 group-hover/img:opacity-100"
        >
          <Download className="size-4" aria-hidden />
        </a>
      </div>
      {zoom && (
        <div className="fixed inset-0 z-[70] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label="Generated image">
          <button type="button" aria-label="Close" onClick={() => setZoom(false)} className="absolute inset-0 bg-black/85" />
          <img src={url} alt={alt} className="relative max-h-[90dvh] max-w-[92vw] rounded-lg object-contain" />
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

/** Pictures the chatbot made, shown above the text of its answer. */
export default function GeneratedImages({ images, conversationId }: { images: KbGeneratedImage[]; conversationId?: string }) {
  if (images.length === 0) return null;
  return (
    <div className="mb-3 flex flex-col gap-3" data-testid="kb-generated-images">
      {images.map((image) => (
        <GeneratedImage key={image.id} conversationId={conversationId} image={image} />
      ))}
    </div>
  );
}
