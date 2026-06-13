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
            {n.body && <p>{n.body}</p>}
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
  kind: "user" | "assistant" | "activity" | "error";
  text: string;
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
    setLines((ls) => [...ls, { kind: "user", text: message }]);

    const onEvent = (ev: ChatEvent) => {
      if (ev.type === "thinking") {
        setLines((ls) => [...ls, { kind: "activity", text: "thinking..." }]);
      } else if (ev.type === "tool-call") {
        setLines((ls) => [...ls, { kind: "activity", text: `tool: ${String(ev.toolName)}` }]);
      } else if (ev.type === "final") {
        const content = String(ev.content ?? "");
        setLines((ls) => [...ls.filter((l) => l.kind !== "activity"), { kind: "assistant", text: content }]);
        historyRef.current.push({ role: "user", content: message });
        historyRef.current.push({ role: "assistant", content });
      } else if (ev.type === "error") {
        setLines((ls) => [...ls, { kind: "error", text: String(ev.error ?? "unknown error") }]);
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
          <div key={i} className={`chat-line ${l.kind}`}>
            {l.text}
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
