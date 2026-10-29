import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  { code: "IN", title: "Uploading", detail: "Fetching stream / receiving file" },
  { code: "TX", title: "Transcribing", detail: "Speech → text, speaker labels, timestamps" },
  { code: "SM", title: "Summarising", detail: "TL;DR, key points, topic tags" },
  { code: "OK", title: "Ready", detail: "Indexed for chat & export" },
];

interface Props {
  label: string;
  progress: number;
  stage: string;
  /** Index of the step currently running (0-3). */
  activeStep: number;
  done: boolean;
}

export default function ProcessingQueue({ label, progress, stage, activeStep, done }: Props) {
  return (
    <section
      className="animate-rise overflow-hidden rounded-panel border border-line bg-panel"
      data-testid="processing-queue"
      aria-live="polite"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 animate-rec-blink rounded-full bg-ember" aria-hidden />
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Render queue · job 01</span>
        </div>
        <span className="font-mono text-sm font-semibold text-lime" data-testid="processing-percent">
          {Math.round(progress)}%
        </span>
      </div>

      <div className="space-y-5 p-5 md:p-6">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Now cutting</p>
          <h2 className="mt-1 break-words text-2xl leading-tight md:text-3xl" title={label}>
            {label.length > 90 ? `${label.slice(0, 90)}…` : label}
          </h2>
        </div>

        <div>
          <div className="sprockets" aria-hidden />
          <div
            className="h-3 overflow-hidden rounded-full bg-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            aria-label="Processing progress"
          >
            <div
              className="progress-fill h-full rounded-full transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max(3, progress)}%` }}
            />
          </div>
          <div className="sprockets" aria-hidden />
          <p className="mt-2 font-mono text-xs text-ink-muted">{stage}</p>
        </div>

        <ol className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => {
            const state = done || i < activeStep ? "done" : i === activeStep ? "active" : "todo";
            return (
              <li
                key={step.code}
                data-testid={`processing-step-${step.code.toLowerCase()}`}
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
                    {step.code}
                  </span>
                  {state === "active" && <Loader2 className="size-4 animate-spin text-cyan" aria-hidden />}
                  {state === "done" && <Check className="size-4 text-lime" aria-hidden />}
                </div>
                <p className="mt-2 font-heading text-base font-bold">{step.title}</p>
                <p className="mt-0.5 text-xs leading-snug text-ink-muted">{step.detail}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
