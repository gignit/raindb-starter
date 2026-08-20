// routes/auth.ts -- register / login / logout / me. Thin HTTP over lib/auth.ts.
//
// The route's whole job: parse the body, call the auth helper, set the session
// cookie, shape the JSON. It NEVER reads a userId from the body -- protected
// routes get the caller from requireUser() (the session cookie / Bearer token).

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { ok, bad, readJsonBody } from "../lib/http.js";
import { register, login, logout, requireUser, AuthError } from "../lib/auth.js";

function authError(e: unknown): BoltResponse {
  if (e instanceof AuthError) return bad(e.message, e.status);
  return bad(e instanceof Error ? e.message : "auth failed", 500);
}

function withCookie(body: unknown, setCookie: string): BoltResponse {
  return ok(body, { "set-cookie": setCookie });
}

export async function handleRegister(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const out = await register({
      email: String(b.email ?? ""),
      password: String(b.password ?? ""),
      name: String(b.name ?? ""),
      userAgent: String(req.headers?.["user-agent"] ?? ""),
    });
    return withCookie({ token: out.token, user: out.user }, out.setCookie);
  } catch (e) {
    return authError(e);
  }
}

export async function handleLogin(req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  try {
    const out = await login({
      email: String(b.email ?? ""),
      password: String(b.password ?? ""),
      userAgent: String(req.headers?.["user-agent"] ?? ""),
    });
    return withCookie({ token: out.token, user: out.user }, out.setCookie);
  } catch (e) {
    return authError(e);
  }
}

export async function handleLogout(req: BoltRequest): Promise<BoltResponse> {
  try {
    const session = await requireUser(req);
    const clear = await logout(session);
    return withCookie({ ok: true }, clear);
  } catch (e) {
    return authError(e);
  }
}

/** Who am I? -- the client calls this on load to restore the session. */
export async function handleMe(req: BoltRequest): Promise<BoltResponse> {
  try {
    const s = await requireUser(req);
    return ok({ user: { userId: s.userId, email: s.email, name: s.name, role: s.role } });
  } catch (e) {
    return authError(e);
  }
}
