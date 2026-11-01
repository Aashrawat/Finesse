import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Loader2, Monitor, Moon, Sun } from "lucide-react";
import { toast } from "sonner";
import Modal from "@/components/auth/Modal";
import { authApi } from "@/lib/authApi";
import { ACCENTS, CUSTOM, setAccent, setCustomColor, setMode, useTheme, type Mode } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/lib/types";

interface Props {
  /** Null for a visitor who isn't logged in: they only get the appearance settings. */
  user: AuthUser | null;
  onClose: () => void;
  onSaved: (user: AuthUser) => void;
}

const MODES: { id: Mode; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Day", Icon: Sun },
  { id: "dark", label: "Night", Icon: Moon },
  { id: "system", label: "System", Icon: Monitor },
];

/** Day / night mode and the accent colour. Changes apply at once and are remembered in this browser. */
function Appearance() {
  const theme = useTheme();
  const day = theme.resolved === "light";

  return (
    <section aria-labelledby="appearance-heading" data-testid="settings-appearance">
      <h3 id="appearance-heading" className="font-heading text-sm font-semibold text-ink">Appearance</h3>

      <div role="radiogroup" aria-label="Day or night mode" className="mt-3 grid grid-cols-3 gap-1 rounded-row bg-track p-1">
        {MODES.map(({ id, label, Icon }) => {
          const active = theme.mode === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setMode(id)}
              data-testid={`theme-mode-${id}`}
              className={cn(
                "inline-flex h-9 items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors duration-150",
                active ? "bg-lime text-on-accent" : "text-ink-muted hover:bg-panel-hover hover:text-ink",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          );
        })}
      </div>

      <p className="mb-2 mt-4 text-xs font-semibold text-ink-body">Accent colour</p>
      <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2.5">
        {ACCENTS.map((a) => {
          const active = theme.accent === a.id;
          const colour = day ? a.light : a.dark;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={a.name}
              title={a.name}
              onClick={() => setAccent(a.id)}
              data-testid={`theme-accent-${a.id}`}
              style={{ backgroundColor: colour }}
              className={cn(
                "grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-page transition-shadow duration-150 hover:ring-2 hover:ring-ink-faint",
                active && "ring-2 ring-ink",
              )}
            >
              {active && <Check className="size-4" style={{ color: "var(--color-on-accent)" }} aria-hidden />}
            </button>
          );
        })}

        {/* any colour: the browser's own colour picker */}
        <label
          title="Pick your own colour"
          className={cn(
            "relative grid size-8 cursor-pointer place-items-center overflow-hidden rounded-full ring-offset-2 ring-offset-page transition-shadow duration-150 hover:ring-2 hover:ring-ink-faint focus-within:ring-2 focus-within:ring-ink",
            theme.accent === CUSTOM && "ring-2 ring-ink",
          )}
          style={{
            background:
              theme.accent === CUSTOM
                ? theme.accentColor
                : "conic-gradient(from 0deg, #ff5a5f, #ff9f1c, #ffd60a, #34d399, #4da3ff, #b197fc, #ff6fb5, #ff5a5f)",
          }}
        >
          <span className="sr-only">Custom colour</span>
          <input
            type="color"
            value={theme.custom}
            onChange={(e) => setCustomColor(e.target.value)}
            data-testid="theme-accent-custom"
            className="absolute inset-0 size-full cursor-pointer opacity-0"
          />
          {theme.accent === CUSTOM && <Check className="pointer-events-none size-4" style={{ color: "var(--color-on-accent)" }} aria-hidden />}
        </label>
      </div>
    </section>
  );
}

export default function SettingsDialog({ user, onClose, onSaved }: Props) {
  const [name, setName] = useState(user?.name ?? "");
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => authApi.updateName(name),
    onSuccess: ({ user: updated }) => {
      onSaved(updated);
      toast.success("Settings saved");
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Couldn't save your settings."),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user || save.isPending) return;
    if (!name.trim()) return setError("Enter your name.");
    if (name.trim() === user.name) return onClose();
    setError("");
    save.mutate();
  }

  return (
    <Modal title="Settings" onClose={onClose} testId="settings-dialog">
      <h2 className="pr-8 text-2xl">Settings</h2>
      <p className="mt-1 text-sm text-ink-muted">{user ? "Your Finesse account and how it looks." : "How Finesse looks."}</p>

      <div className="mt-5">
        <Appearance />
      </div>

      {user ? (
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-3.5 border-t border-line pt-5">
          <h3 className="font-heading text-sm font-semibold text-ink">Account</h3>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-ink-body">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              autoComplete="name"
              data-testid="settings-name"
              className="no-focus-ring h-11 w-full rounded-row border border-line bg-track px-3.5 text-[15px] text-ink transition-colors duration-150 focus:border-lime/60 focus:outline-none"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-xs font-semibold text-ink-body">Email</span>
            <p
              className="flex h-11 items-center truncate rounded-row border border-line bg-panel px-3.5 text-[15px] text-ink-muted"
              data-testid="settings-email"
            >
              {user.email}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-row border border-line bg-panel px-3.5 py-2.5 text-sm">
            <span className="text-ink-muted">Plan</span>
            <span className="font-semibold capitalize text-ink">{user.plan}</span>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="settings-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-row border border-line px-4 text-sm font-semibold text-ink-body transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={save.isPending}
              data-testid="settings-save"
              className="inline-flex h-10 items-center gap-2 rounded-row bg-lime px-5 text-sm font-bold text-on-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {save.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />} Save
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-6 flex justify-end border-t border-line pt-5">
          <button
            type="button"
            onClick={onClose}
            data-testid="settings-done"
            className="h-10 rounded-row bg-lime px-5 text-sm font-bold text-on-accent"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
