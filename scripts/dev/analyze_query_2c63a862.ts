#!/usr/bin/env ts-node
/* Deep-dive analyzer for a single failing query (qid=2c63a862)
   - Connects to Memora MCP over stdio
   - Ensures bench context consistent with LongMemEval driver
   - Runs memory.retrieve for the exact question with and without tag filters
   - Prints top fused snippets with scores, sources, and quick date heuristics
*/

import "dotenv/config";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import MemoryAdapter from "../../benchmarks/adapters/memora_adapter.js";
import fs from "node:fs";
import path from "node:path";

import type { Scope } from "../../benchmarks/adapters/memora_adapter.js";

// Dataset anchor
const QID = "2c63a862";
const QUESTION =
  "How many days did it take for me to find a house I loved after starting to work with Rachel?";
// Ground truth from dataset: "14 days. 15 days (including the last day) is also acceptable."

async function main() {
  const t0 = performance.now();

  // Ensure DEBUG logging unless explicitly disabled
  if (!process.env.DEBUG) {
    process.env.DEBUG = "memora:*";
  }

  // Launch MCP server (match bench driver behavior)
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const client = new Client({ name: "memora-single-query-analyzer", version: "0.1.0" });
  await client.connect(transport);

  const mcpClient = {
    callTool: async (name: string, params?: any) => {
      const t = performance.now();
      try {
        const res = await client.callTool({ name, arguments: params ?? {} });
        const took = +(performance.now() - t).toFixed(2);
        console.log(JSON.stringify({ ts: new Date().toISOString(), op: "mcp_call", tool: name, latency_ms: took, success: true }));
        return res;
      } catch (err: any) {
        const took = +(performance.now() - t).toFixed(2);
        console.log(JSON.stringify({ ts: new Date().toISOString(), op: "mcp_call", tool: name, latency_ms: took, success: false, error: String(err?.message ?? err) }));
        throw err;
      }
    }
  };

  // Bench context must match driver so filters/scopes align
  const ctxParams = {
    tenant_id: "memora",
    project_id: "benchmarks",
    context_id: `longmemeval-42-C-driver`,
    task_id: `longmemeval-42`,
    env: "bench",
    api_version: "3.1"
  };
  await mcpClient.callTool("context.set_context", ctxParams);
  const adapter = new MemoryAdapter(mcpClient as any);

  // Load the single sample's haystack sessions and replay them into Memora so retrieval has material.
  // This mirrors the driver behavior but only for QID=2c63a862.
  const datasetPath = process.env.LME_DATASET || "benchmarks/LongMemEval/data/longmemeval_oracle.json";

  function loadDataset(p: string): any[] {
    try {
      const s = fs.readFileSync(path.resolve(p), "utf8");
      const raw = JSON.parse(s);
      if (Array.isArray(raw)) return raw;
      if (Array.isArray(raw?.data)) return raw.data;
      if (Array.isArray(raw?.examples)) return raw.examples;
      if (Array.isArray(raw?.items)) return raw.items;
      if (raw && typeof raw === "object") return Object.values(raw);
    } catch (e: any) {
      console.warn(`[analyze] Failed to read dataset ${p}: ${e?.message || e}`);
    }
    return [];
  }

  function asTurnsField(sample: any): Array<Array<{ content?: string; text?: string; role?: string }>> {
    const candidates = [sample.haystack_sessions, sample.sessions, sample.history, sample.conversation, sample.turns].filter(Boolean);
    if (candidates.length === 0) return [];
    const v = candidates[0];
    if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) return v as any;
    if (Array.isArray(v)) return [v as any];
    return [];
  }

  async function replaySessionsToMemoraOnce(sessions: Array<Array<{ content?: string; text?: string; role?: string }>>): Promise<void> {
    for (let sIdx = 0; sIdx < sessions.length; sIdx++) {
      const session = sessions[sIdx] || [];
      for (let tIdx = 0; tIdx < session.length; tIdx++) {
        const turn = session[tIdx] || {};
        const text = String((turn.content ?? turn.text ?? "")).trim();
        if (!text) continue;
        try {
          await adapter.write({
            text,
            role: turn.role || "user",
            tags: ["bench", "longmemeval", `seed:42`, `variant:C`, `qid:${QID}`],
            scope: "this_task",
            task_id: `longmemeval-42`
          });
        } catch (e) {
          // best-effort; continue
        }
      }
    }
  }

  // One-time ingest for this analyzer run (idempotent at index level; duplicates are acceptable in dev)
  const items = loadDataset(datasetPath);
  const sample = items.find((s: any) => String(s?.question_id ?? s?.id ?? s?.qid ?? s?.uid ?? "") === QID);
  if (!sample) {
    console.warn(`[analyze] Could not find sample with question_id=${QID} in ${datasetPath}`);
  } else {
    const sessions = asTurnsField(sample);
    if (sessions.length === 0) {
      console.warn("[analyze] Sample has no sessions/haystack to ingest.");
    } else {
      console.log(`[analyze] Ingesting ${sessions.reduce((n, sess) => n + (Array.isArray(sess) ? sess.length : 0), 0)} turns into Memora for qid=${QID}...`);
      await replaySessionsToMemoraOnce(sessions);
    }
  }

  // Helper to pretty-print truncated text
  const trunc = (s: string, n = 160) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };

  // Heuristic to find date markers in a snippet
  function dateMarkers(s: string) {
    const m: string[] = [];
    if (/\b(2\/15|02\/15|Feb(?:ruary)?\s+15)\b/i.test(s)) m.push("START(2/15)");
    if (/\b(3\/01|03\/01|March\s+1)\b/i.test(s)) m.push("END(3/1)");
    if (/\b\d+\s+days?\b/i.test(s)) m.push("HAS(NUM_DAYS)");
    return m;
  }

  async function runOnce(label: string, withTagFilter: boolean) {
    console.log(`\n=== ${label} ===`);
    const filters: { scope: Scope[]; tags?: string[] } = { scope: ["this_task", "project"] };
    // Narrow to the injected haystack for this qid if requested
    if (withTagFilter) filters.tags = [`qid:${QID}`, "seed:42", "variant:C"];

    // Adapter.search calls memory.retrieve under the hood and logs timing
    const K = 24;
    const res = await adapter.search(QUESTION, K, filters, { task_id: `longmemeval-42` });

    const snippets = Array.isArray((res as any)?.data?.items)
      ? (res as any).data.items
      : (Array.isArray((res as any)?.items) ? (res as any).items : []);
    if (!snippets.length) {
      console.log("No snippets returned.");
      return;
    }

    // Print top snippets with source and score, and quick date markers
    for (let i = 0; i < Math.min(snippets.length, K); i++) {
      const s = snippets[i];
      const marks = dateMarkers(s.text || "");
      console.log(
        `[${String(i + 1).padStart(2, "0")}] (${s.source}; score=${(s.score ?? 0).toFixed(3)}) ${trunc(s.text)} ${marks.length ? " :: " + marks.join(",") : ""}`
      );
    }
  }

  // 1) Strictly within qid-tagged haystack (should show both anchor events if present)
  await runOnce("Tagged haystack only (tags: qid:2c63a862, seed:42, variant:C)", true);

  // 2) Broad search across bench context (to detect contamination or insufficient specificity)
  await runOnce("Broad bench context (no tag filter)", false);

  // Optional: packed prompt view (what LLM sees)
  console.log(`\n=== Packed prompt (top-K in pack) ===`);
  const recent = ""; // omit long recent_turns in this analyzer
  const pack = await adapter.pack(QUESTION, 20, { recent_turns: recent }, { scope: ["this_task", "project"], tags: [`qid:${QID}`, "seed:42", "variant:C"] }, { task_id: `longmemeval-42` });
  const packed: string = pack?.data?.packed ?? "";
  const lines = packed.split(/\r?\n/);
  console.log(lines.slice(0, 80).join("\n")); // print first 80 lines for brevity

  await client.close();
  await transport.close();

  const totalMs = +(performance.now() - t0).toFixed(2);
  console.log(`\nDone in ${totalMs} ms.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
