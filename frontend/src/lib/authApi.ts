import { request } from "@/lib/api";
import type { AuthUser } from "@/lib/types";

/* The login itself is an HttpOnly cookie set by the server, so there is no token to manage here:
 * same-origin fetches send it automatically. */

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const authApi = {
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  signup: (body: { name: string; email: string; password: string }) =>
    request<{ user: AuthUser }>("/api/auth/signup", json("POST", body)),
  login: (body: { email: string; password: string }) =>
    request<{ user: AuthUser }>("/api/auth/login", json("POST", body)),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  updateName: (name: string) => request<{ user: AuthUser }>("/api/auth/me", json("PATCH", { name })),
};
