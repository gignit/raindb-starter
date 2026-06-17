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
import { listNotes, createNote, streamChat, getPodInfo, type Note, type ChatEvent, type PodInfo } from "./api";

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
      <PodCertification />
      <main className="columns">
        <NotesPanel />
        <ChatPanel />
      </main>
    </div>
  );
}

// ---- Pod certification banner ------------------------------------------
//
// Calls /api/pod-info and shows whether the runtime is the Node POD with all
// three SDKs working. On the pod with real creds: green "CERTIFIED". This is
// the at-a-glance proof the certification target is met.

function PodCertification() {
  const [info, setInfo] = useState<PodInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const probe = useCallback(async () => {
    try {
      setInfo(await getPodInfo());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const sdk = (name: string) => info?.sdks?.[name];
  const dot = (ok: boolean | undefined) => (ok ? "ok" : ok === false ? "bad" : "unknown");

  return (
    <section className={`pod-cert ${info?.certified ? "certified" : "pending"}`}>
      <div className="pod-cert-head">
        <strong>Lightning Pod runtime</strong>
        <span className="pod-cert-badge">
          {err ? "unreachable" : info ? (info.certified ? "CERTIFIED" : "not certified") : "checking..."}
        </span>
        <button className="pod-cert-refresh" onClick={() => void probe()}>refresh</button>
      </div>
      {err && <p className="error">pod-info error: {err}</p>}
      {info && (
        <ul className="pod-cert-grid">
          <li><span className={`d ${info.runtime.isPodLikely ? "ok" : "bad"}`} />Node {info.runtime.nodeVersion}</li>
          <li><span className={`d ${info.runtime.webAssembly === "object" ? "ok" : "bad"}`} />WebAssembly</li>
          <li><span className={`d ${dot(sdk("@raindb/bolt-sdk"))}`} />bolt-sdk</li>
          <li><span className={`d ${dot(sdk("@raindb/agent"))}`} />agent</li>
          <li><span className={`d ${dot(sdk("@raindb/prisma-adapter"))}`} />prisma-adapter</li>
          <li><span className={`d ${info.prisma.ok ? "ok" : "bad"}`} />Prisma round-trip{typeof info.prisma.count === "number" ? ` (${info.prisma.count} rows)` : ""}</li>
        </ul>
      )}
    </section>
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
  /** For assistant turns: the agent's activity trace (thinking + tool calls),
   *  shown in a collapsible section above the answer. */
  trace?: string[];
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
    // The live activity trace for THIS turn (thinking + tool calls), shown in
    // a collapsible section and preserved on the finished assistant message.
    const trace: string[] = [];
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

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "thinking") {
        trace.push(`thinking (step ${String(ev.iteration ?? "")})`.trim());
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-call") {
        trace.push(`tool call: ${String(ev.toolName)}`);
        patchLast({ trace: [...trace] });
      } else if (ev.type === "tool-result") {
        trace.push(`tool result: ${String(ev.toolName ?? "")}`.trim());
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
                        <li key={j}>{t}</li>
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
