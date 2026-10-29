import { AudioLines, Film, SquarePlay } from "lucide-react";
import type { SourceType } from "@/lib/types";
import { cn } from "@/lib/utils";

const BADGES: Record<SourceType, { label: string; className: string; Icon: typeof SquarePlay }> = {
  youtube: { label: "YouTube", className: "bg-src-youtube text-white", Icon: SquarePlay },
  audio: { label: "Audio", className: "bg-src-audio text-black", Icon: AudioLines },
  video: { label: "Video", className: "bg-src-video text-white", Icon: Film },
};

export default function SourceBadge({ type, className }: { type: SourceType; className?: string }) {
  const { label, className: colours, Icon } = BADGES[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider",
        colours,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden /> {label}
    </span>
  );
}
