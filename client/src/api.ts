// api.ts -- the client's entire API surface. Plain fetch against the bolt.
//
// In dev, Vite proxies /api/* to your live deployed bolt (vite.config.ts).
// In production, the bolt serves these same paths next to the static SPA.
// Same origin either way -- no CORS, no env switching in app code.

export interface Note {
  noteId: string;
  /** Payload field is authorName ("author" is a platform-reserved template variable). */
  authorName: string;
  title: string;
  body: string;
  tags?: string[];
  createdAt: string;
  updatedAt?: string | null;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function listNotes(author?: string): Promise<Note[]> {
  const qs = author ? `?author=${encodeURIComponent(author)}` : "";
  const data = await json<{ notes: Note[] }>(await fetch(`/api/notes${qs}`));
  return data.notes;
}

export async function createNote(fields: {
  author: string;
  title: string;
  body: string;
  tags?: string[];
}): Promise<Note> {
  const data = await json<{ note: Note }>(
    await fetch("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    }),
  );
  return data.note;
}

// ---- Prisma surface (SDK #3) -------------------------------------------
//
// The SAME notes, read/written through a standard PrismaClient on RainDB.
// These hit /api/prisma/* (which only run on the Node pod, where Prisma's
// WASM query compiler can execute). Proof that an unmodified ORM works.

export interface PrismaNote {
  noteId: string;
  authorName: string | null;
  title: string | null;
  body: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export async function prismaListNotes(
  author?: string,
): Promise<{ notes: PrismaNote[]; total: number; via: string }> {
  const qs = author ? `?author=${encodeURIComponent(author)}` : "";
  return json(await fetch(`/api/prisma/notes${qs}`));
}

export async function prismaCreateNote(fields: {
  author: string;
  title: string;
  body: string;
}): Promise<{ note: PrismaNote; via: string }> {
  return json(
    await fetch("/api/prisma/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields),
    }),
  );
}

// ---- Pod certification probe -------------------------------------------

export interface PodInfo {
  service: string;
  certified: boolean;
  summary: string;
  runtime: {
    nodeVersion: string;
    v8: string | null;
    webAssembly: string;
    fetch: string;
    isPodLikely: boolean;
  };
  sdks: Record<string, boolean>;
  prisma: { ok: boolean; detail: string; count?: number; sampleNoteId?: string | null };
  ts: string;
}

export async function getPodInfo(): Promise<PodInfo> {
  return json(await fetch("/api/pod-info"));
}

// ---- SSE chat ----------------------------------------------------------
//
// POST /api/chat streams the agent loop's progress as SSE frames. We use
// fetch + getReader (not EventSource -- it only supports GET, and chat is a
// POST carrying the prompt). Each frame is `event: <type>\ndata: <json>\n\n`.

export interface ChatEvent {
  type: string;
  [k: string]: unknown;
}

export async function streamChat(
  message: string,
  history: { role: string; content: string }[],
  onEvent: (e: ChatEvent) => void,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat failed: HTTP ${res.status}`);
  }
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
      const eventMatch = frame.match(/^event:\s*(\S+)/m);
      const dataMatch = frame.match(/^data:\s*(.+)$/m);
      if (eventMatch && dataMatch) {
        try {
          const payload = JSON.parse(dataMatch[1]!) as Record<string, unknown>;
          onEvent({ ...payload, type: eventMatch[1]! });
        } catch {
          // skip malformed frame
        }
      }
    }
  }
}
