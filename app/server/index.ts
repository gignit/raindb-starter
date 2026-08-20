// app/server/index.ts -- YOUR app starts here (green skeleton).
//
// This is the smallest possible working bolt: one formation (app-item), a
// health check, and CRUD over items. It is deliberately tiny so you can grow
// it. Read reference/ledger/server for the full worked example (auth, workout,
// journal, encryption, AI) and copy the patterns you need.
//
// onHttpRequest is the single entry the RainDB Lightning runtime invokes for
// every request. setCtx(ctx) FIRST so db.*/ids.*/log.* resolve.

import { setCtx, db, ids, type BoltContext, type BoltRequest, type BoltResponse } from "@raindb/bolt-sdk";

const ITEMS = "app-item";

function ok(body: unknown): BoltResponse {
  return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function bad(msg: string, code = 400): BoltResponse {
  return { status: code, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
}

export async function onHttpRequest(ctx: BoltContext, req: BoltRequest): Promise<BoltResponse> {
  setCtx(ctx);
  const { method, path } = req;

  try {
    if (path === "/api/health" && method === "GET") return ok({ status: "ok", app: "my-app" });

    // List items (newest-first via the by-update index).
    if (path === "/api/items" && method === "GET") {
      const page = await db.listKeys({ formationId: ITEMS, indexId: "by-update", opts: { first: 100 } });
      const ids2 = page.keys.map((k) => k.key.split("/").at(-2)).filter((v): v is string => !!v);
      const items = [];
      for (const id of ids2) {
        const d = await db.readLatest({ formationId: ITEMS, indexId: "by-id", scopeValue: id });
        if (d?.payload) items.push(d.payload);
      }
      return ok({ items });
    }

    // Create an item.
    if (path === "/api/items" && method === "POST") {
      const body = req.json ?? (req.body ? JSON.parse(req.body) : {});
      const item = { itemId: ids.uuidv7(), text: String((body as { text?: unknown }).text ?? ""), createdAt: new Date().toISOString() };
      await db.writeDroplet({ formationId: ITEMS, payload: item as unknown as Record<string, unknown> });
      return ok({ item });
    }

    return bad(`no route for ${method} ${path}`, 404);
  } catch (e) {
    ctx.log.error("app.error", { path, err: e instanceof Error ? e.message : String(e) });
    return bad(e instanceof Error ? e.message : "internal error", 500);
  }
}
