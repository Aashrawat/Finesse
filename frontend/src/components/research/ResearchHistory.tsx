import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { FileSearch, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ResearchListItem } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ResearchHistory({ activeId, onOpen }: { activeId?: string; onOpen?: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, isPending, isError } = useQuery({ queryKey: ["research"], queryFn: () => api.listResearch() });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteResearch(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["research"] });
      const previous = queryClient.getQueryData<ResearchListItem[]>(["research"]);
      queryClient.setQueryData<ResearchListItem[]>(["research"], (old) => old?.filter((r) => r.id !== id));
      return { previous };
    },
    onError: (err, _id, ctx) => {
      queryClient.setQueryData(["research"], ctx?.previous);
      toast.error(err instanceof Error ? err.message : "Couldn't delete that report");
    },
    onSuccess: (_data, id) => {
      toast.success("Report deleted");
      queryClient.removeQueries({ queryKey: ["research", id] });
      if (id === activeId) navigate("/research");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["research"] }),
  });

  return (
    <ul className="studio-scroll -mr-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1" data-testid="research-history">
      {isPending &&
        [0, 1, 2].map((i) => (
          <li key={i} className="h-14 animate-pulse rounded-row border border-line bg-panel" aria-hidden />
        ))}

      {isError && (
        <li className="rounded-row border border-line bg-panel p-4 text-sm text-ink-muted">Past reports are offline right now.</li>
      )}

      {data && data.length === 0 && (
        <li className="rounded-row border border-dashed border-line p-4 text-sm text-ink-muted" data-testid="research-history-empty">
          No reports yet — ask a question.
        </li>
      )}

      {data?.map((item, i) => (
        <li key={item.id} style={{ animationDelay: `${i * 40}ms` }} className="group relative animate-rise">
          <Link
            to={`/research/${item.id}`}
            onClick={onOpen}
            data-testid={`research-item-${item.id}`}
            aria-current={item.id === activeId ? "page" : undefined}
            className={cn(
              "relative flex items-center gap-3 overflow-hidden rounded-row border p-3 pr-10 transition-colors duration-150",
              item.id === activeId ? "border-lime/50 bg-lime/[0.07]" : "border-line bg-panel hover:bg-panel-hover",
            )}
          >
            {item.id === activeId && <span className="absolute inset-y-0 left-0 w-0.5 bg-lime" aria-hidden />}
            <FileSearch className="size-5 shrink-0 text-ink-faint" aria-hidden />
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-semibold leading-snug text-ink">{item.topic}</p>
              <p className="mt-1 font-mono text-[10px] text-ink-faint">
                {formatDistanceToNowStrict(new Date(item.created_at), { addSuffix: true })}
              </p>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => remove.mutate(item.id)}
            aria-label={`Delete report: ${item.topic}`}
            data-testid={`research-delete-${item.id}`}
            className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-60 transition-colors duration-150 hover:bg-danger/10 hover:text-danger hover:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
