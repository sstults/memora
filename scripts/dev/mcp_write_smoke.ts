#!/usr/bin/env ts-node

import "dotenv/config";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const t0 = performance.now();

  // Ensure DEBUG logging unless explicitly disabled
  if (!process.env.DEBUG) process.env.DEBUG = "memora:*";

  // Launch Memora MCP server over stdio (use compiled dist)
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const client = new Client({ name: "memora-mcp-write-smoke", version: "0.1.0" });
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

  // Establish context
  const ctx = {
    tenant_id: "memora",
    project_id: "benchmarks",
    context_id: `diag-${new Date().toISOString().slice(0,10)}`,
    task_id: "diag",
    env: "bench",
    api_version: "3.1"
  };
  await callTool("context.set_context", ctx);

  // Single diagnostic write
  const content = `DIAG: episodic write smoke at ${new Date().toISOString()} :: expect the daily index to increment and episodic.index.* traces to appear.`;
  const tags = ["diag", "smoke", "episodic"];
  const res = await callTool("memory.write", {
    content,
    role: "tool",
    tags,
    scope: "this_task",
    task_id: ctx.task_id,
    // Provide explicit context for fallback if server process hasn't captured active context
    tenant_id: ctx.tenant_id,
    project_id: ctx.project_id,
    context_id: ctx.context_id,
    env: ctx.env,
    api_version: ctx.api_version
  });

  // Print returned payload for visibility (event_id expected)
  console.log("[mcp_write_smoke] Response payload:", JSON.stringify(res, null, 2));

  await client.close();
  await transport.close();

  const totalMs = +(performance.now() - t0).toFixed(2);
  console.log(`Done in ${totalMs} ms.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
