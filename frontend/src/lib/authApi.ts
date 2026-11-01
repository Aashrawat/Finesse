import { request } from "@/lib/api";
import type { AuthUser, PlansResponse } from "@/lib/types";

/* The login itself is an HttpOnly cookie set by the server, so there is no token to manage here:
 * same-origin fetches send it automatically. */

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Sign-up (and logging in with an unconfirmed email) doesn't log anyone in: a 6-digit code is emailed first. */
export type AuthResult = { user: AuthUser } | { verification_required: true; email: string };

export type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

export const authApi = {
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  firebase: () => request<{ enabled: boolean; config: FirebaseWebConfig | null }>("/api/auth/firebase"),
  google: (id_token: string) => request<{ user: AuthUser }>("/api/auth/google", json("POST", { id_token })),
  signup: (body: { name: string; email: string; password: string }) =>
    request<AuthResult>("/api/auth/signup", json("POST", body)),
  login: (body: { email: string; password: string }) => request<AuthResult>("/api/auth/login", json("POST", body)),
  /** Enter the emailed code: this is what activates the account and logs in. */
  verify: (body: { email: string; code: string }) => request<{ user: AuthUser }>("/api/auth/verify", json("POST", body)),
  resend: (email: string) => request<{ ok: boolean }>("/api/auth/resend", json("POST", { email })),
  forgot: (email: string) => request<{ ok: boolean }>("/api/auth/forgot", json("POST", { email })),
  reset: (body: { email: string; code: string; password: string }) =>
    request<{ ok: boolean }>("/api/auth/reset", json("POST", body)),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  plans: () => request<PlansResponse>("/api/plans"),
  /** Change your own plan (only works while the server has PLANS_DEV_SWITCH on and Stripe is not set up). */
  switchPlan: (plan: string) => request<{ user: AuthUser }>("/api/plans/switch", json("POST", { plan })),
  /** Stripe Checkout for a plan: {url} to open, or {changed} when an existing subscription was switched. */
  checkout: (plan: string) => request<{ url?: string; changed?: boolean }>("/api/billing/checkout", json("POST", { plan })),
  /** Stripe's page for the card, invoices and cancelling. */
  portal: () => request<{ url: string }>("/api/billing/portal", { method: "POST" }),
  updateName: (name: string) => request<{ user: AuthUser }>("/api/auth/me", json("PATCH", { name })),
};
