import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ChevronRight, PanelLeft, X } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import ConversationSidebar from "@/components/kb/ConversationSidebar";
import MessageBubble from "@/components/kb/MessageBubble";
import Composer from "@/components/kb/Composer";
import ChatWelcome from "@/components/kb/ChatWelcome";
import { GuestUsage, LoginWall, PlanLimitWall, PlanUsage } from "@/components/kb/GuestLimit";
import { useAuth } from "@/components/auth/AuthProvider";
import { kbApi, streamChat } from "@/lib/kbApi";
import type { KbAttachment, KbMessage } from "@/lib/types";

const uid = () => Math.random().toString(36).slice(2, 12);

export default function KbChat() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Visitors who aren't logged in get a small free allowance (2 files, 1000 tokens); the server counts it.
  // The key includes the user so logging in or out fetches it again.
  const { data: quota } = useQuery({
    queryKey: ["kb-quota", user?.id ?? "guest"],
    queryFn: kbApi.quota,
    staleTime: 0,
    retry: false,
  });
  const guestBlocked = !user && !!quota?.guest && quota.blocked;
  // A logged-in user's daily messages are limited by their plan
  const planBlocked = !!user && !!quota && !quota.guest && quota.blocked;
  const guestFilesLeft =
    !user && quota?.guest ? Math.max(0, (quota.files_limit ?? 0) - (quota.files_used ?? 0)) : undefined;

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
  const [draft, setDraft] = useState<{ text: string; key: number }>();
  const [selectedModel, setSelectedModel] = useState("");
  const activeModel = quota?.models?.find((model) => model.id === selectedModel && model.available)?.id ?? quota?.model ?? "";

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

  useEffect(() => {
    if (!drawerOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const drawer = document.querySelector<HTMLElement>('[data-testid="kb-drawer-panel"]');
    drawer?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
      if (event.key !== "Tab" || !drawer) return;
      const items = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, [tabindex="0"]'));
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [drawerOpen]);

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
  async function send(text: string, files: File[]) {
    if (streaming) return;
    const requestedModel = activeModel || undefined;
    const images = files.filter((f) => f.type.startsWith("image/"));
    const documents = files.filter((f) => !f.type.startsWith("image/"));
    let hosted: Awaited<ReturnType<typeof kbApi.uploadImages>> = [];
    try {
      if (images.length) hosted = await kbApi.uploadImages(images);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload the image.");
      return;
    }

    const assistantId = uid();
    const patch = (update: (m: KbMessage) => KbMessage) =>
      setMessages((all) => all.map((m) => (m.id === assistantId ? update(m) : m)));

    // Photos are already on Cloudinary. Show a local preview now; the conversation keeps the URL and public id.
    let imageIndex = 0;
    const attachments: KbAttachment[] = files.map((f) => {
      const isImage = f.type.startsWith("image/");
      const uploaded = isImage ? hosted[imageIndex++] : undefined;
      return {
        id: uid(),
        name: f.name,
        kind: isImage ? "image" : "document",
        mime: f.type || uploaded?.mime || "",
        size: f.size,
        previewUrl: isImage ? URL.createObjectURL(f) : undefined,
        url: uploaded?.url,
        public_id: uploaded?.public_id,
      };
    });

    setMessages((all) => [
      ...all,
      { id: uid(), role: "user", content: text, sources: [], created_at: new Date().toISOString(), attachments },
      { id: assistantId, role: "assistant", content: "", sources: [], created_at: new Date().toISOString(), streaming: true, model: requestedModel },
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
      patch((m) => ({ ...m, content: m.content + chunk, status: undefined }));
    };

    try {
      await streamChat(
        { message: text, conversation_id: id, files: documents, images: hosted, model: requestedModel },
        {
          onStatus: (status) => patch((m) => ({ ...m, status })),
          onImage: (image) => patch((m) => ({ ...m, images: [...(m.images ?? []), image] })),
          onMeta: (meta) => {
            if (meta.model) patch((message) => ({ ...message, model: meta.model }));
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
          onExternalSources: (external_sources) => patch((message) => ({ ...message, external_sources })),
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
      queryClient.invalidateQueries({ queryKey: ["kb-quota"] }); // the turn may have used up the guest allowance or the day's messages
    }
  }

  const stop = () => abortRef.current?.abort();
  const empty = messages.length === 0 && !loading;

  return (
    <StudioShell>
      <div className="relative flex h-[calc(100dvh-3.5rem)] min-h-0" data-testid="kb-chat">
        {/* Conversation list: fixed column on large screens, drawer on small ones */}
        <aside className="conversation-rail hidden w-[264px] shrink-0 border-r border-line lg:block" aria-label="Conversations">
          <ConversationSidebar activeId={id} />
        </aside>

        {drawerOpen && (
          <div className="fixed inset-0 top-14 z-30 lg:hidden" data-testid="kb-drawer">
            <button type="button" aria-label="Close conversations" onClick={() => setDrawerOpen(false)} className="absolute inset-0 bg-black/60" />
            <aside className="conversation-rail absolute inset-y-0 left-0 w-[min(320px,88vw)] border-r border-line pt-8" role="dialog" aria-modal="true" aria-label="Conversations" data-testid="kb-drawer-panel">
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

        <section className="chat-canvas relative flex min-w-0 flex-1 flex-col" aria-label="Chat workspace">
          <div className="flex h-14 shrink-0 items-center gap-2 px-3 md:px-7">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open conversations"
              aria-expanded={drawerOpen}
              data-testid="kb-drawer-toggle"
              className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink lg:hidden"
            >
              <PanelLeft className="size-4" aria-hidden />
            </button>
            <span className="hidden text-xs text-ink-faint sm:inline">Your workspace</span>
            <ChevronRight className="hidden size-3 text-ink-faint sm:block" aria-hidden />
            <h1 className="truncate font-body text-xs font-medium text-ink-muted" data-testid="kb-title">
              {title || "New conversation"}
            </h1>
            <span className="ml-auto hidden shrink-0 items-center gap-1.5 text-[11px] text-ink-faint sm:inline-flex"><span className="size-1.5 rounded-full bg-lime/70" aria-hidden /> Room to think</span>
          </div>

          <div className={`chat-stage flex min-h-0 flex-1 flex-col${empty && !missing ? " chat-stage-empty" : ""}`}>
            <div ref={scroller} onScroll={onScroll} className="chat-scroller studio-scroll min-h-0 flex-1 overflow-y-auto" data-testid="kb-scroll">
              <div className="chat-content mx-auto flex min-h-full max-w-[860px] flex-col px-5 py-6 md:px-10">
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
                      className="mt-4 h-10 rounded-row bg-lime px-5 font-heading text-sm font-bold text-on-accent"
                    >
                      Start a new chat
                    </button>
                  </div>
                )}

                {empty && !missing && (
                  <ChatWelcome onPrompt={(text) => setDraft({ text, key: Date.now() })} />
                )}

                {messages.length > 0 && (
                  <div className="space-y-6" role="log" aria-live="polite" aria-label="Conversation" data-testid="kb-messages">
                    {messages.map((m) => (
                      <MessageBubble key={m.id} message={m} conversationId={id} voiceReplies={!!quota?.voice_replies} />
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

            {guestBlocked ? (
              <LoginWall />
            ) : planBlocked && quota ? (
              <PlanLimitWall quota={quota} />
            ) : (
              <>
                {quota && <GuestUsage quota={quota} />}
                {quota && <PlanUsage quota={quota} />}
                <Composer
                  streaming={streaming}
                  onSend={send}
                  onStop={stop}
                  focusKey={`${id ?? "new"}:${fresh ?? ""}`}
                  guestFilesLeft={guestFilesLeft}
                  draft={draft}
                  models={quota?.models ?? []}
                  model={activeModel}
                  onModelChange={setSelectedModel}
                />
              </>
            )}
          </div>
        </section>
      </div>
    </StudioShell>
  );
}
