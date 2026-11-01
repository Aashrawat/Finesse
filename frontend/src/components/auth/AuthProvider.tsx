import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AuthDialog, { type AuthMode } from "@/components/auth/AuthDialog";
import SettingsDialog from "@/components/auth/SettingsDialog";
import Modal from "@/components/auth/Modal";
import { VerifyStep } from "@/components/auth/EmailCodeSteps";
import { authApi } from "@/lib/authApi";
import { rememberAccount } from "@/lib/rememberedAccounts";
import type { AuthUser } from "@/lib/types";

function keepUser(user: AuthUser, provider: "google" | "password") {
  rememberAccount({ name: user.name, email: user.email, provider });
}

interface AuthContextValue {
  /** The logged-in user, or null (also null while the first check is still running). */
  user: AuthUser | null;
  loading: boolean;
  openAuth: (mode: AuthMode) => void;
  openSettings: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ME_KEY = ["auth", "me"] as const;

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

/** Holds the login state for the whole app and renders the login/sign-up and settings dialogs once. */
export default function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [googleVerifyEmail, setGoogleVerifyEmail] = useState("");

  const { data, isPending } = useQuery({
    queryKey: ME_KEY,
    queryFn: authApi.me,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const user = data?.user ?? null;

  const setUser = useCallback(
    (next: AuthUser | null) => queryClient.setQueryData(ME_KEY, { user: next }),
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* even if the request fails we still forget the user on this screen; the server login just expires later */
    }
    setUser(null);
    setSettingsOpen(false);
    toast.success("Logged out");
  }, [setUser]);

  const openAuth = useCallback((mode: AuthMode) => setAuthMode(mode), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("google");
    if (!flag) return;
    const emailed = params.get("email") || "";
    const url = new URL(window.location.href);
    url.searchParams.delete("google");
    url.searchParams.delete("email");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    if (flag === "ok") {
      void authApi.me().then((result) => {
        if (!result.user) return;
        keepUser(result.user, "google");
        setUser(result.user);
        setAuthMode(null);
        toast.success(`Welcome, ${result.user.name}`);
      });
      return;
    }
    if (flag === "verify" && emailed) {
      setAuthMode(null);
      setGoogleVerifyEmail(emailed);
      toast.success(`We sent a code to ${emailed}`);
      return;
    }
    if (flag === "exists") {
      toast.error("This account already exists. Please log in.");
      setAuthMode("login");
      return;
    }
    if (flag === "denied") toast.error("Google sign-in was cancelled.");
    else if (flag === "token") toast.error("Google didn't accept the app secret. Check GOOGLE_CLIENT_SECRET in .env.");
    else if (flag === "state") toast.error("Google sign-in expired. Click Continue with Google once more.");
    else toast.error("Google sign-in didn't finish. Try Continue with Google again.");
  }, [setUser]);

  // Ctrl+Shift+, opens Settings (shown as a hint in the account menu)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "," || e.key === "<" || e.code === "Comma")) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading: isPending, openAuth, openSettings, logout }),
    [user, isPending, openAuth, openSettings, logout],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}

      {authMode && !user && !googleVerifyEmail && (
        <AuthDialog
          mode={authMode}
          onModeChange={setAuthMode}
          onClose={() => setAuthMode(null)}
          onSuccess={(loggedIn, mode) => {
            keepUser(loggedIn, "password");
            setUser(loggedIn);
            setAuthMode(null);
            toast.success(mode === "signup" ? `Welcome to Finesse, ${loggedIn.name}` : `Welcome back, ${loggedIn.name}`);
          }}
        />
      )}

      {googleVerifyEmail && !user && (
        <Modal title="Verify your email" onClose={() => setGoogleVerifyEmail("")} testId="auth-dialog">
          <VerifyStep
            email={googleVerifyEmail}
            onVerified={(loggedIn) => {
              keepUser(loggedIn, "google");
              setUser(loggedIn);
              setGoogleVerifyEmail("");
              toast.success(`Welcome to Finesse, ${loggedIn.name}`);
            }}
            onBack={() => setGoogleVerifyEmail("")}
          />
        </Modal>
      )}

      {/* guests get Settings too: it holds the appearance (day / night mode and accent colour) */}
      {settingsOpen && <SettingsDialog user={user} onClose={() => setSettingsOpen(false)} onSaved={setUser} />}
    </AuthContext.Provider>
  );
}
