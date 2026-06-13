// ai/chat.ts -- an AI assistant grounded in YOUR app's data, streamed
// over SSE. This is the "AI is a first-class citizen" demonstration.
//
// What happens on POST /api/chat:
//   1. The route is declared `streaming: true` in config/routes.json, so
//      the runtime wires ctx.response and every response.write() hits the
//      browser as a separate SSE frame -- live progress, not one blob.
//   2. runAgent (from @raindb/agent) drives a real LLM through RainDB's
//      own OpenAI-compatible /v1 surface. The bolt holds a RainDB API key
//      (staged as a secret by scripts/setup.sh) -- NO third-party AI
//      account, no OpenAI key.
//   3. The agent gets ONE custom tool, list_notes, which reads the app's
//      own formation through the same persistence layer the routes use.
//      Ask it "summarize my notes" and watch the tool-call frames arrive.
//
// To extend: add tools (each is ~20 lines -- name, description, JSON-schema
// params, an execute function). The model only sees tools you pass, and the
// substrate still capability-gates every actual data call. See
// github.com/gignit/raindb-agent-ts README for the full tool catalog +
// authoring rules.

import { response, type BoltContext, type BoltRequest, type BoltResponse } from "@raindb/bolt-sdk";
import { makeBoltNativeHost } from "@raindb/bolt-sdk/agent-bridge";
import { runAgent, type AgentEvent, type RegisteredTool } from "@raindb/agent";
import { readJsonBody } from "../lib/http.js";
import { listAllNoteIds, readNotes } from "../lib/persistence.js";

// Pin the model EXPLICITLY (the pattern every reference app follows --
// e.g. joshua-vs-wopr pins fdn-internal/nova-micro). Omitting `model` makes
// the agent loop resolve the tenant's default chat model, which can fail on
// a fresh tenant before its model registry is seeded. Pinning skips
// resolution entirely.
//
// Amazon Nova (via Bedrock, inference stays in your AWS account) is the
// platform's intended default: cheap, fast, supports chat +
// function-calling -- exactly what an app assistant needs. List the full
// catalog with GET {LLM_API_BASE}/models and only reach for a bigger model
// when Nova's reasoning is genuinely the bottleneck.
export const CHAT_MODEL = "fdn-internal/nova-lite";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// A custom tool: let the model read the app's notes. Tools that touch
// user-private data must anchor on server-resolved identity, never on a
// model-supplied arg (the model will pass whatever the user asks it to).
const list_notes: RegisteredTool = {
  name: "list_notes",
  description:
    "List every note in this app (title, author, tags, body). Returns JSON. Use this before answering any question about the user's notes.",
  minRole: "read",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    const ids = await listAllNoteIds();
    const notes = await readNotes(ids.sort().reverse().slice(0, 50));
    return { count: notes.length, notes };
  },
};

const SYSTEM_PROMPT = `You are the built-in assistant of a RainDB starter app.
The app stores notes (title, author, body, tags). Use the list_notes tool to
ground every answer about the user's data. Be concise. If the user asks what
this app is, explain it is the RainDB starter template: an immutable,
S3-native data platform where their notes live as droplets in a formation.
Reply in GitHub-flavored markdown (the client renders it). Emit tables and
lists as plain markdown -- never wrap them in code fences.`;

/**
 * POST /api/chat {message, history?} -- run one agent turn, streaming each
 * AgentEvent (thinking / tool-call / tool-result / final) as an SSE frame.
 */
export async function handleChat(ctx: BoltContext, req: BoltRequest): Promise<BoltResponse> {
  const body = readJsonBody(req);
  const message = typeof body?.message === "string" ? body.message : "";
  if (!message) {
    return { status: 400, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "message required" }) };
  }
  const history = Array.isArray(body?.history) ? body.history : [];

  // ctx.response is only wired when routes.json declared streaming: true.
  const streaming = ctx.response !== undefined;
  if (streaming) {
    await response.setHeader("content-type", "text/event-stream");
    await response.setHeader("cache-control", "no-cache, no-transform");
    await response.setHeader("connection", "keep-alive");
    await response.setHeader("x-accel-buffering", "no");
    await response.beginStream(200);
  }
  const frames: string[] = [];
  const emit = (event: string, data: unknown): void => {
    const wire = sseFrame(event, data);
    if (streaming) void response.write(wire);
    else frames.push(wire);
  };

  try {
    const result = await runAgent({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: message,
      history: history as never,
      ctx: {
        // The agent's chatCompletion POSTs {LLM_API_BASE}/chat/completions --
        // RainDB's OpenAI-compatible surface. Both secrets are staged by
        // scripts/setup.sh from your profile. Data IO does NOT use a key;
        // it rides the capability-gated db.* bindings.
        creds: {
          apiKey: await ctx.secrets.get("LLM_API_KEY"),
          endpoint: await ctx.secrets.get("LLM_API_BASE"),
        },
        // bolt-sdk's AgentHost and @raindb/agent's AgentHost are structurally
        // identical but nominally distinct types; cast at this one boundary.
        host: makeBoltNativeHost(ctx) as unknown as Parameters<typeof runAgent>[0]["ctx"]["host"],
        role: "read",
        userId: "starter-user",
      },
      tools: [list_notes],
      model: CHAT_MODEL,
      maxIterations: 6,
      onEvent: (e: AgentEvent) => emit(e.type, e),
    });
    emit("done", { iterations: result.iterations, durationMs: result.durationMs });
  } catch (err) {
    emit("error", { error: err instanceof Error ? err.message : String(err) });
  }

  if (streaming) return { status: 200, headers: {}, body: "" };
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
    body: frames.join(""),
  };
}
