import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Circle, Eye, EyeOff, Loader2, MailCheck } from "lucide-react";
import { authApi } from "@/lib/authApi";
import { passwordError, passwordRules } from "@/lib/password";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/lib/types";

export const inputClass =
  "no-focus-ring h-11 w-full rounded-row border border-line bg-track px-3.5 text-[15px] text-ink placeholder:text-ink-faint transition-colors duration-150 focus:border-lime/60 focus:outline-none aria-[invalid=true]:border-danger/70";

const submitClass =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-row bg-lime font-heading text-[15px] font-bold text-on-accent transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_24px_color-mix(in_srgb,var(--color-lime)_30%,transparent)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60";
const linkClass = "font-semibold text-lime underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-ink-faint disabled:no-underline";

const RESEND_SECONDS = 60;

/** Counts down from `seconds` (restarts when `restart` changes). */
function useCountdown(seconds: number, restart: number) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const id = window.setInterval(() => setLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [seconds, restart]);
  return left;
}

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Please try again.");

function CodeField({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-ink-body">6-digit code</span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="123456"
        aria-invalid={invalid}
        data-autofocus
        data-testid="auth-code"
        className={cn(inputClass, "text-center font-mono text-2xl tracking-[0.5em]")}
      />
    </label>
  );
}

/** After sign-up (or logging in with an unconfirmed email): enter the code from the email. */
export function VerifyStep({
  email,
  onVerified,
  onBack,
}: {
  email: string;
  onVerified: (user: AuthUser) => void;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [sent, setSent] = useState(0);
  const wait = useCountdown(RESEND_SECONDS, sent);

  const verify = useMutation({
    mutationFn: () => authApi.verify({ email, code }),
    onSuccess: ({ user }) => onVerified(user),
    onError: (err) => {
      setInfo("");
      setError(message(err));
    },
  });
  const resend = useMutation({
    mutationFn: () => authApi.resend(email),
    onSuccess: () => {
      setError("");
      setInfo("We sent you a new code.");
      setSent((n) => n + 1);
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (verify.isPending) return;
    if (code.length !== 6) return setError("Enter the 6-digit code from the email.");
    setError("");
    verify.mutate();
  }

  return (
    <>
      <span className="grid size-11 place-items-center rounded-full bg-lime/10 text-lime">
        <MailCheck className="size-5" aria-hidden />
      </span>
      <h2 className="mt-3 pr-8 text-2xl">Check your email</h2>
      <p className="mt-1 text-sm text-ink-muted">
        We sent a 6-digit code to <span className="font-semibold text-ink" data-testid="auth-code-email">{email}</span>. It expires in 10 minutes.
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-3.5" data-testid="auth-verify-form">
        <CodeField value={code} onChange={setCode} invalid={!!error} />
        {error && <p role="alert" className="text-sm text-danger" data-testid="auth-error">{error}</p>}
        {info && !error && <p role="status" className="text-sm text-lime" data-testid="auth-info">{info}</p>}
        <button type="submit" disabled={verify.isPending} data-testid="auth-verify-submit" className={submitClass}>
          {verify.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {verify.isPending ? "Verifying…" : "Verify email"}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-ink-muted">
        Didn't get it? Check your spam folder or{" "}
        <button
          type="button"
          onClick={() => resend.mutate()}
          disabled={wait > 0 || resend.isPending}
          data-testid="auth-resend"
          className={linkClass}
        >
          {wait > 0 ? `resend in ${wait}s` : "resend the code"}
        </button>
      </p>
      <p className="mt-2 text-center text-sm">
        <button type="button" onClick={onBack} data-testid="auth-verify-back" className="text-ink-muted hover:text-ink">
          Use a different email
        </button>
      </p>
    </>
  );
}

/** "Forgot password": ask for the email, then the code and new password are asked for in ResetStep. */
export function ForgotStep({
  initialEmail,
  onSent,
  onBack,
}: {
  initialEmail: string;
  onSent: (email: string) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState("");
  const send = useMutation({
    mutationFn: () => authApi.forgot(email.trim()),
    onSuccess: () => onSent(email.trim()),
    onError: (err) => setError(message(err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (send.isPending) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email.trim())) return setError("Enter a valid email address.");
    setError("");
    send.mutate();
  }

  return (
    <>
      <h2 className="pr-8 text-2xl">Reset your password</h2>
      <p className="mt-1 text-sm text-ink-muted">Enter your account email and we'll send you a 6-digit code.</p>
      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-3.5" data-testid="auth-forgot-form">
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-body">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={!!error}
            data-autofocus
            data-testid="auth-email"
            className={inputClass}
          />
        </label>
        {error && <p role="alert" className="text-sm text-danger" data-testid="auth-error">{error}</p>}
        <button type="submit" disabled={send.isPending} data-testid="auth-forgot-submit" className={submitClass}>
          {send.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {send.isPending ? "Sending…" : "Send code"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm">
        <button type="button" onClick={onBack} className="text-ink-muted hover:text-ink">Back to log in</button>
      </p>
    </>
  );
}

/** Enter the emailed code and choose a new password. */
export function ResetStep({ email, onDone, onBack }: { email: string; onDone: () => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [sent, setSent] = useState(0);
  const wait = useCountdown(RESEND_SECONDS, sent);

  const reset = useMutation({
    mutationFn: () => authApi.reset({ email, code, password }),
    onSuccess: onDone,
    onError: (err) => {
      setInfo("");
      setError(message(err));
    },
  });
  const resend = useMutation({
    mutationFn: () => authApi.forgot(email),
    onSuccess: () => {
      setError("");
      setInfo("We sent you a new code.");
      setSent((n) => n + 1);
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (reset.isPending) return;
    if (code.length !== 6) return setError("Enter the 6-digit code from the email.");
    if (passwordError(password)) return setError(passwordError(password));
    setError("");
    reset.mutate();
  }

  return (
    <>
      <h2 className="pr-8 text-2xl">Choose a new password</h2>
      <p className="mt-1 text-sm text-ink-muted">
        If <span className="font-semibold text-ink">{email}</span> has an account, we sent it a code.
      </p>
      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-3.5" data-testid="auth-reset-form">
        <CodeField value={code} onChange={setCode} invalid={!!error && code.length !== 6} />
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-body">New password</span>
          <span className="relative block">
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              data-testid="auth-password"
              className={`${inputClass} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </span>
          <ul className="mt-2 space-y-1" aria-label="Password requirements">
            {passwordRules(password).map((rule) => (
              <li key={rule.id} className={cn("flex items-center gap-2 text-xs transition-colors duration-150", rule.ok ? "text-lime" : "text-ink-muted")}>
                {rule.ok ? <Check className="size-3.5 shrink-0" aria-hidden /> : <Circle className="size-3.5 shrink-0" aria-hidden />}
                {rule.label}
              </li>
            ))}
          </ul>
        </label>
        {error && <p role="alert" className="text-sm text-danger" data-testid="auth-error">{error}</p>}
        {info && !error && <p role="status" className="text-sm text-lime">{info}</p>}
        <button type="submit" disabled={reset.isPending} data-testid="auth-reset-submit" className={submitClass}>
          {reset.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {reset.isPending ? "Saving…" : "Save new password"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-ink-muted">
        Didn't get it?{" "}
        <button type="button" onClick={() => resend.mutate()} disabled={wait > 0 || resend.isPending} className={linkClass}>
          {wait > 0 ? `resend in ${wait}s` : "resend the code"}
        </button>
      </p>
      <p className="mt-2 text-center text-sm">
        <button type="button" onClick={onBack} className="text-ink-muted hover:text-ink">Back to log in</button>
      </p>
    </>
  );
}
