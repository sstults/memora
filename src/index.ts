import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemory } from "./routes/memory.js";
import { registerEval } from "./routes/eval.js";
import { registerContext } from "./routes/context.js";
import { registerPack } from "./routes/pack.js";
import { bootstrapOpenSearch } from "./services/os-bootstrap.js";

async function main() {
  const server = new McpServer({ name: "memory-mcp", version: "0.1.0" });

  // Register tools
  registerContext(server);
  registerMemory(server);
  registerEval(server);
  registerPack(server);

  // Optionally bootstrap OpenSearch if enabled (best-effort; do not crash MCP)
  if ((process.env.MEMORA_BOOTSTRAP_OS || "") === "1" || (process.env.MEMORA_BOOTSTRAP_OS || "").toLowerCase() === "true") {
    try {
      await bootstrapOpenSearch();
    } catch (err) {
      console.error("bootstrapOpenSearch failed (continuing to serve MCP):", err);
      // Continue serving MCP even if bootstrap fails; routes will handle OS unavailability.
    }
  }

  // Dynamically import stdio transport from SDK ESM dist to satisfy TS resolver
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  // Connect over stdio (MCP transport)
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("Memora MCP server failed to start:", err);
  process.exit(1);
});
