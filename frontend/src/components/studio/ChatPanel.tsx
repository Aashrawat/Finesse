import { memo, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRight, Copy, Play, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatClock, tokenizeTimestamps } from "@/lib/format";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  videoId: string;
  onCite: (seconds: number) => void;
  className?: string;
}

const STARTERS = [
  "Summarise this in 3 lines",
  "What are the key takeaways?",
  "Who is speaking?",
  "What does it say about …?",
];

// Chat history lives in client state per video, so it survives switching tabs on mobile
const threads = new Map<string, ChatMessage[]>();

function AssistantText({ text, onCite }: { text: string; onCite: (s: number) => void }) {
  return (
    <>
      {tokenizeTimestamps(text).map((token, i) =>
        token.type === "text" ? (
          <span key={i}>{token.value}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onCite(token.seconds)}
            data-testid={`chat-timestamp-${token.seconds}`}
            className="mx-0.5 rounded-full bg-cyan/15 px-1.5 py-px font-mono text-xs font-semibold text-cyan transition-colors duration-150 hover:bg-cyan hover:text-black"
          >
            {token.label}
          </button>
        ),
      )}
    </>
  );
}

function ChatPanel({ videoId, onCite, className }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => threads.get(videoId) ?? []);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    threads.set(videoId, messages);
  }, [videoId, messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  // Grow the composer with its content, up to 128px
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [input]);

  async function send(raw: string) {
    const question = raw.trim();
    if (!question || pending) return;

    const optimistic: ChatMessage = {
      id: crypto.randomUUID(),
      video_id: videoId,
      role: "user",
      content: question,
      citations: [],
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setInput("");
    setPending(true);
    try {
      const reply = await api.chat(videoId, question);
      setMessages((m) => [...m, reply]);
    } catch (err) {
      // Roll back the optimistic message and keep the question so it can be resent
      setMessages((m) => m.filter((msg) => msg.id !== optimistic.id));
      setInput(question);
      toast.error(err instanceof Error ? err.message : "Couldn't get an answer");
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function chooseStarter(text: string) {
    if (text.endsWith("…?")) {
      setInput(text.replace("…?", ""));
      inputRef.current?.focus();
    } else {
      void send(text);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Answer copied");
    } catch {
      toast.error("Clipboard blocked by the browser");
    }
  }

  const canSend = input.trim().length > 0 && !pending;

  return (
    <section className={cn("flex min-h-0 flex-col rounded-panel border border-line bg-panel", className)} data-testid="chat-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line p-4">
        <div>
          <h2 className="text-[22px]">Ask the reel</h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">Answers cite timestamps</p>
        </div>
        <span className="grid size-9 place-items-center rounded-row bg-cyan text-black">
          <Sparkles className="size-4" aria-hidden />
        </span>
      </div>

      <div className="studio-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite" data-testid="chat-thread">
        {messages.length === 0 && !pending && (
          <div className="space-y-2" data-testid="chat-empty">
            <p className="mb-3 text-sm text-ink-muted">Start with a question:</p>
            {STARTERS.map((text, i) => (
              <button
                key={text}
                type="button"
                onClick={() => chooseStarter(text)}
                style={{ animationDelay: `${i * 40}ms` }}
                data-testid={`chat-starter-${i}`}
                className="group flex w-full animate-rise items-center justify-between gap-3 rounded-row border border-line bg-track px-4 py-3 text-left text-sm text-ink-body transition-colors duration-150 hover:bg-panel-hover"
              >
                {text}
                <ArrowRight className="size-4 shrink-0 text-lime transition-transform duration-150 group-hover:translate-x-1" aria-hidden />
              </button>
            ))}
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-lime px-4 py-2.5 text-[15px] text-black" data-testid="chat-message-user">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={m.id} className="group max-w-[92%]">
              <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-cyan">● Reel AI</p>
              <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-line bg-subtle px-4 py-2.5 text-[15px] leading-relaxed text-ink-body" data-testid="chat-message-assistant">
                <AssistantText text={m.content} onCite={onCite} />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {m.citations.map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    onClick={() => onCite(seconds)}
                    data-testid={`chat-citation-${seconds}`}
                    className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-cyan transition-colors duration-150 hover:border-cyan"
                  >
                    <Play className="size-2.5 fill-current" aria-hidden /> {formatClock(seconds)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => copy(m.content)}
                  aria-label="Copy answer"
                  data-testid="chat-copy-button"
                  className="ml-auto grid size-7 place-items-center rounded-md text-ink-faint opacity-0 transition-[opacity,color] duration-150 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Copy className="size-3.5" aria-hidden />
                </button>
              </div>
            </div>
          ),
        )}

        {pending && (
          <div className="flex items-center gap-2" data-testid="chat-typing">
            <span className="flex gap-1 rounded-2xl rounded-tl-sm border border-line bg-subtle px-4 py-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-typing rounded-full bg-cyan" style={{ animationDelay: `${i * 160}ms` }} />
              ))}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">scanning reel</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-end gap-2 border-t border-line p-3"
      >
        <label className="flex-1">
          <span className="sr-only">Ask a question about this reel</span>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about this reel…"
            data-testid="chat-input"
            className="block max-h-32 w-full resize-none rounded-row border border-line bg-track px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-faint focus:border-lime focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          data-testid="chat-submit-button"
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-row transition-[transform,background-color] duration-150 active:scale-95",
            canSend ? "bg-lime text-black" : "cursor-not-allowed bg-line text-ink-faint",
          )}
        >
          <Send className="size-4" aria-hidden />
        </button>
      </form>
    </section>
  );
}

export default memo(ChatPanel);
