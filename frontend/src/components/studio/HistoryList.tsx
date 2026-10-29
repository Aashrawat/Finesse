import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Film, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatClock, relativeDate } from "@/lib/format";
import type { VideoListItem } from "@/lib/types";
import { cn } from "@/lib/utils";
import SourceBadge from "@/components/studio/SourceBadge";

interface Props {
  activeId?: string;
  /** Called after a row is opened (used to close the drawer). */
  onOpen?: () => void;
  autoFocusSearch?: boolean;
}

function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export default function HistoryList({ activeId, onOpen, autoFocusSearch }: Props) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim());
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isPending, isError } = useQuery({
    queryKey: ["videos", query],
    queryFn: () => api.listVideos(query),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteVideo(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ["videos"] });
      const previous = queryClient.getQueriesData<VideoListItem[]>({ queryKey: ["videos"] });
      queryClient.setQueriesData<VideoListItem[]>({ queryKey: ["videos"] }, (old) => old?.filter((v) => v.id !== id));
      return { previous };
    },
    onError: (err, _id, ctx) => {
      ctx?.previous.forEach(([key, value]) => queryClient.setQueryData(key, value));
      toast.error(err instanceof Error ? err.message : "Couldn't delete that reel");
    },
    onSuccess: (_data, id) => {
      toast.success("Reel deleted");
      queryClient.removeQueries({ queryKey: ["video", id] });
      if (id === activeId) navigate("/");
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <label className="relative block">
        <span className="sr-only">Search archive</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
        <input
          type="search"
          value={search}
          autoFocus={autoFocusSearch}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search reels"
          data-testid="history-search-input"
          className="h-10 w-full rounded-row border border-line bg-track pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-lime/60 focus:outline-none"
        />
      </label>

      <ul className="studio-scroll -mr-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1" data-testid="history-list">
        {isPending &&
          [0, 1, 2].map((i) => (
            <li key={i} className="flex h-[70px] animate-pulse gap-3 rounded-row border border-line bg-panel p-2" aria-hidden>
              <div className="h-[54px] w-[84px] rounded-md bg-track" />
              <div className="flex-1 space-y-2 py-1">
                <div className="h-3 w-3/4 rounded bg-track" />
                <div className="h-3 w-1/2 rounded bg-track" />
              </div>
            </li>
          ))}

        {isError && (
          <li className="rounded-row border border-line bg-panel p-4 text-sm text-ink-muted" data-testid="history-offline">
            Archive is offline right now.
          </li>
        )}

        {data && data.length === 0 && (
          <li className="rounded-row border border-dashed border-line p-4 text-sm text-ink-muted" data-testid="history-empty">
            {query ? "No reels match that search." : "No reels yet — drop one in."}
          </li>
        )}

        {data?.map((video, i) => (
          <li
            key={video.id}
            style={{ animationDelay: `${i * 40}ms` }}
            className="group relative animate-rise"
          >
            <Link
              to={`/v/${video.id}`}
              onClick={onOpen}
              data-testid={`history-item-${video.id}`}
              aria-current={video.id === activeId ? "page" : undefined}
              className={cn(
                "relative flex gap-3 overflow-hidden rounded-row border p-2 pr-10 transition-colors duration-150",
                video.id === activeId
                  ? "border-lime/50 bg-lime/[0.07]"
                  : "border-line bg-panel hover:bg-panel-hover",
              )}
            >
              {video.id === activeId && <span className="absolute inset-y-0 left-0 w-0.5 bg-lime" aria-hidden />}
              <div className="relative h-[54px] w-[84px] shrink-0 overflow-hidden rounded-md bg-track">
                {video.thumbnail ? (
                  <img src={video.thumbnail} alt="" className="size-full object-cover" loading="lazy" />
                ) : (
                  <div className="grid size-full place-items-center text-ink-faint">
                    <Film className="size-5" aria-hidden />
                  </div>
                )}
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/80 px-1 font-mono text-[10px] text-ink">
                  {formatClock(video.duration)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{video.title}</p>
                <div className="mt-1.5 flex items-center gap-2">
                  <SourceBadge type={video.source_type} />
                  <span className="truncate font-mono text-[10px] text-ink-faint">{relativeDate(video.created_at)}</span>
                </div>
              </div>
            </Link>
            <button
              type="button"
              onClick={() => remove.mutate(video.id)}
              aria-label={`Delete ${video.title}`}
              data-testid={`history-delete-${video.id}`}
              className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-ink-muted opacity-60 transition-colors duration-150 hover:bg-danger/10 hover:text-danger hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 className="size-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
