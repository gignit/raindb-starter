// lib/auth.ts -- FitLedger authentication (IAM Layer 1: the bolt owns its users).
//
// THE PATTERN TO COPY: a bolt is multi-tenant-SAFE only if every read/write is
// anchored on the AUTHENTICATED userId, never a userId from the request body.
// Register hashes the password; login verifies it and mints a signed session
// JWT into an HttpOnly cookie; every subsequent request re-derives the userId
// from that cookie. A route that trusts req.body.userId is the #1 SaaS-on-RainDB
// security bug -- so the ONLY way a route learns who is calling is requireUser().
//
// All four primitives are LIVE @raindb/bolt-sdk bindings (no external auth
// service, no session store -- the session IS the signed cookie, and the user
// record IS a droplet):
//   crypto.hashPassword / crypto.verifyPassword  -- bcrypt, salted
//   jwt.sign / jwt.verify                          -- HS256 over a NAMED bolt
//     secret (the name is declared in capabilities.raindb.secrets.names; the
//     substrate resolves it -- the bolt never handles the secret bytes)
//   cookies.build / cookies.parse                  -- HttpOnly, SameSite=Strict

import { crypto, jwt, cookies, db, ids, type BoltRequest } from "@raindb/bolt-sdk";

const USERS = "ref-users";
const SESSION_COOKIE = "fl_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const JWT_SECRET_NAME = "FL_SESSION_SECRET";

export interface User {
  userId: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role?: string;
  createdAt: string;
  updatedAt?: string;
}

/** The authenticated caller, derived from the session cookie -- never the body. */
export interface Session {
  userId: string;
  email: string;
  displayName: string;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Read a user by email (login lookup) -- O(1) via the by-email pointer index. */
async function readUserByEmail(email: string): Promise<User | null> {
  const d = await db.readLatest({ formationId: USERS, indexId: "by-email", scopeValue: normalizeEmail(email) });
  return (d?.payload as User | undefined) ?? null;
}

/** Read a user by id (session read) -- O(1) via by-id. */
export async function readUserById(userId: string): Promise<User | null> {
  const d = await db.readLatest({ formationId: USERS, indexId: "by-id", scopeValue: userId });
  return (d?.payload as User | undefined) ?? null;
}

/**
 * Register a new account. Hashes the password (never stored plaintext), mints a
 * UUIDv7 userId, writes the user droplet. Rejects a duplicate email. Returns the
 * created session so the caller can set the cookie (auto-login on register).
 */
export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ session: Session; setCookie: string }> {
  const email = normalizeEmail(input.email);
  if (!email || !input.password || input.password.length < 8) {
    throw new AuthError("email and a password of at least 8 characters are required", 400);
  }
  if (await readUserByEmail(email)) {
    throw new AuthError("an account with that email already exists", 409);
  }
  const user: User = {
    userId: ids.uuidv7(),
    email,
    passwordHash: await crypto.hashPassword(input.password),
    displayName: input.displayName?.trim() || email.split("@")[0],
    role: "member",
    createdAt: new Date().toISOString(),
  };
  await db.writeDroplet({ formationId: USERS, payload: user });
  return issueSession(user);
}

/** Verify credentials and issue a session. Constant-ish failure (no user-enumeration hint). */
export async function login(input: {
  email: string;
  password: string;
}): Promise<{ session: Session; setCookie: string }> {
  const user = await readUserByEmail(input.email);
  const ok = user ? await crypto.verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !ok) {
    throw new AuthError("invalid email or password", 401);
  }
  return issueSession(user);
}

async function issueSession(user: User): Promise<{ session: Session; setCookie: string }> {
  const session: Session = { userId: user.userId, email: user.email, displayName: user.displayName };
  // jwt.sign(secretName, claims, expiresInSec) -- the substrate resolves the
  // named secret; standard claims (iat/iss) are filled in when absent.
  const token = await jwt.sign(
    JWT_SECRET_NAME,
    { sub: user.userId, email: user.email, name: user.displayName },
    SESSION_TTL_SEC,
  );
  const setCookie = await cookies.build(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  return { session, setCookie };
}

/** Clear the session cookie (logout). */
export async function clearSession(): Promise<string> {
  return cookies.build(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 0 });
}

/**
 * THE authorization anchor. Derive the caller from the signed session cookie.
 * Every protected route calls this FIRST and uses the returned userId -- never a
 * userId from the request body or query. Throws AuthError(401) when unauthenticated.
 */
export async function requireUser(req: BoltRequest): Promise<Session> {
  const header = req.headers?.["cookie"] ?? req.headers?.["Cookie"] ?? "";
  const jar = await cookies.parse(String(header));
  const token = jar[SESSION_COOKIE];
  if (!token) throw new AuthError("not signed in", 401);
  let claims: Record<string, unknown>;
  try {
    // jwt.verify(secretName, token) -- validates signature + exp/nbf.
    claims = await jwt.verify(JWT_SECRET_NAME, token);
  } catch {
    throw new AuthError("session expired or invalid", 401);
  }
  const userId = String(claims.sub ?? "");
  if (!userId) throw new AuthError("malformed session", 401);
  return {
    userId,
    email: String(claims.email ?? ""),
    displayName: String(claims.name ?? ""),
  };
}
