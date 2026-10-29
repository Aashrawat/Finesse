import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_CHARS = 4000;

interface Props {
  streaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Focus the box whenever this changes (e.g. a new chat was opened). */
  focusKey?: string;
}

export default function Composer({ streaming, onSend, onStop, focusKey }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to ~8 lines
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => ref.current?.focus(), [focusKey]);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !streaming && text.length <= MAX_CHARS;

  function submit() {
    if (!canSend) return;
    onSend(trimmed);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="px-4 pb-4 pt-2 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 transition-colors duration-150 focus-within:border-lime/50">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <textarea
              ref={ref}
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask Finesse"
              data-testid="kb-input"
              className="no-focus-ring block max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </label>

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              data-testid="kb-stop-button"
              className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-black transition-transform duration-150 active:scale-95"
            >
              <Square className="size-4 fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
              data-testid="kb-send-button"
              className={cn(
                "grid size-10 shrink-0 place-items-center rounded-xl transition-[transform,opacity,background-color] duration-150 active:scale-95",
                canSend ? "bg-lime text-black hover:shadow-[0_0_20px_rgba(204,255,0,0.3)]" : "bg-panel-hover text-ink-faint",
              )}
            >
              <ArrowUp className="size-5" aria-hidden />
            </button>
          )}
        </div>

        {text.length > MAX_CHARS * 0.9 && (
          <p className="mt-2 text-center text-[11px]">
            <span className={text.length > MAX_CHARS ? "text-danger" : "text-amber"}>
              {text.length}/{MAX_CHARS} characters
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
