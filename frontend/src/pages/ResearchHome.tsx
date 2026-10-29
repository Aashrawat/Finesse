import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import { api } from "@/lib/api";

const EXAMPLES = [
  "How does retrieval-augmented generation work?",
  "State of solid-state batteries in 2026",
  "Pros and cons of a four-day work week",
];

export default function ResearchHome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [topic, setTopic] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: { preventDefault(): void }, value = topic) {
    e.preventDefault();
    if (submitting) return;
    const clean = value.trim();
    if (!clean) {
      setError("Type a topic to research first.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const job = await api.startResearch(clean);
      queryClient.setQueryData(["research", job.id], job);
      navigate(`/research/${job.id}`);
    } catch (err) {
      // e.g. a missing TAVILY_API_KEY comes back as a readable message
      setError(err instanceof Error ? err.message : "Couldn't start the research.");
      toast.error("Couldn't start the research");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <StudioShell>
      <main className="flex-1 px-4 py-8 md:px-8 lg:py-12">
        <div className="mx-auto min-w-0 max-w-4xl space-y-8">
          <section className="animate-rise">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Multi-agent research</p>
            <h1 className="mt-4 text-5xl leading-[0.95] md:text-7xl">
              <span className="text-lime">Research anything</span>
            </h1>
            <p className="mt-5 max-w-xl text-base text-ink-muted">
              Four agents work in turn: one searches the web, one reads the best page, one writes the report and one
              critiques it.
            </p>
          </section>

          <form
            onSubmit={submit}
            noValidate
            className="animate-rise space-y-4 rounded-panel border border-line bg-panel p-5"
            style={{ animationDelay: "80ms" }}
            data-testid="research-console"
          >
            <div className="flex flex-col gap-3 sm:flex-row">
              <label className="relative block flex-1">
                <span className="sr-only">Research topic</span>
                <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-faint" aria-hidden />
                <input
                  type="text"
                  value={topic}
                  maxLength={500}
                  onChange={(e) => { setTopic(e.target.value); setError(""); }}
                  placeholder="What do you want researched?"
                  aria-invalid={!!error}
                  data-testid="research-topic-input"
                  className="h-14 w-full rounded-row border border-line bg-track pl-12 pr-4 text-base text-ink placeholder:text-ink-faint focus:border-lime/60 focus:outline-none"
                />
              </label>
              <button
                type="submit"
                disabled={submitting}
                data-testid="research-submit-button"
                className="inline-flex h-14 items-center justify-center gap-2 rounded-row bg-lime px-8 font-heading text-base font-bold text-black transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_30px_rgba(204,255,0,0.35)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-5 animate-spin" aria-hidden /> Starting…
                  </>
                ) : (
                  "Research"
                )}
              </button>
            </div>

            {error && (
              <p role="alert" className="text-sm text-danger" data-testid="research-error">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Try</span>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={(e) => { setTopic(example); void submit(e, example); }}
                  className="max-w-[260px] truncate rounded-full border border-line px-3 py-1 text-xs text-ink-body transition-colors duration-150 hover:border-lime hover:text-lime"
                >
                  {example}
                </button>
              ))}
            </div>
          </form>
        </div>

      </main>
    </StudioShell>
  );
}
