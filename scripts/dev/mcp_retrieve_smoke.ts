#!/usr/bin/env node
import "dotenv/config";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const t0 = performance.now();

  // Ensure DEBUG logging unless explicitly disabled
  if (!process.env.DEBUG) process.env.DEBUG = "memora:*";
  // Ensure trace file path so memory.ts can emit episodic.retrieve traces
  if (!process.env.MEMORA_TRACE_FILE) {
    process.env.MEMORA_TRACE_FILE = "outputs/memora/trace/retrieve.ndjson";
  }

  // Launch Memora MCP server over stdio (use compiled dist)
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const client = new Client({ name: "memora-mcp-retrieve-smoke", version: "0.1.0" });
  await client.connect(transport);

  const callTool = async (name: string, params?: any) => {
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
  };

  // Establish context (aligns with mcp_write_smoke.ts defaults)
  const ctx = {
    tenant_id: "memora",
    project_id: "benchmarks",
    context_id: `diag-${new Date().toISOString().slice(0,10)}`,
    task_id: "diag",
    env: "bench",
    api_version: "3.1"
  };
  await callTool("context.set_context", ctx);

  // Objective can be overridden via CLI arg; default aligns with write smoke content
  const objective = process.argv.slice(2).join(" ").trim() || "DIAG: episodic write smoke";
  const budget = Number(process.env.MEMORA_DEFAULT_BUDGET || 12);

  const res: any = await callTool("memory.retrieve", {
    objective,
    budget,
    // Intentionally omit filters to exercise relaxed episodic tenant+project defaults
  });

  const snippets = Array.isArray(res?.snippets) ? res.snippets : [];
  console.log("[mcp_retrieve_smoke] Retrieved", snippets.length, "snippets");
  for (let i = 0; i < Math.min(5, snippets.length); i++) {
    const s = snippets[i];
    console.log(JSON.stringify({
      i,
      id: s?.id,
      score: s?.score,
      source: s?.source,
      text_preview: typeof s?.text === "string" ? String(s.text).slice(0, 140) : null
    }));
  }

  await client.close();
  await transport.close();

  const totalMs = +(performance.now() - t0).toFixed(2);
  console.log(`Done in ${totalMs} ms.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
