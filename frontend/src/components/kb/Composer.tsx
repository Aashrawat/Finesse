import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ArrowUp, Camera, FileText, Images, Paperclip, Plus, Square, X } from "lucide-react";
import { toast } from "sonner";
import CameraDialog from "@/components/kb/CameraDialog";
import { fileLabel, formatSize } from "@/components/kb/MessageAttachments";
import { cn } from "@/lib/utils";

const MAX_CHARS = 4000;
const ACCEPT_PHOTOS = "image/*";
const ACCEPT_FILES = ".pdf,.txt,.md,.docx,application/pdf";
const DOC_EXT = /\.(pdf|txt|md|docx)$/i;
// keep these in step with KB_MAX_ATTACH_MB / KB_MAX_ATTACH_FILES / KB_MAX_ATTACH_IMAGES on the server
const MAX_FILE_MB = 25;
const MAX_FILES = 6;
const MAX_IMAGES = 4;

interface Pending {
  key: string;
  file: File;
  isImage: boolean;
  url?: string; // local preview for images
}

interface Props {
  streaming: boolean;
  /** Called on send. The files are attached to this message and read by the server when it arrives. */
  onSend: (text: string, files: File[]) => void;
  onStop: () => void;
  /** Focus the box whenever this changes (e.g. a new chat was opened). */
  focusKey?: string;
}

const isImageFile = (f: File) => f.type.startsWith("image/");

export default function Composer({ streaming, onSend, onStop, focusKey }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const captureInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Grow with the content, up to ~8 lines
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // A different chat was opened: focus the box and drop files that were never sent
  useEffect(() => {
    ref.current?.focus();
    return () => {
      pendingRef.current.forEach((p) => p.url && URL.revokeObjectURL(p.url));
      setPending([]);
    };
  }, [focusKey]);

  // Close the + menu on outside click or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRoot.current && !menuRoot.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const trimmed = text.trim();
  const canSend = (trimmed.length > 0 || pending.length > 0) && !streaming && text.length <= MAX_CHARS;

  function submit() {
    if (!canSend) return;
    const files = pending.map((p) => p.file);
    pending.forEach((p) => p.url && URL.revokeObjectURL(p.url)); // the sent message makes its own previews
    setPending([]);
    setText("");
    onSend(trimmed, files);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // ---- staging files (nothing is uploaded until Send) -----------------------------------------
  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    if (incoming.length === 0) return;

    const next = [...pendingRef.current];
    const rejected: string[] = [];
    for (const file of incoming) {
      const image = isImageFile(file);
      if (!image && !DOC_EXT.test(file.name)) {
        rejected.push(`${file.name}: attach a PDF, image, TXT, MD or DOCX file`);
      } else if (file.size > MAX_FILE_MB * 1024 * 1024) {
        rejected.push(`${file.name}: larger than ${MAX_FILE_MB} MB`);
      } else if (next.length >= MAX_FILES) {
        rejected.push(`You can attach up to ${MAX_FILES} files per message`);
        break;
      } else if (image && next.filter((p) => p.isImage).length >= MAX_IMAGES) {
        rejected.push(`You can attach up to ${MAX_IMAGES} photos per message`);
      } else {
        next.push({ key: crypto.randomUUID(), file, isImage: image, url: image ? URL.createObjectURL(file) : undefined });
      }
    }
    setPending(next);
    if (rejected.length) toast.error([...new Set(rejected)].join("\n"));
    ref.current?.focus();
  }

  function removePending(key: string) {
    setPending((all) => {
      const gone = all.find((p) => p.key === key);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return all.filter((p) => p.key !== key);
    });
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    if (input.files) addFiles(Array.from(input.files));
    input.value = ""; // allow picking the same file again
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  function onPaste(e: ClipboardEvent) {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      addFiles(e.clipboardData.files);
    }
  }

  const closeCamera = useCallback(() => setCameraOpen(false), []);

  function openCamera() {
    setMenuOpen(false);
    // Without getUserMedia (e.g. plain http on a phone) fall back to the device's own camera app
    if (!navigator.mediaDevices?.getUserMedia) captureInput.current?.click();
    else setCameraOpen(true);
  }

  return (
    <div className="px-4 pb-4 pt-2 md:px-6">
      <div className="mx-auto max-w-3xl">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-2xl border bg-panel p-2 transition-colors duration-150 focus-within:border-lime/50",
            dragging ? "border-lime bg-lime/[0.06]" : "border-line",
          )}
        >
          {/* hidden pickers: gallery (images), native camera fallback, and files (PDF and documents) */}
          <input ref={photoInput} type="file" multiple accept={ACCEPT_PHOTOS} onChange={onPick} className="hidden" tabIndex={-1} data-testid="kb-photo-input" />
          <input ref={captureInput} type="file" accept={ACCEPT_PHOTOS} capture="environment" onChange={onPick} className="hidden" tabIndex={-1} data-testid="kb-capture-input" />
          <input ref={fileInput} type="file" multiple accept={ACCEPT_FILES} onChange={onPick} className="hidden" tabIndex={-1} data-testid="kb-file-input" />

          {pending.length > 0 && (
            <ul className="flex flex-wrap gap-2 px-1 pb-2 pt-1" data-testid="kb-attachments" aria-label="Files to send">
              {pending.map((p) => (
                <li key={p.key} className="group relative">
                  {p.isImage && p.url ? (
                    <img src={p.url} alt={p.file.name} className="size-16 rounded-xl border border-line object-cover" />
                  ) : (
                    <div className="flex h-16 max-w-[220px] items-center gap-2.5 rounded-xl border border-line bg-page py-2 pl-2.5 pr-4">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-lime/10 text-lime">
                        <FileText className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-ink" title={p.file.name}>{p.file.name}</span>
                        <span className="block text-[11px] text-ink-muted">{fileLabel({ name: p.file.name, mime: p.file.type })} · {formatSize(p.file.size)}</span>
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => removePending(p.key)}
                    aria-label={`Remove ${p.file.name}`}
                    data-testid="kb-attachment-remove"
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line bg-panel text-ink-muted shadow transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-2">
            <div ref={menuRoot} className="relative shrink-0">
              {menuOpen && (
                <div
                  role="menu"
                  aria-label="Add files"
                  data-testid="kb-upload-menu"
                  className="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-44 animate-rise rounded-panel border border-line bg-panel p-1.5 shadow-2xl"
                >
                  {[
                    { id: "camera", label: "Camera", icon: Camera, run: openCamera },
                    { id: "photos", label: "Photos", icon: Images, run: () => { setMenuOpen(false); photoInput.current?.click(); } },
                    { id: "files", label: "Files", icon: Paperclip, run: () => { setMenuOpen(false); fileInput.current?.click(); } },
                  ].map(({ id, label, icon: Icon, run }) => (
                    <button
                      key={id}
                      type="button"
                      role="menuitem"
                      onClick={run}
                      data-testid={`kb-menu-${id}`}
                      className="flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-left text-sm text-ink-body transition-colors duration-150 hover:bg-panel-hover hover:text-ink focus-visible:bg-panel-hover focus-visible:text-ink"
                    >
                      <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="Add camera photo, photos or files"
                title="Add camera photo, photos or files"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid="kb-upload-button"
                className="grid size-10 place-items-center rounded-full text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
              >
                <Plus className={cn("size-5 transition-transform duration-150", menuOpen && "rotate-45")} aria-hidden />
              </button>
            </div>

            <label className="min-w-0 flex-1">
              <span className="sr-only">Message</span>
              <textarea
                ref={ref}
                value={text}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={dragging ? "Drop files to attach them" : pending.length ? "Add a message, or just send" : "Ask Finesse"}
                data-testid="kb-input"
                className="no-focus-ring block max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </label>

            {streaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                data-testid="kb-stop-button"
                className="grid size-10 shrink-0 place-items-center rounded-xl bg-ink text-black transition-transform duration-150 active:scale-95"
              >
                <Square className="size-4 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                data-testid="kb-send-button"
                className={cn(
                  "grid size-10 shrink-0 place-items-center rounded-xl transition-[transform,opacity,background-color] duration-150 active:scale-95",
                  canSend ? "bg-lime text-black hover:shadow-[0_0_20px_rgba(204,255,0,0.3)]" : "bg-panel-hover text-ink-faint",
                )}
              >
                <ArrowUp className="size-5" aria-hidden />
              </button>
            )}
          </div>
        </div>

        {text.length > MAX_CHARS * 0.9 && (
          <p className="mt-2 text-center text-[11px]">
            <span className={text.length > MAX_CHARS ? "text-danger" : "text-amber"}>
              {text.length}/{MAX_CHARS} characters
            </span>
          </p>
        )}
      </div>

      {cameraOpen && (
        <CameraDialog
          onClose={closeCamera}
          onCapture={(file) => {
            closeCamera();
            addFiles([file]);
          }}
        />
      )}
    </div>
  );
}
