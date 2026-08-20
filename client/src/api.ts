// api.ts -- the Fit client's entire API surface. Plain fetch against the
// bolt. Same origin in dev (Vite proxies /api/*) and prod (the bolt serves the
// SPA next to these routes) -- no CORS, no env switching. The session cookie is
// HttpOnly and rides automatically; we also keep the Bearer token for clarity.

let bearer: string | null = null;
export function setToken(t: string | null): void {
  bearer = t;
  if (t) localStorage.setItem("fl_token", t);
  else localStorage.removeItem("fl_token");
}
export function loadToken(): string | null {
  bearer = localStorage.getItem("fl_token");
  return bearer;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) msg = b.error;
    } catch {
      /* keep status */
    }
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function req(path: string, method = "GET", body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return fetch(`/api${path}`, {
    method,
    headers,
    credentials: "include",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ---------------------------------------------------------------- auth

export interface User { userId: string; email: string; name: string; role: string; }

export async function register(email: string, password: string, name: string): Promise<User> {
  const d = await json<{ token: string; user: User }>(await req("/auth/register", "POST", { email, password, name }));
  setToken(d.token);
  return d.user;
}
export async function login(email: string, password: string): Promise<User> {
  const d = await json<{ token: string; user: User }>(await req("/auth/login", "POST", { email, password }));
  setToken(d.token);
  return d.user;
}
export async function logout(): Promise<void> {
  try { await req("/auth/logout", "POST"); } finally { setToken(null); }
}
export async function me(): Promise<User | null> {
  try { return (await json<{ user: User }>(await req("/auth/me"))).user; } catch { return null; }
}

// ---------------------------------------------------------------- journal

export interface Entry {
  entryId: string; authorName: string; title: string; body: string;
  status?: string; tags?: string[]; encrypted?: boolean;
  createdAt: string; updatedAt?: string | null; revisionNote?: string | null;
}
export interface Revision { dropletId: string; ts: number; entry: Entry; }

export async function listEntries(): Promise<Entry[]> {
  return (await json<{ entries: Entry[] }>(await req("/journal/entries"))).entries;
}
export async function getEntry(id: string): Promise<Entry> {
  return (await json<{ entry: Entry }>(await req(`/journal/entries/${id}`))).entry;
}
export async function createEntry(e: { title: string; body?: string; ciphertext?: string; encrypted?: boolean; tags?: string[] }): Promise<Entry> {
  return (await json<{ entry: Entry }>(await req("/journal/entries", "POST", e))).entry;
}
export async function editEntry(id: string, e: { title?: string; body?: string; ciphertext?: string; encrypted?: boolean; tags?: string[]; revisionNote?: string }): Promise<Entry> {
  return (await json<{ entry: Entry }>(await req(`/journal/entries/${id}`, "PUT", e))).entry;
}
export async function entryHistory(id: string): Promise<Revision[]> {
  return (await json<{ revisions: Revision[] }>(await req(`/journal/entries/${id}/history`))).revisions;
}
export async function restoreEntry(id: string, dropletId: string): Promise<Entry> {
  return (await json<{ entry: Entry }>(await req(`/journal/entries/${id}/restore`, "POST", { dropletId }))).entry;
}
export async function autosaveDraft(d: { draftId?: string; title?: string; body?: string; ciphertext?: string; encrypted?: boolean; tags?: string[] }): Promise<string> {
  return (await json<{ draftId: string }>(await req("/journal/drafts", "POST", d))).draftId;
}
export async function getDraft(draftId: string): Promise<Record<string, unknown> | null> {
  try { return (await json<{ draft: Record<string, unknown> }>(await req(`/journal/drafts/${draftId}`))).draft; } catch { return null; }
}
export async function discardDraft(draftId: string): Promise<void> {
  await req(`/journal/drafts/${draftId}`, "DELETE");
}
export async function journalTags(): Promise<string[]> {
  return (await json<{ tags: string[] }>(await req("/journal/tags"))).tags;
}

// ---------------------------------------------------------------- workout

export interface MetricField { key: string; label: string; kind: string; unit?: string; }
export interface MetricSchema { fields: MetricField[]; chartHint?: string; benchmarkable?: boolean; }
export interface Category { categoryId: string; userId: string; parentId: string; name: string; categoryPath?: string; sortOrder?: number; metricSchema: MetricSchema; }
export interface WorkoutSet {
  setId: string; categoryId: string; categoryName: string; categoryPath: string;
  weightKg?: number | null; reps?: number | null; distanceM?: number | null; durationS?: number | null;
  avgHeartRateBpm?: number | null; elevationM?: number | null; rpe?: number | null;
  isBenchmark: boolean; recordedAt: string;
}
export interface Freshness { behind: boolean; status: string; }

export async function listCategories(parentId = "root"): Promise<Category[]> {
  return (await json<{ categories: Category[] }>(await req(`/workout/categories/${parentId}/children`))).categories;
}
export async function createCategory(c: { parentId?: string; name: string; categoryPath?: string; metricSchema: MetricSchema; sortOrder?: number }): Promise<Category> {
  return (await json<{ category: Category }>(await req("/workout/categories", "POST", c))).category;
}
export async function lastSet(categoryId: string): Promise<WorkoutSet | null> {
  return (await json<{ lastSet: WorkoutSet | null }>(await req(`/workout/categories/${categoryId}/last-set`))).lastSet;
}
export async function logSet(s: Partial<WorkoutSet> & { categoryId: string; sessionId: string }): Promise<WorkoutSet> {
  return (await json<{ set: WorkoutSet }>(await req("/workout/sets", "POST", s))).set;
}
export async function startSession(): Promise<{ sessionId: string }> {
  return (await json<{ session: { sessionId: string } }>(await req("/workout/sessions", "POST"))).session;
}
export interface ChartPoint { day: string; topWeightKg: number | null; totalVolumeKg: number | null; sets: number; }
export async function categoryChart(categoryId: string): Promise<{ points: ChartPoint[]; freshness: Freshness }> {
  return json(await req(`/workout/categories/${categoryId}/chart`));
}
export interface PR { categoryId: string; categoryName: string; topWeightKg: number | null; estimatedOneRepMaxKg: number | null; recordedAt: string; }
export async function personalRecords(): Promise<{ records: PR[]; freshness: Freshness }> {
  return json(await req("/workout/records"));
}
export async function leaderboard(): Promise<{ leaderboard: Array<{ userId: string; totalVolumeKg: number; sets: number }>; freshness: Freshness }> {
  return json(await req("/workout/leaderboard"));
}

// ---------------------------------------------------------------- stats

export interface Odometer { workouts: number; sets: number; volumeKg: number; journalEntries: number; }
export async function odometer(): Promise<Odometer> {
  return (await json<{ odometer: Odometer }>(await req("/stats/odometer"))).odometer;
}
export async function streak(): Promise<{ current: number; longest: number }> {
  return (await json<{ streak: { current: number; longest: number } }>(await req("/stats/streak"))).streak;
}

// ---------------------------------------------------------------- AI (SSE)

export interface ChatEvent { type: string; [k: string]: unknown; }

/** Stream the AI report. POST carries the prompt; frames are `event: t\ndata: json`. */
export async function streamReport(prompt: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  const res = await fetch("/api/ai/chat", { method: "POST", headers, credentials: "include", body: JSON.stringify({ prompt }) });
  if (!res.ok || !res.body) throw new ApiError(`AI failed: HTTP ${res.status}`, res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const ev = frame.match(/^event:\s*(\S+)/m);
      const da = frame.match(/^data:\s*(.+)$/m);
      if (ev && da) {
        try { onEvent({ ...(JSON.parse(da[1]!) as Record<string, unknown>), type: ev[1]! }); } catch { /* skip */ }
      }
    }
  }
}
