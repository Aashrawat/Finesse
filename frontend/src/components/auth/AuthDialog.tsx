import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check, Circle, Eye, EyeOff, Loader2 } from "lucide-react";
import Modal from "@/components/auth/Modal";
import { ForgotStep, ResetStep, VerifyStep, inputClass } from "@/components/auth/EmailCodeSteps";
import { authApi } from "@/lib/authApi";
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
      setField(null);
      setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
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
          {submit.isPending ? (signup ? "Creating account…" : "Logging in…") : signup ? "Sign up" : "Log in"}
        </button>
      </form>

      <p className="mt-4 text-center text-sm text-ink-muted">
        {signup ? "Already have an account?" : "New to Finesse?"}{" "}
        <button
          type="button"
          onClick={switchMode}
          data-testid="auth-switch"
          className="font-semibold text-lime underline-offset-2 hover:underline"
        >
          {signup ? "Log in" : "Sign up"}
        </button>
      </p>
    </Modal>
  );
}
