// App.tsx -- Fit: a mobile-first workout + journal SaaS on RainDB.
//
// Structure: an auth gate wraps a tabbed shell (Workout / Journal / Progress).
// Every screen is a thin view over src/api.ts. The app code is about the USE
// CASE -- the RainDB constructs (two-plane reads, versioning, tokens, SSE) live
// in the bolt server + the SDK, not here.

import { useEffect, useState, useCallback } from "react";
import * as api from "./api.js";
import { encrypt, decrypt } from "./crypto.js";

type Tab = "workout" | "journal" | "progress";

export default function App() {
  const [user, setUser] = useState<api.User | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("workout");

  useEffect(() => {
    api.loadToken();
    api.me().then((u) => { setUser(u); setLoading(false); });
  }, []);

  if (loading) return <div className="center muted">Loading Fit...</div>;
  if (!user) return <AuthGate onAuthed={setUser} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Fit</div>
        <button className="link" onClick={() => api.logout().then(() => setUser(null))}>Sign out</button>
      </header>
      <Odometer />
      <main className="content">
        {tab === "workout" && <WorkoutTab />}
        {tab === "journal" && <JournalTab />}
        {tab === "progress" && <ProgressTab />}
      </main>
      <nav className="tabbar">
        <button className={tab === "workout" ? "tab active" : "tab"} onClick={() => setTab("workout")}>Workout</button>
        <button className={tab === "journal" ? "tab active" : "tab"} onClick={() => setTab("journal")}>Journal</button>
        <button className={tab === "progress" ? "tab active" : "tab"} onClick={() => setTab("progress")}>Progress</button>
      </nav>
    </div>
  );
}

// --------------------------------------------------------------- auth gate

function AuthGate({ onAuthed }: { onAuthed: (u: api.User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const u = mode === "login" ? await api.login(email, password) : await api.register(email, password, name);
      onAuthed(u);
    } catch (e) { setErr(e instanceof Error ? e.message : "failed"); } finally { setBusy(false); }
  }

  return (
    <div className="authpage">
      <div className="brand big">Fit</div>
      <p className="muted">Track workouts + a private journal. Powered by RainDB.</p>
      <form className="card" onSubmit={submit}>
        <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
        {err && <div className="error">{err}</div>}
        {mode === "register" && (
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}

// --------------------------------------------------------------- odometer

function Odometer() {
  const [o, setO] = useState<api.Odometer | null>(null);
  useEffect(() => { api.odometer().then(setO).catch(() => {}); }, []);
  if (!o) return null;
  return (
    <div className="odometer" title="Live community totals -- real-time counters, no Redis">
      <span><b>{o.workouts}</b> workouts</span>
      <span><b>{o.sets}</b> sets</span>
      <span><b>{Math.round(o.volumeKg).toLocaleString()}</b> kg lifted</span>
      <span><b>{o.journalEntries}</b> entries</span>
    </div>
  );
}

// --------------------------------------------------------------- workout tab

function WorkoutTab() {
  const [cats, setCats] = useState<api.Category[]>([]);
  const [active, setActive] = useState<api.Category | null>(null);
  const [sessionId, setSessionId] = useState<string>("");
  const [err, setErr] = useState("");

  const load = useCallback(() => { api.listCategories("root").then(setCats).catch((e) => setErr(String(e.message))); }, []);
  useEffect(() => { load(); api.startSession().then((s) => setSessionId(s.sessionId)).catch(() => {}); }, [load]);

  if (active) return <LogSet category={active} sessionId={sessionId} onBack={() => setActive(null)} />;

  return (
    <div>
      <h2>Exercises</h2>
      {err && <div className="error">{err}</div>}
      <div className="grid">
        {cats.map((c) => (
          <button key={c.categoryId} className="bigcard" onClick={() => setActive(c)}>{c.name}</button>
        ))}
        <SeedCategoriesButton onSeeded={load} hidden={cats.length > 0} />
      </div>
    </div>
  );
}

function SeedCategoriesButton({ onSeeded, hidden }: { onSeeded: () => void; hidden: boolean }) {
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  const seeds: Array<{ name: string; schema: api.MetricSchema }> = [
    { name: "Bench Press", schema: { fields: [{ key: "weightKg", label: "Weight", kind: "weight", unit: "kg" }, { key: "reps", label: "Reps", kind: "reps" }], benchmarkable: true } },
    { name: "Squat", schema: { fields: [{ key: "weightKg", label: "Weight", kind: "weight", unit: "kg" }, { key: "reps", label: "Reps", kind: "reps" }], benchmarkable: true } },
    { name: "Deadlift", schema: { fields: [{ key: "weightKg", label: "Weight", kind: "weight", unit: "kg" }, { key: "reps", label: "Reps", kind: "reps" }], benchmarkable: true } },
    { name: "Run", schema: { fields: [{ key: "distanceM", label: "Distance", kind: "distance", unit: "m" }, { key: "durationS", label: "Time", kind: "duration", unit: "s" }] } },
  ];
  async function seed() {
    setBusy(true);
    try { for (const s of seeds) await api.createCategory({ name: s.name, metricSchema: s.schema }); onSeeded(); }
    finally { setBusy(false); }
  }
  return <button className="bigcard dashed" onClick={seed} disabled={busy}>{busy ? "Adding..." : "+ Add starter exercises"}</button>;
}

function LogSet({ category, sessionId, onBack }: { category: api.Category; sessionId: string; onBack: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [last, setLast] = useState<api.WorkoutSet | null>(null);
  const [saved, setSaved] = useState(0);
  const [benchmark, setBenchmark] = useState(false);

  useEffect(() => {
    api.lastSet(category.categoryId).then((s) => {
      setLast(s);
      if (s) {
        // Pre-fill last time's values (AXIS 1: instant, fresh index read).
        const pre: Record<string, string> = {};
        for (const f of category.metricSchema.fields) {
          const v = (s as unknown as Record<string, unknown>)[f.key];
          if (v != null) pre[f.key] = String(v);
        }
        setVals(pre);
      }
    }).catch(() => {});
  }, [category]);

  async function save() {
    const payload: Record<string, unknown> = { categoryId: category.categoryId, sessionId, isBenchmark: benchmark };
    for (const f of category.metricSchema.fields) if (vals[f.key]) payload[f.key] = Number(vals[f.key]);
    await api.logSet(payload as Parameters<typeof api.logSet>[0]);
    setSaved((n) => n + 1);
  }

  return (
    <div>
      <button className="link" onClick={onBack}>&larr; Back</button>
      <h2>{category.name}</h2>
      {last && <div className="muted">Last time: {category.metricSchema.fields.map((f) => `${f.label} ${(last as unknown as Record<string, unknown>)[f.key] ?? "-"}`).join(", ")}</div>}
      <div className="logform">
        {category.metricSchema.fields.map((f) => (
          <label key={f.key} className="field">
            <span>{f.label}{f.unit ? ` (${f.unit})` : ""}</span>
            <input type="number" inputMode="decimal" value={vals[f.key] ?? ""} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
          </label>
        ))}
        {category.metricSchema.benchmarkable && (
          <label className="checkline"><input type="checkbox" checked={benchmark} onChange={(e) => setBenchmark(e.target.checked)} /> Benchmark this set (track as a PR attempt)</label>
        )}
        <button className="btn primary big" onClick={save}>Save set</button>
        {saved > 0 && <div className="ok">Saved {saved} set{saved > 1 ? "s" : ""} this session</div>}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- journal tab

function JournalTab() {
  const [entries, setEntries] = useState<api.Entry[]>([]);
  const [editing, setEditing] = useState<api.Entry | "new" | null>(null);
  const load = useCallback(() => { api.listEntries().then(setEntries).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  if (editing) return <EntryEditor entry={editing === "new" ? null : editing} onDone={() => { setEditing(null); load(); }} />;

  return (
    <div>
      <div className="rowbetween"><h2>Journal</h2><button className="btn" onClick={() => setEditing("new")}>+ New</button></div>
      <ul className="list">
        {entries.map((e) => (
          <li key={e.entryId} className="listitem" onClick={() => setEditing(e)}>
            <div className="title">{e.encrypted ? "\uD83D\uDD12 " : ""}{e.title}</div>
            <div className="tags">{(e.tags ?? []).map((t) => <span key={t} className="tag">#{t}</span>)}</div>
          </li>
        ))}
        {entries.length === 0 && <p className="muted">No entries yet. Tap + New.</p>}
      </ul>
    </div>
  );
}

function EntryEditor({ entry, onDone }: { entry: api.Entry | null; onDone: () => void }) {
  const [title, setTitle] = useState(entry?.title ?? "");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string>((entry?.tags ?? []).join(" "));
  const [encrypted, setEncrypted] = useState(Boolean(entry?.encrypted));
  const [passphrase, setPassphrase] = useState("");
  const [err, setErr] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [locked, setLocked] = useState(Boolean(entry?.encrypted));

  useEffect(() => {
    if (entry && !entry.encrypted) setBody(entry.body);
  }, [entry]);

  async function unlock() {
    if (!entry?.encrypted) return;
    try { setBody(await decrypt(entry.body, passphrase)); setLocked(false); setErr(""); }
    catch { setErr("Wrong passphrase -- cannot unlock this entry."); }
  }

  async function save() {
    setErr("");
    const tagList = tags.split(/\s+/).map((t) => t.replace(/^#/, "").trim().toLowerCase()).filter(Boolean);
    try {
      if (encrypted) {
        if (!passphrase) { setErr("Set a passphrase to encrypt."); return; }
        const ciphertext = await encrypt(body, passphrase);
        if (entry) await api.editEntry(entry.entryId, { title, ciphertext, encrypted: true, tags: tagList });
        else await api.createEntry({ title, ciphertext, encrypted: true, tags: tagList });
      } else {
        if (entry) await api.editEntry(entry.entryId, { title, body, encrypted: false, tags: tagList });
        else await api.createEntry({ title, body, encrypted: false, tags: tagList });
      }
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "save failed"); }
  }

  return (
    <div>
      <button className="link" onClick={onDone}>&larr; Back</button>
      <input className="titleinput" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      {locked ? (
        <div className="card">
          <p className="muted">This entry is encrypted. Enter your passphrase to read it.</p>
          <input type="password" placeholder="Passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          <button className="btn" onClick={unlock}>Unlock</button>
        </div>
      ) : (
        <textarea className="bodyinput" placeholder="Write..." value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
      )}
      <input placeholder="tags (space-separated, e.g. gratitude mood)" value={tags} onChange={(e) => setTags(e.target.value)} />
      <label className="checkline">
        <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
        Off-the-grid encryption
        <button type="button" className="infobtn" onClick={() => setShowInfo(!showInfo)}>i</button>
      </label>
      {showInfo && (
        <div className="infobox">
          Encrypted on your device before it ever leaves. We store only scrambled text and can never read it.
          <b> If you lose your passphrase, this entry is gone forever</b> -- there is no recovery, by design.
          Tags stay readable so the AI can still find entries by tag; add tags to encrypted entries.
        </div>
      )}
      {encrypted && <input type="password" placeholder="Passphrase (remember it!)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
      {err && <div className="error">{err}</div>}
      <button className="btn primary big" onClick={save}>Save entry</button>
      {entry && <EntryHistory entryId={entry.entryId} />}
    </div>
  );
}

function EntryHistory({ entryId }: { entryId: string }) {
  const [revs, setRevs] = useState<api.Revision[] | null>(null);
  return (
    <div className="history">
      <button className="link" onClick={() => api.entryHistory(entryId).then(setRevs)}>Show version history</button>
      {revs && (
        <ul className="list small">
          {revs.map((r) => (
            <li key={r.dropletId} className="listitem">
              <span>{new Date(r.ts).toLocaleString()}</span>
              <button className="link" onClick={() => api.restoreEntry(entryId, r.dropletId).then(() => alert("Restored as a new revision"))}>Restore</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --------------------------------------------------------------- progress tab

function ProgressTab() {
  const [prs, setPrs] = useState<api.PR[]>([]);
  const [fresh, setFresh] = useState<api.Freshness | null>(null);
  const [streak, setStreak] = useState<{ current: number; longest: number } | null>(null);
  const [report, setReport] = useState<string>("");
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    api.personalRecords().then((r) => { setPrs(r.records); setFresh(r.freshness); }).catch(() => {});
    api.streak().then(setStreak).catch(() => {});
  }, []);

  async function runReport() {
    setReport(""); setReporting(true);
    try {
      await api.streamReport("Give me a gratifying progress report on my latest workout.", (e) => {
        if (e.type === "report") setReport(String((e as { content?: string }).content ?? ""));
      });
    } catch (e) { setReport(`(${e instanceof Error ? e.message : "AI unavailable"})`); }
    finally { setReporting(false); }
  }

  return (
    <div>
      {streak && <div className="streak">{streak.current}-day streak <span className="muted">(best {streak.longest})</span></div>}
      <div className="rowbetween"><h2>Personal records</h2>{fresh?.behind && <span className="badge">updating...</span>}</div>
      <ul className="list">
        {prs.map((p) => (
          <li key={p.categoryId} className="listitem">
            <span className="title">{p.categoryName}</span>
            <span>{p.topWeightKg ?? "-"} kg <span className="muted">(~{p.estimatedOneRepMaxKg ?? "-"} 1RM)</span></span>
          </li>
        ))}
        {prs.length === 0 && <p className="muted">Log some benchmark sets to see PRs.</p>}
      </ul>
      <h2>AI coach</h2>
      <button className="btn primary" onClick={runReport} disabled={reporting}>{reporting ? "Thinking..." : "Get my progress report"}</button>
      {report && <div className="report">{report}</div>}
    </div>
  );
}
