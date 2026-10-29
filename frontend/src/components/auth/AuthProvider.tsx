import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import AuthDialog, { type AuthMode } from "@/components/auth/AuthDialog";
import SettingsDialog from "@/components/auth/SettingsDialog";
import { authApi } from "@/lib/authApi";
import type { AuthUser } from "@/lib/types";

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

  // Ctrl+Shift+, opens Settings (shown as a hint in the account menu)
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "," || e.key === "<" || e.code === "Comma")) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [user]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, loading: isPending, openAuth, openSettings, logout }),
    [user, isPending, openAuth, openSettings, logout],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}

      {authMode && !user && (
        <AuthDialog
          mode={authMode}
          onModeChange={setAuthMode}
          onClose={() => setAuthMode(null)}
          onSuccess={(loggedIn, mode) => {
            setUser(loggedIn);
            setAuthMode(null);
            toast.success(mode === "signup" ? `Welcome to Finesse, ${loggedIn.name}` : `Welcome back, ${loggedIn.name}`);
          }}
        />
      )}

      {settingsOpen && user && (
        <SettingsDialog user={user} onClose={() => setSettingsOpen(false)} onSaved={setUser} />
      )}
    </AuthContext.Provider>
  );
}
