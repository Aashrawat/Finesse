import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, Loader2 } from "lucide-react";
import { toast } from "sonner";
import StudioShell from "@/components/studio/StudioShell";
import { useAuth } from "@/components/auth/AuthProvider";
import { authApi } from "@/lib/authApi";
import type { AuthUser, PlanInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const POPULAR = "pro";
const RANK = ["free", "pro", "premium"];

const priceLabel = (p: PlanInfo) => (p.price === 0 ? "$0" : `$${p.price.toFixed(2)}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const longDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "";

interface Action {
  label: string;
  disabled: boolean;
  hint?: string;
}

function PlanCard({
  plan,
  current,
  billing,
  canSwitch,
  busy,
  onChoose,
}: {
  plan: PlanInfo;
  current: string | null;
  billing: boolean;
  canSwitch: boolean;
  busy: boolean;
  onChoose: (plan: PlanInfo) => void;
}) {
  const isCurrent = current === plan.id;
  const popular = plan.id === POPULAR;
  const paid = plan.price > 0;

  let action: Action;
  if (isCurrent) action = { label: "Your current plan", disabled: true };
  else if (current === null) action = { label: paid ? `Get ${plan.name}` : "Get started free", disabled: false };
  else if (billing) {
    action = paid
      ? { label: current === "free" ? `Subscribe to ${plan.name}` : `Switch to ${plan.name}`, disabled: false }
      : { label: "Cancel in billing", disabled: false };
  } else if (canSwitch) action = { label: `Switch to ${plan.name}`, disabled: false };
  else action = { label: paid ? "Coming soon" : `Switch to ${plan.name}`, disabled: true, hint: "Paid plans aren't available yet." };

  return (
    <article
      data-testid={`plan-${plan.id}`}
      className={cn(
        "relative flex flex-col rounded-panel border bg-panel p-6",
        popular ? "border-lime/60 shadow-[0_0_40px_color-mix(in_srgb,var(--color-lime)_8%,transparent)]" : "border-line",
      )}
    >
      {popular && (
        <span className="absolute -top-3 left-6 rounded-full bg-lime px-3 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-on-accent">
          Most popular
        </span>
      )}
      <h2 className="font-heading text-xl font-bold text-ink">{plan.name}</h2>
      <p className="mt-1 text-sm text-ink-muted">{plan.tagline}</p>

      <p className="mt-5 flex items-baseline gap-1">
        <span className="font-heading text-4xl font-bold text-ink">{priceLabel(plan)}</span>
        <span className="text-sm text-ink-muted">/ month</span>
      </p>

      <dl className="mt-5 space-y-1.5 rounded-row bg-track p-3 font-mono text-[12px] text-ink-muted">
        <div className="flex justify-between gap-3">
          <dt>AI model</dt>
          <dd className="text-ink">{plan.model}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Messages / day</dt>
          <dd className="text-ink">{plan.daily_messages}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Images / day</dt>
          <dd className="text-ink">{plan.daily_images > 0 ? plan.daily_images : "-"}</dd>
        </div>
      </dl>

      <ul className="mt-5 flex-1 space-y-2.5">
        {plan.features.map((f) => (
          <li key={f.text} className="flex items-start gap-2.5 text-sm text-ink-body">
            <Check className={cn("mt-0.5 size-4 shrink-0", f.soon ? "text-ink-faint" : "text-lime")} aria-hidden />
            <span className={cn(f.soon && "text-ink-muted")}>
              {f.text}
              {f.soon && <span className="ml-2 rounded-full border border-line px-2 py-px font-mono text-[10px] uppercase text-ink-faint">Soon</span>}
            </span>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => onChoose(plan)}
        disabled={action.disabled || busy}
        title={action.hint}
        data-testid={`plan-choose-${plan.id}`}
        className={cn(
          "mt-6 inline-flex h-11 items-center justify-center gap-2 rounded-row px-4 font-heading text-sm font-bold transition-[box-shadow,background-color] duration-150",
          action.disabled
            ? "cursor-not-allowed bg-panel-hover text-ink-faint"
            : popular
              ? "bg-lime text-on-accent hover:shadow-[0_0_20px_color-mix(in_srgb,var(--color-lime)_30%,transparent)]"
              : "border border-line text-ink hover:bg-panel-hover",
        )}
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {action.label}
      </button>
    </article>
  );
}

/** What is going on with the user's subscription, when it needs saying. */
function SubscriptionBanner({ user, onManage, busy }: { user: AuthUser; onManage: () => void; busy: boolean }) {
  const sub = user.subscription;
  let text: string | null = null;
  if (sub.status === "past_due") text = "Your last payment didn't go through. Update your payment method to keep your plan.";
  else if (sub.cancel_at_period_end && user.plan !== "free")
    text = `Your ${cap(user.plan)} plan is cancelled. You keep it until ${longDate(sub.current_period_end) || "the end of the billing period"}.`;
  if (!text) return null;
  return (
    <div
      role="status"
      data-testid="subscription-banner"
      className="mx-auto mt-8 flex max-w-2xl flex-col items-center gap-3 rounded-panel border border-amber/40 bg-amber/[0.06] px-5 py-4 text-center text-sm text-ink-body sm:flex-row sm:text-left"
    >
      <span className="flex-1">{text}</span>
      <button
        type="button"
        onClick={onManage}
        disabled={busy}
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-row border border-line px-4 font-semibold text-ink hover:bg-panel-hover disabled:opacity-60"
      >
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Manage billing
      </button>
    </div>
  );
}

export default function Pricing() {
  const { user, loading, openAuth } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const returned = params.get("checkout"); // Stripe sends people back here with ?checkout=success|cancelled

  // The key includes the user so the current plan is fetched again after logging in or out
  const { data, isPending, isError } = useQuery({
    queryKey: ["plans", user?.id ?? "guest", user?.plan ?? ""],
    queryFn: authApi.plans,
    staleTime: 0,
  });

  const planChanged = (updated: AuthUser) => {
    queryClient.setQueryData(["auth", "me"], { user: updated });
    queryClient.invalidateQueries({ queryKey: ["kb-quota"] });
  };

  // Test-only switch (no Stripe)
  const switchPlan = useMutation({
    mutationFn: (plan: string) => authApi.switchPlan(plan),
    onSuccess: ({ user: updated }) => {
      planChanged(updated);
      toast.success(`You're now on ${cap(updated.plan)}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't change the plan."),
  });

  // The plan is only granted when Stripe's webhook reaches the server, a moment after paying. The page the
  // browser returns to just waits for that (it never grants anything itself).
  const waiting = useRef(false);
  async function waitForPlan(before: string) {
    if (waiting.current) return;
    waiting.current = true;
    toast.loading("Activating your plan…", { id: "activating" });
    for (let i = 0; i < 15; i++) {
      try {
        const { user: fresh } = await authApi.me();
        if (fresh && fresh.plan !== before) {
          planChanged(fresh);
          toast.success(`You're now on ${cap(fresh.plan)}. Thank you!`, { id: "activating" });
          waiting.current = false;
          return;
        }
      } catch {
        /* keep trying */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    toast.message("Your payment is being processed. Your plan will switch on in a minute or two.", { id: "activating" });
    waiting.current = false;
  }

  const checkout = useMutation({
    mutationFn: (plan: string) => authApi.checkout(plan),
    onSuccess: (result) => {
      if (result.url) window.location.assign(result.url);
      else if (result.changed && user) void waitForPlan(user.plan);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't start checkout."),
  });
  const portal = useMutation({
    mutationFn: authApi.portal,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Couldn't open billing."),
  });

  useEffect(() => {
    if (!returned || loading) return; // after a full page return the login is still being checked
    setParams({}, { replace: true });
    if (returned === "cancelled") toast("Checkout cancelled. You weren't charged.");
    else if (returned === "success" && user) void waitForPlan(user.plan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returned, loading]);

  function choose(plan: PlanInfo) {
    if (!user) return openAuth("login");
    if (data?.billing_enabled) {
      if (plan.price === 0) portal.mutate(); // going back to Free means cancelling in Stripe's portal
      else checkout.mutate(plan.id);
      return;
    }
    switchPlan.mutate(plan.id);
  }

  const busyPlan = (id: string) =>
    (switchPlan.isPending && switchPlan.variables === id) || (checkout.isPending && checkout.variables === id);
  const subscribed = !!user && !!data?.billing_enabled && (user.plan !== "free" || user.subscription.status === "past_due");

  return (
    <StudioShell>
      <main className="flex-1 px-4 py-10 md:px-8 lg:py-14" data-testid="pricing-page">
        <div className="mx-auto max-w-6xl">
          <section className="animate-rise text-center">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">Plans</p>
            <h1 className="mt-4 text-4xl leading-tight md:text-6xl">
              Pick the plan that <span className="text-lime">fits you</span>
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-base text-ink-muted">
              Pro adds spoken replies and longer conversations. Premium adds the research agent and even more memory.
            </p>
            {subscribed && (
              <button
                type="button"
                onClick={() => portal.mutate()}
                disabled={portal.isPending}
                data-testid="manage-billing"
                className="mt-6 inline-flex h-10 items-center gap-2 rounded-row border border-line px-5 text-sm font-semibold text-ink hover:bg-panel-hover disabled:opacity-60"
              >
                {portal.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CreditCard className="size-4" aria-hidden />}
                Manage billing
              </button>
            )}
          </section>

          {user && <SubscriptionBanner user={user} onManage={() => portal.mutate()} busy={portal.isPending} />}

          {isPending && (
            <div className="mt-12 grid gap-5 md:grid-cols-3" aria-label="Loading plans">
              {[0, 1, 2].map((i) => <div key={i} className="h-[520px] animate-pulse rounded-panel bg-panel" />)}
            </div>
          )}

          {isError && (
            <p className="mt-12 text-center text-sm text-danger" data-testid="pricing-error">
              Couldn't load the plans. Is the backend running?
            </p>
          )}

          {data && (
            <>
              <div className="mt-12 grid items-stretch gap-5 md:grid-cols-3">
                {data.plans.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    current={data.current}
                    billing={data.billing_enabled}
                    canSwitch={data.can_switch}
                    busy={busyPlan(plan.id) || (plan.price === 0 && portal.isPending)}
                    onChoose={choose}
                  />
                ))}
              </div>
              <p className="mt-8 text-center text-xs text-ink-faint" data-testid="pricing-note">
                Prices are per month in {data.currency}.{" "}
                {data.billing_enabled
                  ? "Payments are handled securely by Stripe. You can cancel any time."
                  : data.can_switch
                    ? "Payments aren't connected yet, so switching plans is free while this is a preview."
                    : "Billing isn't connected yet, so paid plans can't be bought right now."}
              </p>
            </>
          )}
        </div>
      </main>
    </StudioShell>
  );
}
