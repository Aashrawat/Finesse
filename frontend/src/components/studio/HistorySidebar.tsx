import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import AccountMenu from "@/components/auth/AccountMenu";
import HistoryList from "@/components/studio/HistoryList";
import ResearchHistory from "@/components/research/ResearchHistory";

interface Props {
  mode: "video" | "research";
  activeId?: string;
  /** Called after a row (or the New button) is used, so a mobile drawer can close. */
  onNavigate?: () => void;
  autoFocusSearch?: boolean;
}

/** The left-hand archive column: a "New" button and the past reels / research reports. */
export default function HistorySidebar({ mode, activeId, onNavigate, autoFocusSearch }: Props) {
  const research = mode === "research";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3" data-testid="history-sidebar">
      <Link
        to={research ? "/research" : "/video"}
        onClick={onNavigate}
        data-testid={research ? "nav-new-research" : "nav-new-reel"}
        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-row border border-line text-sm font-semibold text-ink transition-colors duration-150 hover:border-lime/60 hover:bg-lime/[0.06]"
      >
        <Plus className="size-4" aria-hidden /> {research ? "New research" : "New"}
      </Link>

      <p className="shrink-0 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">Archive</p>

      <div className="flex min-h-0 flex-1 flex-col">
        {research ? (
          <ResearchHistory activeId={activeId} onOpen={onNavigate} />
        ) : (
          <HistoryList activeId={activeId} onOpen={onNavigate} autoFocusSearch={autoFocusSearch} />
        )}
      </div>

      <AccountMenu />
    </div>
  );
}
