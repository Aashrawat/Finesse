import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AppWindow, ChevronRight, ChevronUp, CircleArrowUp, CircleHelp, Globe, Info, LogOut, Settings } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth/AuthProvider";
import { cn } from "@/lib/utils";

const REPO = "https://github.com/Aashrawat/AI-Video-Assistant";

const itemClass =
  "flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm text-ink-body transition-colors duration-150 hover:bg-panel-hover hover:text-ink focus-visible:bg-panel-hover focus-visible:text-ink";

function Separator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}

/**
 * Bottom of every left sidebar. Logged out: "Log in" and "Sign up". Logged in: your name and plan,
 * which opens the account menu.
 */
export default function AccountMenu() {
  const { user, loading, openAuth, openSettings, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  function close(returnFocus = false) {
    setOpen(false);
    setLearnOpen(false);
    if (returnFocus) trigger.current?.focus();
  }

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Focus the first item when the menu opens
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  function onMenuKey(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(index + 1);
    else if (e.key === "ArrowUp") go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Tab") close();
  }

  const soon = (message: string) => {
    close();
    toast(message);
  };

  if (loading) {
    return (
      <div className="shrink-0 border-t border-line pt-3" aria-hidden>
        <div className="h-11 animate-pulse rounded-row bg-panel" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="shrink-0 border-t border-line pt-3" data-testid="account-guest">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => openAuth("login")}
            data-testid="account-login"
            className="h-10 rounded-row border border-line text-sm font-semibold text-ink transition-colors duration-150 hover:border-lime/60 hover:bg-lime/[0.06]"
          >
            Log in
          </button>
          <button
            type="button"
            onClick={() => openAuth("signup")}
            data-testid="account-signup"
            className="h-10 rounded-row bg-lime text-sm font-bold text-black transition-shadow duration-150 hover:shadow-[0_0_20px_rgba(204,255,0,0.3)]"
          >
            Sign up
          </button>
        </div>
      </div>
    );
  }

  const initial = (user.name.trim()[0] ?? "?").toUpperCase();
  const plan = user.plan.charAt(0).toUpperCase() + user.plan.slice(1);
  const link = (href: string, icon: ReactNode, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" role="menuitem" onClick={() => close()} className={itemClass}>
      {icon}
      <span className="flex-1">{label}</span>
    </a>
  );

  return (
    <div ref={root} className="relative shrink-0 border-t border-line pt-3" data-testid="account-menu-root">
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKey}
          data-testid="account-menu"
          className="absolute inset-x-0 bottom-[calc(100%-0.25rem)] z-50 animate-rise rounded-panel border border-line bg-panel p-1.5 shadow-2xl"
        >
          <p className="truncate px-2.5 pb-1.5 pt-1.5 text-xs text-ink-muted" data-testid="account-email">
            {user.email}
          </p>

          <button type="button" role="menuitem" onClick={() => { close(); openSettings(); }} data-testid="account-settings" className={itemClass}>
            <Settings className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Settings</span>
            <kbd className="font-sans text-[11px] text-ink-faint">Ctrl+Shift+,</kbd>
          </button>
          <button type="button" role="menuitem" onClick={() => soon("More languages are coming soon. Finesse is in English for now.")} className={itemClass}>
            <Globe className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Language</span>
          </button>
          {link(`${REPO}/issues`, <CircleHelp className="size-4 shrink-0 text-ink-muted" aria-hidden />, "Get help")}

          <Separator />

          <button type="button" role="menuitem" onClick={() => soon("Finesse is free for now. Paid plans aren't available yet.")} className={itemClass}>
            <CircleArrowUp className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Upgrade plan</span>
          </button>
          <button type="button" role="menuitem" onClick={() => soon("Apps and extensions are coming soon.")} className={itemClass}>
            <AppWindow className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Get apps and extensions</span>
          </button>
          <button
            type="button"
            role="menuitem"
            aria-expanded={learnOpen}
            onClick={() => setLearnOpen((v) => !v)}
            data-testid="account-learn"
            className={itemClass}
          >
            <Info className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Learn more</span>
            <ChevronRight className={cn("size-4 shrink-0 text-ink-faint transition-transform duration-150", learnOpen && "rotate-90")} aria-hidden />
          </button>
          {learnOpen && (
            <div className="ml-4 border-l border-line pl-1.5" data-testid="account-learn-links">
              {link(REPO, <span className="size-4 shrink-0" aria-hidden />, "About Finesse")}
              {link(`${REPO}/issues/new`, <span className="size-4 shrink-0" aria-hidden />, "Report an issue")}
            </div>
          )}

          <Separator />

          <button type="button" role="menuitem" onClick={() => { close(); void logout(); }} data-testid="account-logout" className={itemClass}>
            <LogOut className="size-4 shrink-0 text-ink-muted" aria-hidden />
            <span className="flex-1">Log out</span>
          </button>
        </div>
      )}

      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="account-trigger"
        className={cn(
          "flex h-11 w-full items-center gap-2.5 rounded-row px-2 text-left transition-colors duration-150 hover:bg-panel-hover",
          open && "bg-panel-hover",
        )}
      >
        <span
          className="grid size-7 shrink-0 place-items-center rounded-full bg-panel-hover font-heading text-sm font-bold text-ink ring-1 ring-line"
          aria-hidden
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" data-testid="account-name">
          {user.name}
        </span>
        <span className="shrink-0 text-xs text-ink-muted" data-testid="account-plan">
          · {plan}
        </span>
        <ChevronUp className={cn("size-4 shrink-0 text-ink-faint transition-transform duration-150", !open && "rotate-180")} aria-hidden />
      </button>
    </div>
  );
}
