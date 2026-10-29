import { useEffect, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import Markdown from "@/components/research/Markdown";
import ResearchProgress from "@/components/research/ResearchProgress";
import { api } from "@/lib/api";
import { downloadText, parseCritique, researchToMarkdown, slugify } from "@/lib/research";
import type { Critique, ResearchJob } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function ResearchReport() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: job, isPending, error } = useQuery({
    queryKey: ["research", id],
    queryFn: () => api.getResearch(id),
    retry: false,
    // Keep polling while the agents are still working
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
  });

  useEffect(() => {
    if (job?.status === "done") queryClient.invalidateQueries({ queryKey: ["research"], exact: true });
    if (job?.status === "error") toast.error(job.error ?? "The research failed");
  }, [job?.status, job?.error, queryClient]);

  return (
    <StudioShell>
      <main className="flex-1 px-4 py-6 md:px-8">
        <div className="mx-auto min-w-0 max-w-4xl space-y-6">
          <Link
            to="/research"
            data-testid="research-back-link"
            className="inline-flex items-center gap-1.5 text-sm text-ink-muted transition-colors duration-150 hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden /> New research
          </Link>

          {isPending && <div className="h-64 animate-pulse rounded-panel border border-line bg-panel" aria-label="Loading" />}

          {error && (
            <div className="rounded-panel border border-line bg-panel p-8 text-center" data-testid="research-missing">
              <h1 className="text-3xl">We couldn't find that report</h1>
              <p className="mt-2 text-ink-muted">It may have been deleted, or the server restarted mid-run.</p>
              <button
                type="button"
                onClick={() => navigate("/research")}
                className="mt-5 h-11 rounded-row bg-lime px-6 font-heading font-bold text-black"
              >
                Start a new one
              </button>
            </div>
          )}

          {job?.status === "running" && <ResearchProgress topic={job.topic} step={job.step} />}

          {job?.status === "error" && (
            <div className="rounded-panel border border-danger/40 bg-danger/[0.06] p-6" role="alert" data-testid="research-failed">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-danger">Research failed</p>
              <h1 className="mt-2 text-2xl">{job.topic}</h1>
              <p className="mt-3 break-words text-sm text-ink-body">{job.error}</p>
              <Link to="/research" className="mt-5 inline-flex h-11 items-center rounded-row bg-lime px-6 font-heading font-bold text-black">
                Try again
              </Link>
            </div>
          )}

          {job?.status === "done" && job.result && <Report job={job} />}
        </div>

      </main>
    </StudioShell>
  );
}

function Report({ job }: { job: ResearchJob }) {
  const result = job.result!;
  const critique = parseCritique(result.feedback);
  const markdown = researchToMarkdown(job);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("Report copied");
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  }

  return (
    <div className="animate-rise space-y-6" data-testid="research-report">
      <header className="space-y-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Research report</p>
        <h1 className="break-words text-4xl leading-tight md:text-5xl" data-testid="research-title">
          {job.topic}
        </h1>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={copy}
            data-testid="research-copy-button"
            className="inline-flex h-10 items-center gap-2 rounded-row border border-line px-4 text-sm font-semibold text-ink-body transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
          >
            <Copy className="size-4" aria-hidden /> Copy
          </button>
          <button
            type="button"
            onClick={() => downloadText(`${slugify(job.topic)}.md`, markdown)}
            data-testid="research-download-button"
            className="inline-flex h-10 items-center gap-2 rounded-row bg-lime px-4 text-sm font-bold text-black transition-shadow duration-150 hover:shadow-[0_0_24px_rgba(204,255,0,0.3)]"
          >
            <Download className="size-4" aria-hidden /> Download .md
          </button>
        </div>
      </header>

      <article className="rounded-panel border border-line bg-panel p-5 md:p-7">
        <Markdown text={result.report} skipTitle />
      </article>

      <section className="rounded-panel border border-line bg-panel p-5 md:p-7" data-testid="research-critic">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Critic review</p>
        {critique ? <CritiqueView critique={critique} /> : <p className="mt-3 whitespace-pre-wrap text-sm text-ink-body">{result.feedback}</p>}
      </section>

      <section className="space-y-3" aria-label="Raw research">
        <Details title="What the search agent found" testId="research-raw-search">
          <Markdown text={result.search_results} />
        </Details>
        <Details title="What the reader agent scraped" testId="research-raw-scrape">
          <p className="whitespace-pre-wrap break-words text-sm text-ink-body">{result.scraped_content}</p>
        </Details>
      </section>
    </div>
  );
}

function CritiqueView({ critique }: { critique: Critique }) {
  const score = critique.score;
  const tone = score === null ? "text-ink" : score >= 8 ? "text-lime" : score >= 6 ? "text-amber" : "text-danger";
  return (
    <div className="mt-4 space-y-5">
      <div className="flex items-end gap-4">
        {score !== null && (
          <p className={cn("font-heading text-6xl font-bold leading-none", tone)} data-testid="research-score">
            {score}
            <span className="text-2xl text-ink-muted">/10</span>
          </p>
        )}
        {critique.verdict && <p className="pb-1 text-base text-ink">{critique.verdict}</p>}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {critique.strengths.length > 0 && (
          <div>
            <h3 className="mb-2 font-heading text-lg text-lime">Strengths</h3>
            <ul className="space-y-2 text-sm text-ink-body">
              {critique.strengths.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-lime" aria-hidden /> {s}
                </li>
              ))}
            </ul>
          </div>
        )}
        {critique.improvements.length > 0 && (
          <div>
            <h3 className="mb-2 font-heading text-lg text-amber">Areas to improve</h3>
            <ul className="space-y-2 text-sm text-ink-body">
              {critique.improvements.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-amber" aria-hidden /> {s}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Details({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <details className="group rounded-panel border border-line bg-panel" data-testid={testId}>
      <summary className="cursor-pointer select-none list-none px-5 py-3 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted transition-colors duration-150 hover:text-ink">
        {title}
      </summary>
      <div className="border-t border-line p-5">{children}</div>
    </details>
  );
}
