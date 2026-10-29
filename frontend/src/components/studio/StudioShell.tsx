import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { Clapperboard, FlaskConical, MessagesSquare, PanelLeft, X } from "lucide-react";
import { cn } from "@/lib/utils";
import HistorySidebar from "@/components/studio/HistorySidebar";
import { useMediaQuery } from "@/hooks/useMediaQuery";

const SIDEBAR_KEY = "finesse.archive";

const modeClass = (active: boolean) =>
  cn(
    "inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors duration-150",
    active ? "bg-lime text-black" : "text-ink-muted hover:bg-panel-hover hover:text-ink",
  );

export default function StudioShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // On wide screens the archive is a column that can be collapsed (remembered); on narrow ones it is a drawer
  const wide = useMediaQuery("(min-width: 1360px)");
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "closed";
    } catch {
      return false;
    }
  });
  const { id } = useParams();
  const location = useLocation();
  const researchMode = location.pathname.startsWith("/research");
  const chatMode = location.pathname.startsWith("/chat");
  const videoMode = !researchMode && !chatMode;
  // Chat has its own conversation list; the other two tools get the shared archive sidebar
  const hasSidebar = !chatMode;
  const sidebarMode = researchMode ? "research" : "video";
  const columnOpen = hasSidebar && wide && !collapsed;

  function toggleSidebar() {
    if (!wide) return setDrawerOpen(true);
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "closed" : "open");
    } catch {
      /* storage blocked: it just won't be remembered */
    }
  }

  // Close the drawer on navigation and with Escape
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-[rgba(11,12,16,0.85)] backdrop-blur-[24px]">
        <div className="flex h-full items-center gap-3 px-4 md:px-8">
          <Link to="/" className="group flex items-center gap-2.5" data-testid="shell-logo-link" aria-label="Finesse home">
            <img
              src="/logo.png"
              alt=""
              width={36}
              height={41}
              className="h-9 w-auto transition-transform duration-150 group-hover:scale-105"
              data-testid="shell-logo-image"
            />
            <span className="hidden font-heading text-lg font-bold tracking-tight text-ink md:inline">
              Finesse
            </span>
          </Link>

          {hasSidebar && (
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={wide ? (collapsed ? "Show archive" : "Hide archive") : "Open archive"}
              aria-expanded={wide ? !collapsed : drawerOpen}
              title="Archive"
              data-testid="nav-archive-button"
              className="grid size-9 place-items-center rounded-row text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              <PanelLeft className="size-4" aria-hidden />
            </button>
          )}

          {/* Pick the tool: AI video assistant, multi-agent research, or knowledge-base chat.
              On phones only the active tool shows its label, to keep the header on one line. */}
          <div
            className="mx-auto flex gap-1 rounded-row bg-track p-1"
            role="navigation"
            aria-label="Tool"
            data-testid="mode-switcher"
          >
            <NavLink
              to="/chat"
              data-testid="mode-chat"
              aria-label="Chat"
              className={() => modeClass(chatMode)}
              aria-current={chatMode ? "page" : undefined}
            >
              <MessagesSquare className="size-4" aria-hidden />
              <span className={chatMode ? "inline" : "hidden sm:inline"}>Chat</span>
            </NavLink>
            <NavLink
              to="/"
              data-testid="mode-video"
              aria-label="AI Video Assistant"
              className={() => modeClass(videoMode)}
              aria-current={videoMode ? "page" : undefined}
            >
              <Clapperboard className="size-4" aria-hidden />
              <span className={videoMode ? "inline" : "hidden sm:inline"}>
                <span className="hidden sm:inline">AI Video Assistant</span>
                <span className="sm:hidden">Video</span>
              </span>
            </NavLink>
            <NavLink
              to="/research"
              data-testid="mode-research"
              aria-label="Research"
              className={() => modeClass(researchMode)}
              aria-current={researchMode ? "page" : undefined}
            >
              <FlaskConical className="size-4" aria-hidden />
              <span className={researchMode ? "inline" : "hidden sm:inline"}>Research</span>
            </NavLink>
          </div>

        </div>
      </header>

      {hasSidebar ? (
        <div className="flex min-h-0 flex-1">
          {/* Archive column (wide screens): stays in view while the page scrolls */}
          {columnOpen && (
            <aside
              className="sticky top-14 h-[calc(100dvh-3.5rem)] w-[300px] shrink-0 self-start border-r border-line bg-page"
              aria-label="Archive"
              data-testid="archive-sidebar"
            >
              <HistorySidebar mode={sidebarMode} activeId={id} />
            </aside>
          )}
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </div>
      ) : (
        children
      )}

      {/* Archive drawer (narrow screens; opens from the left) */}
      {hasSidebar && drawerOpen && !wide && (
        <div className="fixed inset-0 z-50" data-testid="archive-drawer">
          <button
            type="button"
            aria-label="Close archive"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Archive"
            className="absolute inset-y-0 left-0 w-[min(340px,92vw)] border-r border-line bg-page"
          >
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close archive"
              data-testid="archive-close-button"
              className="absolute right-2 top-2 z-10 grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
            <div className="h-full pt-11">
              <HistorySidebar mode={sidebarMode} activeId={id} onNavigate={() => setDrawerOpen(false)} autoFocusSearch />
            </div>
          </aside>
        </div>
      )}    </div>
  );
}
