#!/usr/bin/env node
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  // Launch Memora MCP server
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const client = new Client({ name: "test-longmemeval", version: "0.1.0" });
  await client.connect(transport);

  // Set context to match benchmark
  const ctx = {
    tenant_id: "memora",
    project_id: "benchmarks",
    context_id: "longmemeval-42-C-driver",
    task_id: "longmemeval-42",
    env: "bench",
    api_version: "3.1"
  };

  console.log("Setting context:", ctx);
  await client.callTool({ name: "context.set_context", arguments: ctx });

  // Try to retrieve with the first question from the benchmark
  const query = "What was the first issue I had with my new car after its first service?";
  console.log("Querying:", query);

  const res: any = await client.callTool({
    name: "memory.retrieve",
    arguments: {
      objective: query,
      budget: 20,
      filters: {
        scope: ["this_task", "project"]
      }
    }
  });

  const snippets = Array.isArray(res?.snippets) ? res.snippets : [];
  console.log(`\nRetrieved ${snippets.length} snippets`);

  if (snippets.length > 0) {
    console.log("\nFirst 3 snippets:");
    for (let i = 0; i < Math.min(3, snippets.length); i++) {
      const s = snippets[i];
      console.log(`\n[${i+1}] score=${s?.score?.toFixed(2)} source=${s?.source}`);
      console.log(`    ${s?.text?.slice(0, 150)}...`);
    }
  } else {
    console.log("\n⚠️  NO SNIPPETS RETURNED!");
  }

  await client.close();
  await transport.close();
}

main().catch(console.error);
