import { Link } from "react-router-dom";
import { Lock, Sparkles } from "lucide-react";
import { useAuth } from "@/components/auth/AuthProvider";
import type { ChatQuota } from "@/lib/types";

/** Replaces the message box when a guest has used their free allowance. */
export function LoginWall() {
  const { openAuth } = useAuth();
  return (
    <div className="px-4 pb-4 pt-2 md:px-6" data-testid="kb-login-wall">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-2xl border border-line bg-panel px-5 py-5 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lime/10 text-lime">
            <Lock className="size-4" aria-hidden />
          </span>
          <div>
            <p className="font-heading text-sm font-semibold text-ink">Log in to explore more</p>
            <p className="text-sm text-ink-muted">You've reached the free limit for guests, so you can't send more messages yet.</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => openAuth("login")}
            data-testid="kb-wall-login"
            className="h-10 rounded-row bg-lime px-5 font-heading text-sm font-bold text-on-accent"
          >
            Log in
          </button>
        </div>
      </div>
    </div>
  );
}

/** Replaces the message box when a logged-in user has used all of today's messages on their plan. */
export function PlanLimitWall({ quota }: { quota: ChatQuota }) {
  const top = quota.plan === "pro";
  return (
    <div className="px-4 pb-4 pt-2 md:px-6" data-testid="kb-plan-wall">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-2xl border border-line bg-panel px-5 py-5 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lime/10 text-lime">
            <Sparkles className="size-4" aria-hidden />
          </span>
          <div>
            <p className="font-heading text-sm font-semibold text-ink">
              You've used all {quota.messages_limit} messages for today
            </p>
            <p className="text-sm text-ink-muted">
              {top ? "Your allowance resets tomorrow." : "Upgrade for a higher limit and a more powerful model, or come back tomorrow."}
            </p>
          </div>
        </div>
        {!top && (
          <Link
            to="/pricing"
            data-testid="kb-wall-upgrade"
            className="inline-flex h-10 shrink-0 items-center rounded-row bg-lime px-5 font-heading text-sm font-bold text-on-accent"
          >
            See plans
          </Link>
        )}
      </div>
    </div>
  );
}

/** A quiet line above the message box once a logged-in user is close to today's limit. */
export function PlanUsage({ quota }: { quota: ChatQuota }) {
  if (quota.guest || quota.blocked || quota.messages_limit == null) return null;
  const left = quota.messages_limit - (quota.messages_used ?? 0);
  if (left > 5) return null;
  return (
    <p className="px-4 pt-1 text-center font-mono text-[11px] text-ink-faint md:px-6" data-testid="kb-plan-usage">
      {quota.plan_name} plan: {left} message{left === 1 ? "" : "s"} left today.{" "}
      {quota.plan !== "pro" && (
        <Link to="/pricing" className="text-lime hover:underline">Upgrade</Link>
      )}
    </p>
  );
}

/** A quiet line above the message box telling a guest how much of the free allowance is left. */
export function GuestUsage({ quota }: { quota: ChatQuota }) {
  if (!quota.guest || quota.blocked) return null;
  const files = `${quota.files_used ?? 0}/${quota.files_limit ?? 0} files`;
  const tokens = `${quota.tokens_used ?? 0}/${quota.tokens_limit ?? 0} tokens`;
  return (
    <p className="px-4 pt-1 text-center font-mono text-[11px] text-ink-faint md:px-6" data-testid="kb-guest-usage">
      Guest preview: {files} · {tokens}. Log in to explore more.
    </p>
  );
}
