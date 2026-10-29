import { ChevronRight, FileText } from "lucide-react";
import type { KbSource } from "@/lib/types";

/** Expandable list of the passages an answer was based on. */
export default function Sources({ sources }: { sources: KbSource[] }) {
  if (sources.length === 0) return null;
  const files = new Set(sources.map((s) => s.source)).size;

  return (
    <details className="group mt-3 rounded-row border border-line bg-track/60" data-testid="kb-sources">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink">
        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90" aria-hidden />
        <span>
          Sources · {sources.length} passage{sources.length === 1 ? "" : "s"} from {files} file{files === 1 ? "" : "s"}
        </span>
      </summary>
      <ul className="space-y-2 border-t border-line p-3">
        {sources.map((s) => (
          <li key={s.chunk_id} className="rounded-md border border-line bg-panel p-2.5" data-testid="kb-source-item">
            <div className="flex flex-wrap items-center gap-2">
              <FileText className="size-3.5 shrink-0 text-lime" aria-hidden />
              <span className="min-w-0 truncate text-xs font-semibold text-ink">{s.filename}</span>
              {s.page > 0 && (
                <span className="rounded-full border border-line px-1.5 py-px font-mono text-[10px] text-ink-muted">
                  {s.page_end && s.page_end > s.page ? `pages ${s.page}–${s.page_end}` : `page ${s.page}`}
                </span>
              )}
              <span className="ml-auto font-mono text-[10px] text-ink-faint">{Math.round(s.similarity * 100)}% match</span>
            </div>
            <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-ink-muted">{s.text}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
