import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import AccountMenu from "@/components/auth/AccountMenu";
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

  const { data, isPending, isError } = useQuery({ queryKey: ["kb-conversations"], queryFn: kbApi.listConversations });

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
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <button
        type="button"
        onClick={() => { navigate("/chat", { state: { fresh: Date.now() } }); onNavigate?.(); }}
        data-testid="kb-new-chat-button"
        className="inline-flex h-10 items-center justify-center gap-2 rounded-row border border-line text-sm font-semibold text-ink transition-colors duration-150 hover:border-lime/60 hover:bg-lime/[0.06]"
      >
        <Plus className="size-4" aria-hidden /> New chat
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 studio-scroll">
        <p className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">Conversations</p>
        <ul className="space-y-1" data-testid="kb-conversation-list">
          {isPending &&
            [0, 1, 2].map((i) => <li key={i} className="h-10 animate-pulse rounded-row bg-panel" aria-hidden />)}
          {isError && <li className="px-1 text-xs text-ink-muted">Couldn't load your chats.</li>}
          {data && data.length === 0 && (
            <li className="rounded-row border border-dashed border-line p-3 text-xs text-ink-muted" data-testid="kb-no-conversations">
              No chats yet. Ask your first question.
            </li>
          )}
          {data?.map((c) => (
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

      <AccountMenu />
    </div>
  );
}
