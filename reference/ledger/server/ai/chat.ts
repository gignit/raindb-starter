// ai/chat.ts -- the 2-plane AI report (M3.5). Placeholder until the agent loop
// is wired; the dispatcher already routes /api/ai/chat here.

import type { BoltRequest, BoltResponse } from "@raindb/bolt-sdk";
import { bad } from "../lib/http.js";

export async function handleChat(_req: BoltRequest): Promise<BoltResponse> {
  return bad("AI chat not yet implemented", 501);
}
