import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";

interface Props {
  onCapture: (file: File) => void;
  onClose: () => void;
}

function describe(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError") return "Camera permission was denied. Allow camera access in your browser settings, or choose Photos instead.";
  if (name === "NotFoundError") return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  return `Could not start the camera: ${err instanceof Error ? err.message : "unknown error"}`;
}

/** Live camera preview. Captures a JPEG from the video frame and hands it back as a File. */
export default function CameraDialog({ onCapture, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const shutter = useRef<HTMLButtonElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose; // parents pass inline callbacks; don't restart the camera when they change

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stop();
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        setReady(true);
      })
      .catch((err) => !cancelled && setError(describe(err)));
    return () => {
      cancelled = true;
    };
  }, [facing, stop]);

  // Release the camera when the dialog goes away; Escape closes it
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    shutter.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      stop();
      previous?.focus?.();
    };
  }, [stop]);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        onCapture(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92,
    );
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center p-4" data-testid="kb-camera">
      <button type="button" aria-label="Close camera" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/80" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Take a photo"
        className="relative w-full max-w-lg animate-rise overflow-hidden rounded-panel border border-line bg-page shadow-2xl"
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-4">
          <span className="font-heading text-sm font-semibold text-ink">Take a photo</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 place-items-center rounded-md text-ink-muted hover:bg-panel-hover hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="relative aspect-[4/3] bg-black">
          <video
            ref={video}
            autoPlay
            playsInline
            muted
            className={`size-full object-cover ${facing === "user" ? "-scale-x-100" : ""}`}
          />
          {error && (
            <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-body" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-4">
          <button
            type="button"
            onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
            className="inline-flex h-10 items-center gap-2 rounded-row border border-line px-3 text-sm text-ink hover:bg-panel-hover"
          >
            <RefreshCw className="size-4" aria-hidden /> Switch
          </button>
          <button
            ref={shutter}
            type="button"
            onClick={capture}
            disabled={!ready}
            aria-label="Capture photo"
            data-testid="kb-camera-shutter"
            className="grid size-16 place-items-center rounded-full border-4 border-ink/80 transition-transform duration-150 active:scale-95 disabled:opacity-40"
          >
            <span className="size-11 rounded-full bg-ink" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 items-center rounded-row border border-line px-3 text-sm text-ink hover:bg-panel-hover"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
