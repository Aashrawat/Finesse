import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Circle, Eye, EyeOff, Loader2, X } from "lucide-react";
import Modal from "@/components/auth/Modal";
import { ForgotStep, ResetStep, VerifyStep, inputClass } from "@/components/auth/EmailCodeSteps";
import { authApi } from "@/lib/authApi";
import { forgetAccount, initials, listAccounts, type RememberedAccount } from "@/lib/rememberedAccounts";
import { passwordError, passwordRules } from "@/lib/password";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/lib/types";

export type AuthMode = "login" | "signup";

interface Props {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onSuccess: (user: AuthUser, mode: AuthMode) => void;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

type Step = "form" | "verify" | "forgot" | "reset";

export default function AuthDialog({ mode, onModeChange, onClose, onSuccess }: Props) {
  const signup = mode === "signup";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [field, setField] = useState<"name" | "email" | "password" | null>(null);
  // After the form: enter the emailed code (verify), or the forgot-password steps
  const [step, setStep] = useState<Step>("form");
  const [codeEmail, setCodeEmail] = useState("");
  const [googleOn, setGoogleOn] = useState(false);
  const [accounts, setAccounts] = useState<RememberedAccount[]>(() => listAccounts());
  const [picker, setPicker] = useState(() => !signup);

  useEffect(() => {
    void authApi.firebase().then((result) => setGoogleOn(result.enabled)).catch(() => setGoogleOn(false));
  }, []);

  useEffect(() => {
    if (signup) setPicker(false);
  }, [signup]);

  const submit = useMutation({
    mutationFn: () => (signup ? authApi.signup({ name, email, password }) : authApi.login({ email, password })),
    onSuccess: (result) => {
      if ("verification_required" in result) {
        // the account isn't active until the emailed code is entered: no login yet
        setCodeEmail(result.email);
        setPassword("");
        setNotice("");
        setStep("verify");
      } else {
        onSuccess(result.user, mode);
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      setField(null);
      if (signup && /already exists/i.test(message)) {
        setPicker(false);
        setNotice("This account already exists. Please log in.");
        setError("");
        onModeChange("login");
        return;
      }
      setError(message);
    },
  });

  function fail(which: "name" | "email" | "password", message: string) {
    setField(which);
    setError(message);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submit.isPending) return;
    if (signup && !name.trim()) return fail("name", "Enter your name.");
    if (!EMAIL.test(email.trim())) return fail("email", "Enter a valid email address.");
    if (!password) return fail("password", "Enter your password.");
    if (signup && passwordError(password)) return fail("password", passwordError(password));
    setError("");
    setField(null);
    submit.mutate();
  }

  function switchMode() {
    setError("");
    setNotice("");
    setField(null);
    setPassword("");
    onModeChange(signup ? "login" : "signup");
  }

  function backToForm() {
    setError("");
    setPassword("");
    setStep("form");
  }

  function chooseAccount(account: RememberedAccount) {
    if (account.provider === "google") {
      window.location.href = `/api/auth/google/start?hint=${encodeURIComponent(account.email)}`;
      return;
    }
    setEmail(account.email);
    setPicker(false);
    onModeChange("login");
  }

  function removeAccount(email: string) {
    forgetAccount(email);
    const next = listAccounts();
    setAccounts(next);
    if (!next.length) setPicker(false);
  }

  if (picker && !signup) {
    return (
      <Modal key="picker" title="Welcome back" onClose={onClose} testId="auth-dialog">
        <h2 className="pr-8 text-2xl">Welcome back</h2>
        <p className="mt-1 text-sm text-ink-muted">Choose an account to continue.</p>
        <ul className="mt-5 space-y-1" data-testid="auth-accounts">
          {accounts.map((account) => (
            <li key={account.email}>
              <div className="flex items-center gap-2 rounded-row px-1 py-1 hover:bg-panel-hover">
                <button
                  type="button"
                  onClick={() => chooseAccount(account)}
                  data-testid="auth-account"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#10a37f] text-sm font-semibold text-white">
                    {initials(account.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{account.name}</span>
                    <span className="block truncate text-xs text-ink-muted">{account.email}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${account.email}`}
                  onClick={() => removeAccount(account.email)}
                  data-testid="auth-account-remove"
                  className="grid size-8 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-panel hover:text-ink"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-5 space-y-2.5">
          <button
            type="button"
            onClick={() => {
              setPicker(false);
              onModeChange("login");
            }}
            data-testid="auth-another"
            className="inline-flex h-11 w-full items-center justify-center rounded-full border border-line bg-panel text-sm font-semibold text-ink transition-colors duration-150 hover:bg-panel-hover"
          >
            Log in to another account
          </button>
          <button
            type="button"
            onClick={() => {
              setPicker(false);
              onModeChange("signup");
            }}
            data-testid="auth-create"
            className="inline-flex h-11 w-full items-center justify-center rounded-full border border-line bg-panel text-sm font-semibold text-ink transition-colors duration-150 hover:bg-panel-hover"
          >
            Create account
          </button>
        </div>
      </Modal>
    );
  }

  if (step !== "form") {
    const title = step === "verify" ? "Verify your email" : "Reset your password";
    return (
      <Modal key={step} title={title} onClose={onClose} testId="auth-dialog">
        {step === "verify" && (
          <VerifyStep email={codeEmail} onVerified={(user) => onSuccess(user, "signup")} onBack={backToForm} />
        )}
        {step === "forgot" && (
          <ForgotStep
            initialEmail={email}
            onSent={(sentTo) => {
              setCodeEmail(sentTo);
              setStep("reset");
            }}
            onBack={backToForm}
          />
        )}
        {step === "reset" && (
          <ResetStep
            email={codeEmail}
            onBack={backToForm}
            onDone={() => {
              setEmail(codeEmail);
              setNotice("Your password was changed. Log in with your new password.");
              onModeChange("login");
              setStep("form");
            }}
          />
        )}
      </Modal>
    );
  }

  return (
    <Modal key="form" title={signup ? "Create your account" : "Log in"} onClose={onClose} testId="auth-dialog">
      <h2 className="pr-8 text-2xl">{signup ? "Create your account" : "Welcome back"}</h2>
      <p className="mt-1 text-sm text-ink-muted">
        {signup ? "Sign up to keep your work with your Finesse account." : "Log in to your Finesse account."}
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-3.5" data-testid="auth-form">
        {signup && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-ink-body">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={60}
              placeholder="Your name"
              aria-invalid={field === "name"}
              data-autofocus
              data-testid="auth-name"
              className={inputClass}
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-body">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-invalid={field === "email"}
            data-autofocus={signup ? undefined : true}
            data-testid="auth-email"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-body">Password</span>
          <span className="relative block">
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={signup ? "new-password" : "current-password"}
              placeholder={signup ? "At least 8 characters" : "Your password"}
              aria-invalid={field === "password"}
              data-testid="auth-password"
              className={`${inputClass} pr-11`}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              data-testid="auth-show-password"
              className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-panel-hover hover:text-ink"
            >
              {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </span>

          {signup && (
            <ul className="mt-2 space-y-1" aria-label="Password requirements" data-testid="auth-password-rules">
              {passwordRules(password).map((rule) => (
                <li
                  key={rule.id}
                  data-testid={`auth-rule-${rule.id}`}
                  data-ok={rule.ok}
                  className={cn("flex items-center gap-2 text-xs transition-colors duration-150", rule.ok ? "text-lime" : "text-ink-muted")}
                >
                  {rule.ok ? <Check className="size-3.5 shrink-0" aria-hidden /> : <Circle className="size-3.5 shrink-0" aria-hidden />}
                  {rule.label}
                  <span className="sr-only">{rule.ok ? " (done)" : " (not yet)"}</span>
                </li>
              ))}
            </ul>
          )}
        </label>

        {!signup && (
          <p className="-mt-1 text-right text-sm">
            <button
              type="button"
              onClick={() => {
                setError("");
                setNotice("");
                setStep("forgot");
              }}
              data-testid="auth-forgot"
              className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Forgot password?
            </button>
          </p>
        )}

        {notice && !error && (
          <p role="status" className="text-sm text-lime" data-testid="auth-notice">
            {notice}
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger" data-testid="auth-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submit.isPending}
          data-testid="auth-submit"
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-row bg-lime font-heading text-[15px] font-bold text-on-accent transition-[transform,box-shadow] duration-150 hover:shadow-[0_0_24px_color-mix(in_srgb,var(--color-lime)_30%,transparent)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submit.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {submit.isPending ? (signup ? "Creating account…" : "Logging in…") : signup ? "Create account" : "Log in"}
        </button>
      </form>

      {googleOn && (
        <div className="mt-4">
          <p className="mb-3 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">or</p>
          <a
            href={signup ? "/api/auth/google/start?intent=signup" : "/api/auth/google/start"}
            data-testid="auth-google"
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-row border border-line bg-panel text-sm font-semibold text-ink transition-colors duration-150 hover:bg-panel-hover"
          >
            <GoogleMark />
            Continue with Google
          </a>
        </div>
      )}

      {signup && (
        <p className="mt-4 text-center text-sm text-ink-muted">
          Already have an account?{" "}
          <button
            type="button"
            onClick={switchMode}
            data-testid="auth-switch"
            className="font-semibold text-lime underline-offset-2 hover:underline"
          >
            Log in
          </button>
        </p>
      )}
    </Modal>
  );
}

function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.4c-.3 1.5-1.2 2.8-2.5 3.7v3h4c2.4-2.2 3.6-5.4 3.6-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-4-3c-1.1.8-2.5 1.2-3.9 1.2-3 0-5.6-2-6.5-4.8H1.4v3.1C3.4 21.4 7.4 24 12 24z" />
      <path fill="#FBBC05" d="M5.5 14.5c-.2-.7-.4-1.4-.4-2.5s.1-1.8.4-2.5V6.4H1.4C.5 8.2 0 10 0 12s.5 3.8 1.4 5.6l4.1-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.6 1.4 6.4l4.1 3.1C6.4 6.8 9 4.8 12 4.8z" />
    </svg>
  );
}
