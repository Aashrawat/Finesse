import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, PanelLeft, X } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import ConversationSidebar from "@/components/kb/ConversationSidebar";
import MessageBubble from "@/components/kb/MessageBubble";
import Composer from "@/components/kb/Composer";
import { kbApi, streamChat } from "@/lib/kbApi";
import type { KbMessage } from "@/lib/types";

const uid = () => Math.random().toString(36).slice(2, 12);

export default function KbChat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // "New chat" navigates with a fresh token so it resets the screen even when the URL doesn't change
  // (e.g. after a failed first message, when no conversation was ever created).
  const fresh = (location.state as { fresh?: number } | null)?.fresh;

  const [messages, setMessages] = useState<KbMessage[]>([]);
  const [title, setTitle] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const skipLoadFor = useRef<string | null>(null); // a conversation we just created: its messages are already on screen
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow the stream unless the user scrolled up

  // ---- load a conversation when the URL changes -------------------------------------------
  useEffect(() => {
    if (skipLoadFor.current && skipLoadFor.current === id) {
      skipLoadFor.current = null;
      return;
    }
    abortRef.current?.abort(); // switching chats stops any running generation
    setStreaming(false);
    setMissing(false);

    if (!id) {
      setMessages([]);
      setTitle("");
      stick.current = true;
      return;
    }

    let cancelled = false;
    setLoading(true);
    kbApi
      .getConversation(id)
      .then((conv) => {
        if (cancelled) return;
        setMessages(conv.messages);
        setTitle(conv.title);
        stick.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setMissing(true);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, fresh]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ---- auto-scroll -------------------------------------------------------------------------
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = away < 80;
    setShowJump(away > 240);
  }, []);

  const jumpToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stick.current = true;
  };

  // ---- sending ------------------------------------------------------------------------------
  async function send(text: string) {
    if (streaming) return;
    const assistantId = uid();
    const patch = (update: (m: KbMessage) => KbMessage) =>
      setMessages((all) => all.map((m) => (m.id === assistantId ? update(m) : m)));

    setMessages((all) => [
      ...all,
      { id: uid(), role: "user", content: text, sources: [], created_at: new Date().toISOString() },
      { id: assistantId, role: "assistant", content: "", sources: [], created_at: new Date().toISOString(), streaming: true },
    ]);
    stick.current = true;
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Tokens arrive faster than the screen refreshes: collect them and render once per frame.
    let pending = "";
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      patch((m) => ({ ...m, content: m.content + chunk }));
    };

    try {
      await streamChat(
        { message: text, conversation_id: id },
        {
          onMeta: (meta) => {
            setTitle((t) => t || meta.title);
            if (!id) {
              // First message of a new chat: move to /chat/:id without reloading what's on screen
              skipLoadFor.current = meta.conversation_id;
              navigate(`/chat/${meta.conversation_id}`, { replace: true });
            }
          },
          onToken: (t) => {
            pending += t;
            if (!frame) frame = requestAnimationFrame(flush);
          },
          onSources: (sources) => {
            cancelAnimationFrame(frame);
            flush();
            patch((m) => ({ ...m, sources }));
          },
          onError: (message) => {
            cancelAnimationFrame(frame);
            flush();
            patch((m) => ({ ...m, error: message }));
          },
        },
        controller.signal,
      );
    } catch (err) {
      cancelAnimationFrame(frame);
      flush();
      if ((err as Error).name === "AbortError") {
        patch((m) => ({ ...m, stopped: true }));
      } else {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        patch((m) => ({ ...m, error: message }));
        if (!id) toast.error(message);
      }
    } finally {
      cancelAnimationFrame(frame);
      flush();
      patch((m) => ({ ...m, streaming: false }));
      if (abortRef.current === controller) {
        abortRef.current = null;
        setStreaming(false);
      }
      queryClient.invalidateQueries({ queryKey: ["kb-conversations"] });
    }
  }

  const stop = () => abortRef.current?.abort();
  const empty = messages.length === 0 && !loading;

  return (
    <StudioShell>
      <div className="relative flex h-[calc(100dvh-3.5rem)] min-h-0" data-testid="kb-chat">
        {/* Conversation list: fixed column on large screens, drawer on small ones */}
        <aside className="hidden w-[300px] shrink-0 border-r border-line bg-page lg:block" aria-label="Conversations">
          <ConversationSidebar activeId={id} />
        </aside>

        {drawerOpen && (
          <div className="fixed inset-0 top-14 z-30 lg:hidden" data-testid="kb-drawer">
            <button type="button" aria-label="Close conversations" onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-black/60" />
            <aside className="absolute inset-y-0 left-0 w-[min(320px,88vw)] border-r border-line bg-page" aria-label="Conversations">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
                className="absolute right-2 top-2 z-10 grid size-8 place-items-center rounded-md text-ink-muted hover:bg-panel-hover hover:text-ink"
              >
                <X className="size-4" aria-hidden />
              </button>
              <ConversationSidebar activeId={id} onNavigate={() => setDrawerOpen(false)} />
            </aside>
          </div>
        )}

        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open conversations"
              data-testid="kb-drawer-toggle"
              className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink lg:hidden"
            >
              <PanelLeft className="size-4" aria-hidden />
            </button>
            <h1 className="truncate font-heading text-base font-semibold text-ink" data-testid="kb-title">
              {title || "New chat"}
            </h1>
          </div>

          <div ref={scroller} onScroll={onScroll} className="studio-scroll min-h-0 flex-1 overflow-y-auto" data-testid="kb-scroll">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 py-6 md:px-6">
              {loading && (
                <div className="space-y-4" aria-label="Loading conversation">
                  {[0, 1].map((i) => <div key={i} className="h-16 animate-pulse rounded-panel bg-panel" />)}
                </div>
              )}

              {missing && (
                <div className="m-auto text-center" data-testid="kb-missing">
                  <h2 className="text-2xl">That chat doesn't exist</h2>
                  <p className="mt-2 text-sm text-ink-muted">It may have been deleted, or it belongs to another browser.</p>
                  <button
                    type="button"
                    onClick={() => navigate("/chat")}
                    className="mt-4 h-10 rounded-row bg-lime px-5 font-heading text-sm font-bold text-black"
                  >
                    Start a new chat
                  </button>
                </div>
              )}

              {empty && !missing && (
                <div className="m-auto w-full animate-rise text-center" data-testid="kb-empty">
                  <h2 className="text-3xl md:text-4xl">Ask anything?</h2>
                </div>
              )}

              {messages.length > 0 && (
                <div className="space-y-6" role="log" aria-live="polite" aria-label="Conversation" data-testid="kb-messages">
                  {messages.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {showJump && (
            <button
              type="button"
              onClick={jumpToEnd}
              aria-label="Scroll to latest"
              data-testid="kb-jump"
              className="absolute bottom-28 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-line bg-panel text-ink shadow-lg transition-colors duration-150 hover:bg-panel-hover"
            >
              <ArrowDown className="size-4" aria-hidden />
            </button>
          )}

          <Composer streaming={streaming} onSend={send} onStop={stop} focusKey={id ?? "new"} />
        </section>
      </div>
    </StudioShell>
  );
}
