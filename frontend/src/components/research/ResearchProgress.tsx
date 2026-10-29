import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { code: "SR", title: "Search agent", detail: "Finds recent, reliable sources on the web" },
  { code: "RD", title: "Reader agent", detail: "Picks the best page and reads it in depth" },
  { code: "WR", title: "Writer", detail: "Drafts the structured report" },
  { code: "CR", title: "Critic", detail: "Reviews the report and scores it" },
];

interface Props {
  topic: string;
  /** Backend step: 0 = starting, 1-4 = running that step, 5 = finished. */
  step: number;
}

export default function ResearchProgress({ topic, step }: Props) {
  const percent = Math.min(100, Math.round((Math.max(step, 0) / 5) * 100));
  const active = step - 1; // index of the running step (-1 while starting)

  return (
    <section
      className="animate-rise overflow-hidden rounded-panel border border-line bg-panel"
      data-testid="research-progress"
      aria-live="polite"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 animate-rec-blink rounded-full bg-ember" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Research run · 4 agents</span>
        </div>
        <span className="font-mono text-sm font-semibold text-lime">{percent}%</span>
      </div>

      <div className="space-y-5 p-5 md:p-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Researching</p>
          <h2 className="mt-1 break-words text-2xl leading-tight md:text-3xl">{topic}</h2>
        </div>

        <div>
          <div className="sprockets" aria-hidden />
          <div
            className="h-3 overflow-hidden rounded-full bg-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Research progress"
          >
            <div
              className="progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(3, percent)}%` }}
            />
          </div>
          <div className="sprockets" aria-hidden />
          <p className="mt-2 font-mono text-xs text-ink-muted">
            {step <= 0 ? "Starting…" : step >= 5 ? "Done" : `${STEPS[active].title} is working…`}
          </p>
        </div>

        <ol className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => {
            const state = step >= 5 || i < active ? "done" : i === active ? "active" : "todo";
            return (
              <li
                key={s.code}
                data-testid={`research-step-${s.code.toLowerCase()}`}
                data-state={state}
                className={cn(
                  "rounded-row border p-3 transition-colors duration-150",
                  state === "todo" && "border-line bg-track text-ink-faint",
                  state === "active" && "border-cyan/70 bg-cyan/[0.07] text-ink",
                  state === "done" && "border-lime/60 bg-lime/[0.07] text-ink",
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      "font-mono text-[11px] font-bold",
                      state === "done" && "text-lime",
                      state === "active" && "text-cyan",
                    )}
                  >
                    {s.code}
                  </span>
                  {state === "active" && <Loader2 className="size-4 animate-spin text-cyan" aria-hidden />}
                  {state === "done" && <Check className="size-4 text-lime" aria-hidden />}
                </div>
                <p className="mt-2 font-heading text-base font-bold">{s.title}</p>
                <p className="mt-0.5 text-xs leading-snug text-ink-muted">{s.detail}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
