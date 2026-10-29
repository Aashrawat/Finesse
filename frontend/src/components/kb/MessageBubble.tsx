import { memo, useState } from "react";
import { AlertTriangle, Check, Copy, Square } from "lucide-react";
import Markdown from "@/components/research/Markdown";
import Sources from "@/components/kb/Sources";
import type { KbMessage } from "@/lib/types";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-2" role="status" aria-label="Assistant is typing" data-testid="kb-typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-typing rounded-full bg-ink-muted"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

function MessageBubble({ message }: { message: KbMessage }) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end" data-testid="kb-message-user">
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-panel-hover px-4 py-2.5 text-[15px] leading-relaxed text-ink md:max-w-[75%]">
          {message.content}
        </div>
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const waiting = message.streaming && !message.content && !message.error;

  return (
    <div className="group flex gap-3" data-testid="kb-message-assistant" data-streaming={message.streaming ? "true" : "false"}>
      <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-line bg-panel">
        <img src="/logo.png" alt="" className="h-4 w-auto" />
      </div>

      <div className="min-w-0 flex-1">
        {waiting && <TypingDots />}

        {message.content && (
          <div data-testid="kb-answer">
            <Markdown text={message.content} />
            {message.streaming && (
              <span
                className="ml-0.5 inline-block h-4 w-[7px] translate-y-0.5 animate-rec-blink bg-lime align-baseline"
                aria-hidden
                data-testid="kb-cursor"
              />
            )}
          </div>
        )}

        {message.error && (
          <div
            role="alert"
            data-testid="kb-error"
            className="mt-1 flex items-start gap-2 rounded-row border border-danger/40 bg-danger/[0.06] px-3 py-2 text-sm text-danger"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{message.error}</span>
          </div>
        )}

        {message.stopped && (
          <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[11px] text-ink-faint" data-testid="kb-stopped">
            <Square className="size-3 fill-current" aria-hidden /> Generation stopped
          </p>
        )}

        {!message.streaming && <Sources sources={message.sources} />}

        {!message.streaming && message.content && (
          <div className="mt-2 flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={copy}
              aria-label="Copy answer"
              data-testid="kb-copy-answer"
              className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-ink-faint transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              {copied ? <Check className="size-3.5 text-lime" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
