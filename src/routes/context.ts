// src/routes/context.ts
// Context management routes for Memora MCP.

import { Server } from "@modelcontextprotocol/sdk";
import { Context } from "../domain/types";

// In-memory context store (per MCP process).
let activeContext: Context | null = null;

export function registerContext(server: Server) {
  // Tool: set_context
  server.tool("context.set_context", async (req) => {
    const ctx = req.params as Context;
    if (!ctx.tenant_id || !ctx.project_id) {
      throw new Error("tenant_id and project_id are required");
    }
    activeContext = ctx;
    return { ok: true, context: activeContext };
  });

  // Tool: get_context
  server.tool("context.get_context", async () => {
    if (!activeContext) {
      return { ok: false, message: "No active context set." };
    }
    return { ok: true, context: activeContext };
  });

  // Tool: clear_context (optional convenience)
  server.tool("context.clear_context", async () => {
    activeContext = null;
    return { ok: true };
  });
}

// Utility: used by other routes to require a context
export function requireContext(): Context {
  if (!activeContext) {
    throw new Error("No active context set. Call context.set_context first.");
  }
  return activeContext;
}
