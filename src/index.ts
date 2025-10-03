import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemory } from "./routes/memory.js";
import { registerEval } from "./routes/eval.js";
import { registerContext } from "./routes/context.js";

async function main() {
  const server = new McpServer({ name: "memory-mcp", version: "0.1.0" });

  // Register tools
  registerContext(server);
  registerMemory(server);
  registerEval(server);

  // Dynamically import stdio transport from SDK ESM dist to satisfy TS resolver
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  // Connect over stdio (MCP transport)
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Memora MCP server failed to start:", err);
  process.exit(1);
});
