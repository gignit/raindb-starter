// lib/auth.ts -- FitLedger authentication (IAM Layer 1: the bolt owns its users).
//
// This is the APP's end-user accounts (a gym member signing in) -- DISTINCT from
// the TENANT key that runs the bolt itself. The pattern is modeled on the proven
// raindb-app bolt auth (bolt/server/auth.ts): a signed JWT that carries a
// sessionId, PLUS a revocable session TOKEN in RainDB.
//
// Why both a JWT and a session token? A bare JWT cannot be revoked before it
// expires. By also writing a ref-session token (recycle 30d, autoExtend) and
// putting its sessionId in the JWT, every request re-reads the session token:
//   * the read silently EXTENDS the session (autoExtend) -- a sliding window;
//   * logout DELETES the session token, so the JWT is instantly dead;
//   * revokeAllSessions can sign the user out everywhere.
// A route learns the caller ONLY from requireUser() -- never req.body.userId
// (trusting the body is the #1 SaaS-on-RainDB security bug).
//
// Primitives (all coder-verified LIVE @raindb/bolt-sdk bindings; no external auth
// service): crypto.hashPassword/verifyPassword (bcrypt),
// jwt.sign(secretName,claims,expiresInSec)/verify(secretName,token) over a NAMED
// secret the substrate resolves, cookies.parse, db.writeDroplet/writeToken/
// readLatest, token.delete.

import { crypto, jwt, cookies, db, token, ids, type BoltRequest } from "@raindb/bolt-sdk";
import { payload } from "./http.js";

const USERS = "ref-users";
const SESSIONS = "ref-session";
const SESSION_COOKIE = "fl_token";
const TOKEN_EXPIRY_SEC = 60 * 60 * 24 * 30; // 30 days
const JWT_SECRET_NAME = "FL_SESSION_SECRET";

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  name: string;
  active: boolean;
  role?: string;
  createdAt?: string;
  lastLoginAt?: string;
}

/** The authenticated caller, derived from the verified JWT + live session. */
export interface Session {
  userId: string;
  email: string;
  name: string;
  role: string;
  sessionId: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function readUserByEmail(email: string): Promise<User | null> {
  const d = await db.readLatest({ formationId: USERS, indexId: "by-email", scopeValue: normalizeEmail(email) });
  return (d?.payload as User | undefined) ?? null;
}

export async function readUserById(userId: string): Promise<User | null> {
  const d = await db.readLatest({ formationId: USERS, indexId: "by-id", scopeValue: userId });
  return (d?.payload as User | undefined) ?? null;
}

// ------------------------------------------------------------- token + session

function generateToken(user: Pick<User, "userId" | "email" | "name" | "role">, sessionId: string): Promise<string> {
  return jwt.sign(
    JWT_SECRET_NAME,
    { userId: user.userId, email: user.email, name: user.name, role: user.role ?? "member", sessionId },
    TOKEN_EXPIRY_SEC,
  );
}

/** Write a revocable session token. Mint the sessionId here (not via autoGen)
 *  so the exact id is known for BOTH the token write and the JWT: the goja host
 *  ctx.db.writeToken returns only the dropletId, not the minted scopeValue, so
 *  we cannot rely on the write result to learn an auto-generated sessionId. */
async function createSession(user: User, meta: { userAgent?: string } = {}): Promise<string> {
  const sessionId = ids.uuidv7();
  await db.writeToken({
    formationId: SESSIONS,
    payload: payload({
      sessionId, userId: user.userId, email: user.email, name: user.name, role: user.role ?? "member",
      userAgent: meta.userAgent ?? "", createdAt: new Date().toISOString(),
    }),
  });
  return sessionId;
}

// --------------------------------------------------------------- register/login

export interface AuthOutcome {
  token: string;
  setCookie: string;
  user: { userId: string; email: string; name: string; role: string };
}

export async function register(input: { email: string; password: string; name: string; userAgent?: string }): Promise<AuthOutcome> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password || input.password.length < 8) {
    throw new AuthError("email and a password of at least 8 characters are required", 400);
  }
  if (await readUserByEmail(email)) throw new AuthError("an account with that email already exists", 409);
  const user: User = {
    userId: ids.uuidv7(),
    email,
    passwordHash: await crypto.hashPassword(input.password, 12),
    name: input.name?.trim() || email.split("@")[0] || email,
    active: true,
    role: "member",
    createdAt: new Date().toISOString(),
  };
  await db.writeDroplet({ formationId: USERS, payload: payload(user) });
  return issue(user, input.userAgent);
}

export async function login(input: { email: string; password: string; userAgent?: string }): Promise<AuthOutcome> {
  const user = await readUserByEmail(input.email);
  const ok = user ? await crypto.verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !ok || user.active === false) throw new AuthError("invalid email or password", 401);
  // Stamp lastLoginAt as a new revision (audit trail of logins, for free).
  await db.writeDroplet({ formationId: USERS, payload: payload({ ...user, lastLoginAt: new Date().toISOString() }) });
  return issue(user, input.userAgent);
}

async function issue(user: User, userAgent?: string): Promise<AuthOutcome> {
  const sessionId = await createSession(user, { userAgent });
  const tok = await generateToken(user, sessionId);
  const setCookie = await cookies.build(SESSION_COOKIE, tok, {
    httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: TOKEN_EXPIRY_SEC,
  });
  return { token: tok, setCookie, user: { userId: user.userId, email: user.email, name: user.name, role: user.role ?? "member" } };
}

/** Logout: delete the session token (instant revoke) + clear the cookie. */
export async function logout(session: Session): Promise<string> {
  try {
    await token.delete(SESSIONS, session.sessionId);
  } catch {
    // best-effort: an already-expired session is fine
  }
  return cookies.build(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 0 });
}

// -------------------------------------------------------------- the anchor

/** Pull the JWT off the Authorization: Bearer header, or the session cookie. */
async function extractToken(req: BoltRequest): Promise<string | null> {
  const authHeader = req.headers?.["authorization"] ?? req.headers?.["Authorization"];
  if (authHeader) {
    const h = String(authHeader);
    return h.startsWith("Bearer ") ? h.slice(7) : h;
  }
  const cookieHeader = req.headers?.["cookie"] ?? req.headers?.["Cookie"] ?? "";
  const jar = await cookies.parse(String(cookieHeader));
  return jar[SESSION_COOKIE] ?? null;
}

/**
 * THE authorization anchor. Every protected route calls this FIRST. Verifies the
 * JWT, then reads the ref-session token to confirm it hasn't been revoked (the
 * read also autoExtends the session). Throws AuthError(401) otherwise. The
 * returned userId is the ONLY user identity a route may trust.
 */
export async function requireUser(req: BoltRequest): Promise<Session> {
  const tok = await extractToken(req);
  if (!tok) throw new AuthError("not signed in", 401);

  let claims: Record<string, unknown>;
  try {
    claims = await jwt.verify(JWT_SECRET_NAME, tok);
  } catch {
    throw new AuthError("session expired or invalid", 401);
  }
  const userId = String(claims.userId ?? "");
  const sessionId = String(claims.sessionId ?? "");
  if (!userId || !sessionId) throw new AuthError("malformed session", 401);

  // Revocation check + silent autoExtend: a deleted session token = logged out.
  const live = await db.readLatest({ formationId: SESSIONS, indexId: "by-id", scopeValue: sessionId });
  if (!live) throw new AuthError("session expired or revoked", 401);
  const p = (live.payload as Record<string, unknown> | undefined) ?? {};

  // Live-merge role/name/email off the session so a role change takes effect
  // on the next request (the JWT's copy may be stale).
  return {
    userId,
    email: String(p.email ?? claims.email ?? ""),
    name: String(p.name ?? claims.name ?? ""),
    role: String(p.role ?? claims.role ?? "member"),
    sessionId,
  };
}
