import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import Modal from "@/components/auth/Modal";
import { authApi } from "@/lib/authApi";
import type { AuthUser } from "@/lib/types";

interface Props {
  user: AuthUser;
  onClose: () => void;
  onSaved: (user: AuthUser) => void;
}

export default function SettingsDialog({ user, onClose, onSaved }: Props) {
  const [name, setName] = useState(user.name);
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
    if (save.isPending) return;
    if (!name.trim()) return setError("Enter your name.");
    if (name.trim() === user.name) return onClose();
    setError("");
    save.mutate();
  }

  return (
    <Modal title="Settings" onClose={onClose} testId="settings-dialog">
      <h2 className="pr-8 text-2xl">Settings</h2>
      <p className="mt-1 text-sm text-ink-muted">Your Finesse account.</p>

      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-3.5">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-body">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoComplete="name"
            data-autofocus
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
            className="inline-flex h-10 items-center gap-2 rounded-row bg-lime px-5 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-60"
          >
            {save.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
