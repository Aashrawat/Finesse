import { ArrowUpRight, Globe } from "lucide-react";
import type { ExternalSource } from "@/lib/types";

export default function ExternalSources({ sources }: { sources: ExternalSource[] }) {
  const links = sources.filter((source) => /^https?:\/\//i.test(source.url));
  if (!links.length) return null;
  return (
    <div className="mt-4 border-t border-line/60 pt-3" data-testid="external-sources">
      <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-ink-faint"><Globe className="size-3" aria-hidden /> Sources</p>
      <div className="flex flex-wrap gap-2">
        {links.map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-muted transition-colors hover:border-lime/50 hover:text-ink">
            <span className="max-w-[240px] truncate">{source.title}</span><ArrowUpRight className="size-3 shrink-0" aria-hidden />
          </a>
        ))}
      </div>
    </div>
  );
}
