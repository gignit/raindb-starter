// ai/chat.ts -- the gratifying AI report / coach, streamed over SSE.
//
// TWO-PLANE COMPOSITION (the teaching moment): the agent is given TWO
// deliberately-labeled read tools so it -- and the reader -- sees the split:
//   * session_fresh -> queryEntityRowsFresh: TODAY's just-logged sets, read
//     through the fresh index (read-your-writes). The workout the user JUST
//     finished IS here, even though the analytical snapshot may not have pooled
//     it yet. This is why the report always feels current.
//   * history_sql   -> analytical SQL over the WHOLE history (PRs via window
//     functions, per-day progress). A few-minutes lag is fine for a trend.
// The report objectively decides PRs/trends from history_sql, and celebrates the
// just-finished work from session_fresh -- never a fake "fresh aggregate".
//
// ENCRYPTION BOUNDARY: the agent runs SERVER-SIDE, so it can only ever see
// UNENCRYPTED content + plaintext tags/counts. Encrypted journal bodies are
// ciphertext it cannot read -- by design.
//
// Rate-limited per user via the redis+ windowed counter (protects a gym's LLM
// budget). Streamed via startSSE so the client sees the report build live.

import { makeBoltNativeHost, startSSE, sql, type BoltContext, type BoltRequest, type BoltResponse } from "@raindb/bolt-sdk";
import { runAgent, type RegisteredTool, type ToolContext, type AgentHost } from "@raindb/agent";
import { bad, readJsonBody } from "../lib/http.js";
import { requireUser, AuthError } from "../lib/auth.js";
import * as analytics from "../lib/analytics.js";
import { readStreak, checkAiRateLimit } from "../lib/stats.js";

const SETS = "ref-workout-sets";

// --- the two-plane tools (both read-only: minRole viewer, no modifiesResource) ---

function tools(userId: string): RegisteredTool[] {
  const uid = userId.replace(/'/g, "");
  return [
    {
      name: "session_fresh",
      description:
        "The user's sets logged TODAY, read fresh (read-your-writes). Use this to " +
        "celebrate the workout they just finished -- it is here even if history_sql " +
        "has not pooled it yet. Returns rows of {categoryName, weightKg, reps, recordedAt}.",
      minRole: "read",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        const r = await sql.queryEntityRowsFresh({
          sql:
            `SELECT setId, categoryName, weightKg, reps, isBenchmark, recordedAt ` +
            `FROM entity."${SETS}" WHERE userId = '${uid}' AND recordedAt >= '${since.toISOString()}' ` +
            `ORDER BY recordedAt DESC`,
          formationId: SETS,
          scopeKey: "setId",
        });
        return { todaysSets: r.rows };
      },
    },
    {
      name: "history_sql",
      description:
        "Analytical facts over the user's WHOLE history (a few-minutes lag is fine): " +
        "their personal records (best estimated 1-rep-max per exercise, via a window " +
        "function). Use this to objectively state PRs and long-term progress.",
      minRole: "read",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        const { records, freshness } = await analytics.personalRecords(userId);
        return { personalRecords: records, freshness };
      },
    },
    {
      name: "streak_context",
      description:
        "The user's current and longest daily-activity streak (from a real-time " +
        "counter). Use it to motivate -- e.g. 'that keeps your 12-day streak alive'.",
      minRole: "read",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        return await readStreak(userId);
      },
    },
  ];
}

const SYSTEM_PROMPT =
  "You are FitLedger's encouraging strength coach. Give a SHORT, genuinely " +
  "gratifying progress report after a workout. Use session_fresh to see what " +
  "they just did, history_sql to state any personal records objectively, and " +
  "streak_context to motivate. Be specific with numbers. Two or three sentences. " +
  "Never invent data -- only report what the tools return.";

// handleChat receives the bolt ctx (threaded from onHttpRequest) because the
// agent host + SSE stream are built from it -- a route that needs the ctx takes
// it explicitly rather than reaching for an ambient global.
export async function handleChat(ctx: BoltContext, req: BoltRequest): Promise<BoltResponse> {
  const b = readJsonBody(req);
  if (!b) return bad("invalid JSON");
  let session;
  try {
    session = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthError) return bad(e.message, e.status);
    throw e;
  }

  // Rate limit (the redis+ windowed counter) -- protect the LLM budget.
  const rl = await checkAiRateLimit(session.userId);
  if (!rl.allowed) return bad("AI rate limit reached; try again later", 429);

  const prompt = String(b.prompt ?? "Give me a progress report on my latest workout.");
  const sse = await startSSE(ctx);

  const toolCtx: ToolContext = {
    // Native bindings use the bolt host's transport; creds are unused for them.
    creds: { endpoint: "", apiKey: "" },
    // The two @raindb packages ship structurally-identical AgentHost types from
    // separate declaration files; cast across the package boundary.
    host: makeBoltNativeHost(ctx) as unknown as AgentHost,
    role: "read",
    userId: session.userId,
  };

  try {
    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: prompt,
      ctx: toolCtx,
      tools: tools(session.userId),
      maxIterations: 5,
      onEvent: (e) => {
        if (e.type === "tool-call") sse.send("tool", { tool: e.toolName });
        if (e.type === "thinking") sse.send("thinking", { iteration: e.iteration });
      },
    });
    sse.send("report", { content: result.content, remaining: rl.remaining });
    return sse.finalize();
  } catch (e) {
    sse.send("error", { message: e instanceof Error ? e.message : "AI failed" });
    return sse.finalize();
  }
}
