import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, getRedirectResult, signInWithRedirect, type Auth } from "firebase/auth";
import { authApi, type FirebaseWebConfig } from "@/lib/authApi";

const CONFIG_KEY = "finesse-firebase-config";

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let loaded: FirebaseWebConfig | null | undefined;
let preparing: Promise<FirebaseWebConfig | null> | null = null;
let pending: Promise<string | null> | null = null;

function readStoredConfig(): FirebaseWebConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FirebaseWebConfig;
    if (parsed.apiKey && parsed.authDomain && parsed.projectId && parsed.appId) return parsed;
  } catch {
    /* ignore a stale value */
  }
  return null;
}

function writeStoredConfig(config: FirebaseWebConfig) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* private mode can block storage */
  }
}

function authDomain(config: FirebaseWebConfig): string {
  // HTTPS deploys can host Firebase's helper on this same site. Local http://localhost
  // cannot — Firebase then opens https://localhost and the browser shows ERR_SSL_PROTOCOL_ERROR.
  if (window.location.protocol === "https:") return window.location.host;
  return config.authDomain;
}

function client(config: FirebaseWebConfig): Auth {
  if (!auth) {
    const settings = { ...config, authDomain: authDomain(config) };
    app = getApps().find((item) => item.name === "finesse") ?? initializeApp(settings, "finesse");
    auth = getAuth(app);
  }
  return auth;
}

async function settings(): Promise<FirebaseWebConfig | null> {
  if (loaded !== undefined) return loaded;
  const stored = readStoredConfig();
  if (stored) {
    loaded = stored;
    return loaded;
  }
  if (!preparing) {
    preparing = authApi
      .firebase()
      .then((result) => {
        loaded = result.enabled ? result.config : null;
        if (loaded) writeStoredConfig(loaded);
        return loaded;
      })
      .catch(() => {
        loaded = null;
        return null;
      });
  }
  return preparing;
}

export async function prepareGoogle(): Promise<boolean> {
  const config = await settings();
  if (!config) return false;
  writeStoredConfig(config);
  client(config);
  return true;
}

export async function googleEnabled(): Promise<boolean> {
  return prepareGoogle();
}

/** After Google sends you back, finish once and create the Finesse login. */
export function consumeGoogleRedirect(): Promise<string | null> {
  if (!pending) {
    pending = (async () => {
      const config = await settings();
      if (!config) return null;
      const authClient = client(config);
      await authClient.authStateReady();
      try {
        const redirected = await getRedirectResult(authClient);
        if (redirected?.user) return redirected.user.getIdToken();
      } catch {
        /* fall through to a session Firebase already kept */
      }
      if (authClient.currentUser) return authClient.currentUser.getIdToken();
      return null;
    })().catch(() => null);
  }
  return pending;
}

/** This tab goes to Google, then comes back to Finesse signed in. */
export async function startGoogle(): Promise<void> {
  const config = await settings();
  if (!config) throw new Error("Google sign-in isn't set up yet.");
  await signInWithRedirect(client(config), new GoogleAuthProvider());
}
