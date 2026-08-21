// App.tsx -- the starter UI: a notes workspace, an AI assistant, and a SQL
// analytics view, in a tabbed shell.
//
// Three tabs, each a full-width view over one RainDB pattern:
//   Notes     -> index-plane CRUD (/api/notes): instant read-your-writes.
//   Assistant -> the @raindb/agent loop (/api/chat), streamed live over SSE.
//   Analytics -> Periscope SQL over the SAME droplets (/api/stats) with a
//                freshness badge (the eventually-consistent analytical plane).
//
// Replace this file with your app. api.ts + the SSE consumption in ChatPanel
// + the two-plane split (index vs SQL) are the parts worth keeping.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "github-markdown-css/github-markdown-dark.css";
import {
  listNotes, createNote, streamChat, getStats, type Note, type ChatEvent,
  type AuthorStat, type Freshness,
} from "./api";

// One markdown pipeline (GFM) for note bodies AND assistant replies.
function Md({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>;
}

// A stable-ish color + initial for an author avatar chip.
function avatar(name: string): { initial: string; hue: number } {
  const s = (name || "?").trim();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return { initial: (s[0] || "?").toUpperCase(), hue: h };
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

type Tab = "notes" | "assistant" | "analytics";

export default function App() {
  const [tab, setTab] = useState<Tab>("notes");
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <div>
            <div className="brand-name">RainDB Starter</div>
            <div className="brand-sub">notes as immutable droplets &middot; one data model, three surfaces</div>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === "notes" ? "tab on" : "tab"} onClick={() => setTab("notes")}>Notes</button>
          <button className={tab === "assistant" ? "tab on" : "tab"} onClick={() => setTab("assistant")}>Assistant</button>
          <button className={tab === "analytics" ? "tab on" : "tab"} onClick={() => setTab("analytics")}>Analytics</button>
        </nav>
      </header>
      <main className="view">
        {tab === "notes" && <NotesView />}
        {tab === "assistant" && <ChatView />}
        {tab === "analytics" && <AnalyticsView />}
      </main>
    </div>
  );
}

// ============================================================ Notes (index)

function NotesView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const reload = useCallback(async () => {
    try {
      setNotes(await listNotes());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.authorName.toLowerCase().includes(q) ||
        (n.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [notes, filter]);

  return (
    <div className="notes-view">
      <div className="view-head">
        <div>
          <h1>Notes</h1>
          <p className="sub">
            Each save is a new immutable droplet in <code>starter-notes</code>, read back
            instantly by its index. {notes.length} note{notes.length === 1 ? "" : "s"}.
          </p>
        </div>
        <button className="btn primary" onClick={() => setComposerOpen((v) => !v)}>
          {composerOpen ? "Close" : "New note"}
        </button>
      </div>

      {composerOpen && <Composer onCreated={() => { setComposerOpen(false); void reload(); }} />}

      <div className="toolbar">
        <input
          className="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by title, author, or tag..."
        />
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading ? (
        <div className="grid">{[0, 1, 2, 3].map((i) => <div key={i} className="card skeleton" />)}</div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <div className="empty-mark">◆</div>
          <p>{notes.length === 0 ? "No notes yet." : "No notes match that filter."}</p>
          {notes.length === 0 && <button className="btn primary" onClick={() => setComposerOpen(true)}>Create the first note</button>}
        </div>
      ) : (
        <div className="grid">
          {shown.map((n) => <NoteCard key={n.noteId} note={n} />)}
        </div>
      )}
    </div>
  );
}

// TagInput -- YouTube-style tag entry: type + press comma or Enter to commit a
// pill, each pill has an (x) to remove, Backspace on an empty input pops the
// last pill. Value is the string[] of tags (the shape createNote wants).
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    // Allow pasting/typing several comma-separated tags at once.
    const parts = raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...tags];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "," || e.key === "Enter") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="taginput" onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
      {tags.map((t) => (
        <span key={t} className="tag pill">
          #{t}
          <button type="button" className="tag-x" aria-label={`remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>x</button>
        </span>
      ))}
      <input
        className="tag-draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        placeholder={tags.length === 0 ? "add tags (comma or enter)" : ""}
      />
    </div>
  );
}

function Composer({ onCreated }: { onCreated: () => void }) {
  const [author, setAuthor] = useState(() => localStorage.getItem("author") || "me");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !author.trim()) return;
    setBusy(true);
    try {
      await createNote({ author: author.trim(), title: title.trim(), body, tags });
      localStorage.setItem("author", author.trim());
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="composer card" onSubmit={submit}>
      <div className="composer-row">
        <input className="composer-author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="author" />
        <input className="composer-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" autoFocus />
      </div>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write something... (markdown supported)" rows={4} />
      <div className="composer-foot">
        <TagInput tags={tags} onChange={setTags} />
        <button className="btn primary" disabled={busy || !title.trim()}>{busy ? "Saving..." : "Save note"}</button>
      </div>
      {error && <div className="banner error">{error}</div>}
    </form>
  );
}

function NoteCard({ note }: { note: Note }) {
  const { initial, hue } = avatar(note.authorName);
  const edited = !!note.updatedAt && note.updatedAt !== note.createdAt;
  return (
    <article className="card note">
      <header className="note-top">
        <span className="chip" style={{ background: `hsl(${hue} 45% 28%)`, color: `hsl(${hue} 80% 82%)` }}>{initial}</span>
        <div className="note-meta">
          <span className="note-author">{note.authorName}</span>
          <span className="note-time">{relTime(note.updatedAt || note.createdAt)}{edited ? " · edited" : ""}</span>
        </div>
      </header>
      <h3 className="note-title">{note.title}</h3>
      {note.body && <div className="markdown-body note-body"><Md>{note.body}</Md></div>}
      {(note.tags ?? []).length > 0 && (
        <div className="tags">
          {note.tags!.map((t) => <span key={t} className="tag">#{t}</span>)}
        </div>
      )}
    </article>
  );
}

// ======================================================== Assistant (agent)

interface ChatLine {
  kind: "user" | "assistant" | "error";
  text: string;
  trace?: TraceStep[];
}
interface TraceStep {
  kind: "thinking" | "tool-call" | "tool-result" | "tool-error";
  label: string;
  detail?: string;
  ok?: boolean;
  durationMs?: number;
}

function preview(v: unknown, max = 300): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = (s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "..." : s;
}

const SUGGESTIONS = ["summarize my notes", "who wrote the most notes?", "what is this app?"];

function ChatView() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const runTurn = async (message: string) => {
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const trace: TraceStep[] = [];
    setLines((ls) => [...ls, { kind: "user", text: message }, { kind: "assistant", text: "", trace }]);

    const patchLast = (patch: Partial<ChatLine>) =>
      setLines((ls) => {
        const next = ls.slice();
        const last = next[next.length - 1];
        if (last && last.kind === "assistant") next[next.length - 1] = { ...last, ...patch };
        return next;
      });

    // Each SSE frame is a full @raindb/agent AgentEvent -- rendered live, nothing
    // persisted server-side. NOTE: the loop emits a `thinking` event at the top
    // of EVERY iteration (before it knows if this turn will call a tool or just
    // answer), and it carries no reasoning content -- so a bare `thinking` is
    // just "iteration started", not real thought. We therefore only surface
    // ACTIONS (tool calls + results); a turn that only answers shows no trace.
    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "thinking") {
        // intentionally ignored -- see note above (no reasoning payload).
      } else if (ev.type === "tool-call") {
        const args = (ev.args ?? {}) as unknown;
        const hasArgs = args && typeof args === "object" && Object.keys(args as object).length > 0;
        trace.push({ kind: "tool-call", label: `Calling ${String(ev.toolName)}`, ...(hasArgs ? { detail: preview(args) } : {}) });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-result") {
        trace.push({
          kind: "tool-result",
          label: `${String(ev.toolName ?? "")} ${ev.ok === false ? "failed" : "returned"}`.trim(),
          ok: ev.ok !== false,
          ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
          ...(ev.preview !== undefined || ev.result !== undefined ? { detail: preview(ev.preview ?? ev.result) } : {}),
        });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-error") {
        trace.push({ kind: "tool-error", label: `${String(ev.toolName ?? "")} error`.trim(), ok: false, detail: String(ev.error ?? "") });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "final") {
        const content = String(ev.content ?? "");
        patchLast({ text: content, trace: [...trace] });
        historyRef.current.push({ role: "user", content: message });
        historyRef.current.push({ role: "assistant", content });
      } else if (ev.type === "error") {
        patchLast({ kind: "error", text: String(ev.error ?? "unknown error") } as Partial<ChatLine>);
      }
    };

    try {
      await streamChat(message, historyRef.current, onEvent);
    } catch (err) {
      setLines((ls) => [...ls, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat-view">
      <div className="view-head">
        <div>
          <h1>Assistant</h1>
          <p className="sub">
            An <code>@raindb/agent</code> loop that reads your notes through a tool. Its
            tool calls stream live over SSE as it works.
          </p>
        </div>
      </div>

      <div className="chat-log" ref={scrollRef}>
        {lines.length === 0 && (
          <div className="chat-empty">
            <div className="empty-mark">✦</div>
            <p>Ask the assistant about your notes -- watch it think and call tools live.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => void runTurn(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`bubble ${l.kind}`}>
            {l.kind === "assistant" ? (
              <>
                {l.trace && l.trace.length > 0 && (
                  <details className="thinking" open={l.text === ""}>
                    <summary>
                      {(() => {
                        const tools = l.trace!.filter((t) => t.kind === "tool-call").length;
                        const noun = `tool call${tools === 1 ? "" : "s"}`;
                        return l.text === "" ? `working -- ${tools} ${noun}...` : `${tools} ${noun}`;
                      })()}
                    </summary>
                    <ul className="thinking-steps">
                      {l.trace.map((t, j) => (
                        <li key={j} className={`trace-step ${t.kind}`}>
                          <span className="trace-label">
                            {t.ok === false ? "✕ " : ""}{t.label}
                            {typeof t.durationMs === "number" ? ` · ${t.durationMs}ms` : ""}
                          </span>
                          {t.detail && <code className="trace-detail">{t.detail}</code>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {l.text === "" && (!l.trace || l.trace.length === 0) ? (
                  <span className="typing"><i /><i /><i /></span>
                ) : (
                  <div className="markdown-body"><Md>{l.text}</Md></div>
                )}
              </>
            ) : (
              <span>{l.text}</span>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void runTurn(input.trim()); }} className="chat-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "the agent is working..." : "Ask about your notes..."}
          disabled={busy}
        />
        <button className="btn primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}

// ======================================================== Analytics (SQL)

function AnalyticsView() {
  const [stats, setStats] = useState<AuthorStat[]>([]);
  const [freshness, setFreshness] = useState<Freshness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getStats();
      setStats(r.stats);
      setFreshness(r.freshness);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const total = stats.reduce((a, s) => a + s.notes, 0);
  const max = stats.reduce((a, s) => Math.max(a, s.notes), 0) || 1;

  return (
    <div className="analytics-view">
      <div className="view-head">
        <div>
          <h1>Analytics</h1>
          <p className="sub">
            The same droplets, queried as an analytical SQL table -- no ETL, no separate
            warehouse.
          </p>
        </div>
        <div className="head-actions">
          {freshness && (
            <span className={`freshness ${freshness.behind ? "behind" : "current"}`}>
              <span className="dot" />
              {freshness.behind ? "updating -- pools every ~5 min" : "up to date"}
            </span>
          )}
          <button className="btn ghost" onClick={() => void reload()} disabled={loading}>
            {loading ? "..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="stat-num">{total}</div><div className="stat-label">notes total</div></div>
        <div className="stat-card"><div className="stat-num">{stats.length}</div><div className="stat-label">authors</div></div>
        <div className="stat-card"><div className="stat-num">{max}</div><div className="stat-label">most by one author</div></div>
      </div>

      <div className="card query-card">
        <code>SELECT authorName, COUNT(*) FROM entity."starter-notes" GROUP BY authorName</code>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading ? (
        <div className="card skeleton tall" />
      ) : stats.length === 0 ? (
        <div className="empty"><p>No rows yet -- add notes, then wait for the next pool (or they merge into row-list reads immediately).</p></div>
      ) : (
        <div className="card">
          <table className="stats-table">
            <thead><tr><th>Author</th><th>Notes</th><th className="col-bar"></th><th>Latest</th></tr></thead>
            <tbody>
              {stats.map((s) => {
                const { initial, hue } = avatar(s.authorName);
                return (
                  <tr key={s.authorName}>
                    <td>
                      <span className="chip sm" style={{ background: `hsl(${hue} 45% 28%)`, color: `hsl(${hue} 80% 82%)` }}>{initial}</span>
                      {s.authorName}
                    </td>
                    <td className="num">{s.notes}</td>
                    <td className="col-bar"><span className="bar" style={{ width: `${(s.notes / max) * 100}%` }} /></td>
                    <td className="dim">{s.latest ? relTime(s.latest) : "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
