// App.tsx -- the starter UI: a notes board + an AI assistant panel.
//
// Deliberately small. Two columns:
//   left:  create + list notes (the CRUD surface -> /api/notes)
//   right: chat with the assistant (SSE stream -> /api/chat); it can read
//          the notes via its list_notes tool, so ask it about them.
//
// Replace this whole file when you build your app. The api.ts module and
// the SSE consumption pattern in ChatPanel are the parts worth keeping.

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "github-markdown-css/github-markdown-dark.css";

// Shared renderer: GitHub-flavored markdown (tables, strikethrough, task
// lists, autolinks) styled by github-markdown-css. Used for note bodies AND
// assistant replies -- one markdown pipeline for the whole app.
function Md({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>;
}
import { listNotes, createNote, streamChat, type Note, type ChatEvent } from "./api";

export default function App() {
  return (
    <div className="shell">
      <header className="header">
        <h1>RainDB Starter</h1>
        <p>
          Notes live as immutable droplets in the <code>starter-notes</code> formation.
          The assistant reads them through an agent tool. No database server, no ORM,
          no migrations -- the substrate is the backend.
        </p>
      </header>
      <main className="columns">
        <NotesPanel />
        <ChatPanel />
      </main>
    </div>
  );
}

// ---- Notes -------------------------------------------------------------

function NotesPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [author, setAuthor] = useState("me");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setNotes(await listNotes());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !author.trim()) return;
    setBusy(true);
    try {
      await createNote({ author: author.trim(), title: title.trim(), body });
      setTitle("");
      setBody("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Notes</h2>
      <form onSubmit={submit} className="note-form">
        <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="author" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="title" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="write something..." rows={3} />
        <button disabled={busy || !title.trim()}>{busy ? "saving..." : "add note"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="notes">
        {notes.map((n) => (
          <li key={n.noteId} className="note">
            <div className="note-head">
              <strong>{n.title}</strong>
              <span className="meta">{n.authorName}</span>
            </div>
            {n.body && (
              <div className="markdown-body note-body">
                <Md>{n.body}</Md>
              </div>
            )}
            <span className="meta">{new Date(n.createdAt).toLocaleString()}</span>
          </li>
        ))}
        {notes.length === 0 && !error && <li className="meta">no notes yet -- add one</li>}
      </ul>
    </section>
  );
}

// ---- Chat --------------------------------------------------------------

interface ChatLine {
  kind: "user" | "assistant" | "error";
  text: string;
  /** For assistant turns: the agent's activity trace, built LIVE from the SSE
   *  AgentEvent stream (nothing is persisted server-side -- the thinking is
   *  shown straight from the frames as they arrive). Each step keeps the full
   *  event detail so the UI can show what the agent actually did. */
  trace?: TraceStep[];
}

// One rendered line of the live agent trace. Mirrors the @raindb/agent
// AgentEvent shapes (thinking / tool-call / tool-result / tool-error) -- we
// keep the tool name, args, result preview, timing, and ok flag so the trace
// shows the real reasoning, not a terse label.
interface TraceStep {
  kind: "thinking" | "tool-call" | "tool-result" | "tool-error";
  label: string;
  detail?: string; // args (call) or result preview (result) or error text
  ok?: boolean;
  durationMs?: number;
}

/** Compact one-line JSON preview for tool args / results. */
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

function ChatPanel() {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<{ role: string; content: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [lines]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    // The live activity trace for THIS turn, built straight from the streamed
    // AgentEvents. Nothing is recorded server-side -- these frames arrive over
    // SSE and we render them as they come.
    const trace: TraceStep[] = [];
    setLines((ls) => [
      ...ls,
      { kind: "user", text: message },
      { kind: "assistant", text: "", trace }, // placeholder, fills as events stream
    ]);

    // Update the in-flight assistant line (always the last line) in place.
    const patchLast = (patch: Partial<ChatLine>) =>
      setLines((ls) => {
        const next = ls.slice();
        const last = next[next.length - 1];
        if (last && last.kind === "assistant") next[next.length - 1] = { ...last, ...patch };
        return next;
      });

    // Each SSE frame is a full @raindb/agent AgentEvent -- keep its detail
    // (tool name + args + result preview + timing) so the trace shows what the
    // agent actually did, not just that "a tool was called".
    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "thinking") {
        trace.push({ kind: "thinking", label: `Thinking (step ${String(ev.iteration ?? "")})`.trim() });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-call") {
        const args = (ev.args ?? {}) as unknown;
        const hasArgs = args && typeof args === "object" && Object.keys(args as object).length > 0;
        trace.push({
          kind: "tool-call",
          label: `Calling tool: ${String(ev.toolName)}`,
          ...(hasArgs ? { detail: preview(args) } : {}),
        });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-result") {
        trace.push({
          kind: "tool-result",
          label: `Tool ${String(ev.toolName ?? "")} ${ev.ok === false ? "failed" : "returned"}`.trim(),
          ok: ev.ok !== false,
          ...(typeof ev.durationMs === "number" ? { durationMs: ev.durationMs } : {}),
          ...(ev.preview !== undefined || ev.result !== undefined
            ? { detail: preview(ev.preview ?? ev.result) }
            : {}),
        });
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-error") {
        trace.push({
          kind: "tool-error",
          label: `Tool ${String(ev.toolName ?? "")} error`.trim(),
          ok: false,
          detail: String(ev.error ?? ""),
        });
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
    <section className="panel">
      <h2>Assistant</h2>
      <div className="chat-log" ref={scrollRef}>
        {lines.length === 0 && (
          <p className="meta">
            Try: &quot;summarize my notes&quot; or &quot;what is this app?&quot; -- events stream
            live as the agent thinks and calls tools.
          </p>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`chat-line ${l.kind}${l.kind === "assistant" ? " markdown-body" : ""}`}>
            {l.kind === "assistant" ? (
              <>
                {l.trace && l.trace.length > 0 && (
                  <details className="thinking" open={l.text === ""}>
                    <summary>
                      {l.text === ""
                        ? `thinking${".".repeat((l.trace.length % 3) + 1)}`
                        : `thought process (${l.trace.length} step${l.trace.length === 1 ? "" : "s"})`}
                    </summary>
                    <ul className="thinking-steps">
                      {l.trace.map((t, j) => (
                        <li key={j} className={`trace-step ${t.kind}`}>
                          <span className="trace-label">
                            {t.ok === false ? "x " : ""}
                            {t.label}
                            {typeof t.durationMs === "number" ? ` (${t.durationMs}ms)` : ""}
                          </span>
                          {t.detail && <code className="trace-detail">{t.detail}</code>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {l.text === "" && (!l.trace || l.trace.length === 0) ? (
                  <span className="meta">thinking...</span>
                ) : (
                  <Md>{l.text}</Md>
                )}
              </>
            ) : (
              l.text
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="chat-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "waiting for the agent..." : "ask about your notes..."}
          disabled={busy}
        />
        <button disabled={busy || !input.trim()}>send</button>
      </form>
    </section>
  );
}
