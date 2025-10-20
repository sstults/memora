#!/usr/bin/env node
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
    cwd: process.cwd(),
    env: process.env as Record<string, string>
  });

  const client = new Client({ name: "test-pack", version: "0.1.0" });
  await client.connect(transport);

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

  const query = "What was the first issue I had with my new car after its first service?";
  console.log("Calling memory.retrieve_and_pack with query:", query);

  const res: any = await client.callTool({
    name: "memory.retrieve_and_pack",
    arguments: {
      objective: query,
      budget: 20,
      recent_turns: "Test recent turns",
      filters: {
        scope: ["this_task", "project"]
      },
      task_id: "longmemeval-42"
    }
  });

  const snippets = Array.isArray(res?.snippets) ? res.snippets : [];
  console.log(`\nRetrieved ${snippets.length} snippets`);
  console.log(`Packed prompt length: ${res?.packed_prompt?.length || 0}`);

  if (snippets.length > 0) {
    console.log("\nFirst snippet:");
    console.log(`  score=${snippets[0]?.score?.toFixed(2)}`);
    console.log(`  text=${snippets[0]?.text?.slice(0, 100)}...`);
  }

  await client.close();
  await transport.close();
}

main().catch(console.error);
