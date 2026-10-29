import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileAudio, Loader2, SquarePlay, Upload, X } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import ProcessingQueue from "@/components/studio/ProcessingQueue";
import { api } from "@/lib/api";
import { formatBytes, isYouTubeUrl } from "@/lib/format";
import type { JobStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type Mode = "youtube" | "file";
const SUPPORTED = ["mp3", "mp4", "m4a"];
const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** Map the backend's progress to the four queue steps: IN, TX, SM, OK. */
function stepFor(job: JobStatus): number {
  if (job.progress < 12) return 0;
  if (job.progress < 72) return 1;
  return 2;
}

export default function Intake() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>("youtube");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<JobStatus | null>(null);

  const label = job ? (mode === "youtube" ? url.trim() : (file?.name ?? "")) : "";

  // Quick-load pills come from the archive
  const { data: recent } = useQuery({ queryKey: ["videos", ""], queryFn: () => api.listVideos() });

  // Poll the running job
  const jobId = job?.id;
  const finished = job?.status === "done" || job?.status === "error";
  useEffect(() => {
    if (!jobId || finished) return;
    const timer = setInterval(async () => {
      try {
        setJob(await api.getJob(jobId));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Lost connection to the server");
        setJob(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [jobId, finished]);

  // Job finished: go to the workspace after a beat, or return to the console on failure
  useEffect(() => {
    if (!job) return;
    if (job.status === "done") {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      const timer = setTimeout(() => navigate(`/v/${job.id}`), 650);
      return () => clearTimeout(timer);
    }
    if (job.status === "error") {
      toast.error(job.error ?? "Processing failed");
      setJob(null);
    }
  }, [job, navigate, queryClient]);

  function pickFile(next: File | null) {
    if (!next) return;
    if (!SUPPORTED.includes(extensionOf(next.name))) {
      setFile(null);
      setError("Only MP3, MP4 or M4A files are supported.");
      return;
    }
    setError("");
    setFile(next);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files[0] ?? null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;

    if (mode === "youtube") {
      if (!isYouTubeUrl(url)) {
        setError("That doesn't look like a valid YouTube link.");
        return;
      }
    } else if (!file) {
      setError("Choose an MP3, MP4 or M4A file first.");
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      setJob(await api.startJob(mode === "youtube" ? { url: url.trim() } : { file: file! }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start processing");
    } finally {
      setSubmitting(false);
    }
  }

  const segmentClass = (active: boolean) =>
    cn(
      "h-10 flex-1 rounded-md px-4 text-sm font-semibold transition-colors duration-150",
      active ? "bg-lime text-black" : "text-ink-muted hover:bg-panel-hover hover:text-ink",
    );

  return (
    <StudioShell>
      <main className="flex-1 px-4 py-8 md:px-8 lg:py-12">
        <div className="mx-auto min-w-0 max-w-4xl space-y-8">
          <section className="animate-rise">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">AI video assistant · v2</p>
            <h1 className="mt-4 text-5xl leading-[0.95] md:text-7xl">
              <span className="text-lime">I can help with video and audio files</span>
            </h1>
            <p className="mt-5 max-w-xl text-base text-ink-muted">
              Drop in a YouTube link or a recording. Get a summary, a timestamped transcript, and a chat that
              answers from the footage.
            </p>
          </section>

          {job ? (
            <ProcessingQueue
              label={label}
              progress={job.progress}
              stage={job.stage}
              activeStep={stepFor(job)}
              done={job.status === "done"}
            />
          ) : (
            <form
              onSubmit={submit}
              className="animate-rise space-y-4 rounded-panel border border-line bg-panel p-5"
              style={{ animationDelay: "80ms" }}
              data-testid="intake-console"
              noValidate
            >
              <div className="flex gap-1 rounded-row bg-track p-1" role="tablist" aria-label="Source type">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "youtube"}
                  onClick={() => { setMode("youtube"); setError(""); }}
                  data-testid="intake-mode-youtube"
                  className={segmentClass(mode === "youtube")}
                >
                  YouTube link
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === "file"}
                  onClick={() => { setMode("file"); setError(""); }}
                  data-testid="intake-mode-file"
                  className={segmentClass(mode === "file")}
                >
                  Upload file
                </button>
              </div>

              {mode === "youtube" ? (
                <div className="flex flex-col gap-3 sm:flex-row">
                  <label className="relative block flex-1">
                    <span className="sr-only">YouTube URL</span>
                    <SquarePlay className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-faint" aria-hidden />
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => { setUrl(e.target.value); setError(""); }}
                      placeholder="https://www.youtube.com/watch?v=…"
                      aria-invalid={!!error}
                      data-testid="intake-youtube-input"
                      className="h-14 w-full rounded-row border border-line bg-track pl-12 pr-4 text-base text-ink placeholder:text-ink-faint focus:border-lime/60 focus:outline-none"
                    />
                  </label>
                  <SubmitButton submitting={submitting} />
                </div>
              ) : (
                <div className="space-y-3">
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                    data-testid="intake-file-dropzone"
                    className={cn(
                      "flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-row border-2 border-dashed p-6 text-center transition-colors duration-150",
                      dragging ? "border-lime bg-lime/[0.06]" : "border-line bg-track",
                    )}
                  >
                    <Upload
                      className={cn(
                        "size-10 text-ink-faint transition-transform duration-150",
                        dragging && "scale-125 text-lime",
                      )}
                      aria-hidden
                    />
                    <p className="font-heading text-xl font-bold text-ink">Drop your reel here</p>
                    <p className="text-sm text-ink-muted">
                      or{" "}
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        data-testid="intake-file-browse"
                        className="font-semibold text-lime underline underline-offset-4"
                      >
                        browse
                      </button>{" "}
                      your files
                    </p>
                    <div className="flex gap-1.5">
                      {["MP3", "MP4", "M4A"].map((t) => (
                        <span key={t} className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] text-ink-muted">
                          {t}
                        </span>
                      ))}
                    </div>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".mp3,.mp4,.m4a,audio/*,video/*"
                      className="hidden"
                      onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                      data-testid="intake-file-input"
                    />
                  </div>

                  {file && (
                    <div className="flex items-center gap-3 rounded-row border border-line bg-track p-3" data-testid="intake-file-row">
                      <FileAudio className="size-5 shrink-0 text-lime" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-ink">{file.name}</p>
                        <p className="font-mono text-[11px] text-ink-faint">{formatBytes(file.size)}</p>
                      </div>
                      <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase text-ink-muted">
                        {extensionOf(file.name)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}
                        aria-label="Remove file"
                        data-testid="intake-file-remove"
                        className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </div>
                  )}

                  <SubmitButton submitting={submitting} full />
                </div>
              )}

              {error && (
                <p role="alert" className="text-sm text-danger" data-testid="intake-error">
                  {error}
                </p>
              )}

              {recent && recent.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">Try a sample</span>
                  {recent.slice(0, 3).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => navigate(`/v/${v.id}`)}
                      data-testid={`intake-sample-${v.id}`}
                      className="max-w-[220px] truncate rounded-full border border-line px-3 py-1 text-xs text-ink-body transition-colors duration-150 hover:border-lime hover:text-lime"
                    >
                      {v.title}
                    </button>
                  ))}
                </div>
              )}
            </form>
          )}
        </div>

      </main>
    </StudioShell>
  );
}

function SubmitButton({ submitting, full }: { submitting: boolean; full?: boolean }) {
  return (
    <button
      type="submit"
      disabled={submitting}
      data-testid="intake-submit-button"
      className={cn(
        "inline-flex h-14 items-center justify-center gap-2 rounded-row bg-lime px-8 font-heading text-base font-bold text-black transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_30px_rgba(204,255,0,0.35)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60",
        full && "w-full",
      )}
    >
      {submitting ? (
        <>
          <Loader2 className="size-5 animate-spin" aria-hidden /> Starting…
        </>
      ) : (
        "Process"
      )}
    </button>
  );
}
