import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, ChevronDown, LockKeyhole } from "lucide-react";
import FinesseMark from "@/components/FinesseMark";
import type { ChatModel } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  models: ChatModel[];
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

export default function ModelPicker({ models, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, bottom: 0, width: 288, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = models.find((model) => model.id === value);
  const locked = models.some((model) => !model.available);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(288, window.innerWidth - 32);
      setPosition({
        left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)),
        bottom: window.innerHeight - rect.top + 8,
        width,
        maxHeight: Math.max(100, rect.top - 24),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const active = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
      (active ?? menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();
    });
    const onOutside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onOutside);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === "Tab") { setOpen(false); return; }
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled), [role="menuitem"]') ?? []);
    const current = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === "ArrowDown") next = (current + 1) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="ml-auto min-w-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        }}
        disabled={disabled || models.length === 0}
        aria-label={`Choose model, current model ${selected?.name ?? "loading"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-testid="kb-model-picker"
        className="inline-flex h-8 max-w-[160px] items-center gap-1.5 rounded-lg border border-line bg-track/60 px-2 text-[11px] text-ink-muted transition-colors hover:bg-panel-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        <FinesseMark className="hidden size-3 shrink-0 sm:block" />
        <span className="truncate">{selected?.name ?? "Model"}</span>
        <ChevronDown className={cn("size-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Chat models"
          onKeyDown={onKeyDown}
          data-testid="kb-model-menu"
          style={position}
          className="studio-scroll fixed z-[60] overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-2xl"
        >
          <p className="px-3 pb-2 pt-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-faint">Choose a model</p>
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={model.id === value}
              disabled={!model.available}
              tabIndex={-1}
              onClick={() => { onChange(model.id); setOpen(false); trigger.current?.focus(); }}
              data-testid={`model-option-${model.id}`}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-panel-hover focus-visible:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-55"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-medium text-ink">
                  {model.name}
                  {model.pro_only && <span className="rounded border border-lime/25 px-1 py-px text-[8px] uppercase tracking-wider text-lime">Pro</span>}
                </span>
                <span className="mt-1 block text-[10px] leading-relaxed text-ink-muted">{model.description}</span>
              </span>
              {!model.available ? <LockKeyhole className="size-3.5 shrink-0 text-ink-faint" aria-hidden /> : model.id === value ? <Check className="size-4 shrink-0 text-lime" aria-hidden /> : null}
            </button>
          ))}
          {locked && (
            <Link to="/pricing" role="menuitem" tabIndex={-1} onClick={() => setOpen(false)} data-testid="model-upgrade" className="mt-1 flex items-center justify-between gap-2 border-t border-line px-3 py-3 text-xs font-medium text-lime hover:underline">
              Unlock smarter models with Pro <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
