import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import AccountMenu from "@/components/auth/AccountMenu";
import FinesseMark from "@/components/FinesseMark";
import { useAuth } from "@/components/auth/AuthProvider";
import { kbApi } from "@/lib/kbApi";
import type { KbConversationItem } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  activeId?: string;
  /** Called after navigating (closes the mobile drawer). */
  onNavigate?: () => void;
}

export default function ConversationSidebar({ activeId, onNavigate }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [search, setSearch] = useState("");

  const { data, isPending, isError, refetch } = useQuery({ queryKey: ["kb-conversations"], queryFn: kbApi.listConversations });
  const conversations = data?.filter((conversation) => conversation.title.toLowerCase().includes(search.toLowerCase().trim()));

  const remove = useMutation({
    mutationFn: (id: string) => kbApi.deleteConversation(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["kb-conversations"] });
      const previous = queryClient.getQueryData<KbConversationItem[]>(["kb-conversations"]);
      queryClient.setQueryData<KbConversationItem[]>(["kb-conversations"], (old) => old?.filter((c) => c.id !== id));
      return { previous };
    },
    onError: (err, _id, ctx) => {
      queryClient.setQueryData(["kb-conversations"], ctx?.previous);
      toast.error(err instanceof Error ? err.message : "Couldn't delete that chat");
    },
    onSuccess: (_data, id) => {
      if (id === activeId) navigate("/chat");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["kb-conversations"] }),
  });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="px-1 pb-1 pt-3">
        <p className="font-heading text-sm font-medium text-ink">Your space</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">Good things start with a conversation.</p>
      </div>
      <button
        type="button"
        onClick={() => { navigate("/chat", { state: { fresh: Date.now() } }); onNavigate?.(); }}
        data-testid="kb-new-chat-button"
        className="inline-flex h-11 shrink-0 items-center justify-between rounded-xl bg-lime px-3.5 text-[13px] font-semibold text-on-accent transition-opacity duration-150 hover:opacity-90"
      >
        New conversation <Plus className="size-4" aria-hidden />
      </button>

      <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line/70 bg-page/40 px-3 focus-within:border-lime/60">
        <Search className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span className="sr-only">Search conversations</span>
        <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a conversation" className="no-focus-ring min-w-0 flex-1 bg-transparent text-xs text-ink placeholder:text-ink-faint focus:outline-none" data-testid="kb-search" />
      </label>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 studio-scroll">
        <div className="mb-3 mt-2 flex items-center justify-between px-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-ink-faint">Recent conversations</p>
          {data && <span className="text-[10px] text-ink-faint">{data.length.toString().padStart(2, "0")}</span>}
        </div>
        <ul className="space-y-1" data-testid="kb-conversation-list">
          {isPending &&
            [0, 1, 2].map((i) => <li key={i} className="h-10 animate-pulse rounded-row bg-panel" aria-hidden />)}
          {isError && <li className="rounded-xl border border-line p-3 text-xs text-ink-muted">Couldn't load your chats. <button type="button" onClick={() => void refetch()} className="mt-2 block text-lime hover:underline">Try again</button></li>}
          {data && data.length === 0 && (
            <li className="sidebar-empty" data-testid="kb-no-conversations">
              <MessageSquare className="mb-3 size-5 text-ink-faint" aria-hidden />
              <p className="text-xs text-ink-muted">A fresh page. All yours.</p>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">Your conversations will find<br />a home here.</p>
            </li>
          )}
          {data && data.length > 0 && conversations?.length === 0 && <li className="px-1 py-3 text-xs text-ink-muted">No conversations match “{search}”.</li>}
          {conversations?.map((c) => (
            <li key={c.id} className="group relative">
              <Link
                to={`/chat/${c.id}`}
                onClick={onNavigate}
                aria-current={c.id === activeId ? "page" : undefined}
                data-testid={`kb-conversation-${c.id}`}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-row pl-2.5 pr-9 text-sm transition-colors duration-150",
                  c.id === activeId ? "bg-lime/[0.09] text-ink" : "text-ink-body hover:bg-panel-hover",
                )}
              >
                <MessageSquare className={cn("size-4 shrink-0", c.id === activeId ? "text-lime" : "text-ink-faint")} aria-hidden />
                <span className="truncate">{c.title}</span>
              </Link>
              <button
                type="button"
                onClick={() => remove.mutate(c.id)}
                aria-label={`Delete chat: ${c.title}`}
                data-testid={`kb-delete-${c.id}`}
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 max-lg:opacity-60"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {user?.plan !== "pro" && (
        <Link to="/pricing" onClick={onNavigate} className="possibility-card group" data-testid="sidebar-plans">
          <span className="flex items-center justify-between"><FinesseMark className="size-5" /><ArrowUpRight className="size-3.5 text-ink-faint transition-colors group-hover:text-lime" aria-hidden /></span>
          <span className="mt-3 block text-xs font-medium text-ink">A little more possibility.</span>
          <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">More room for your ideas.<br />Explore Finesse plans.</span>
        </Link>
      )}
      <AccountMenu />
    </div>
  );
}
