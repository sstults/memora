// src/routes/context.ts
// Context management routes for Memora MCP.

import { Context } from "../domain/types";

// In-memory context store (per MCP process).
let activeContext: Context | null = null;

export function registerContext(server: any) {
  // Tool: set_context
  server.tool("context.set_context", async (req: any) => {
    const r: any = req || {};
    const params = (r.params && Object.keys(r.params || {}).length > 0)
      ? r.params
      : (r.arguments && Object.keys(r.arguments || {}).length > 0)
        ? r.arguments
        : (r.requestInfo?.params && Object.keys(r.requestInfo.params || {}).length > 0)
          ? r.requestInfo.params
          : (r.requestInfo?.arguments && Object.keys(r.requestInfo.arguments || {}).length > 0)
            ? r.requestInfo.arguments
            : r;
    const ctx = params as Context;
    if (!ctx?.tenant_id || !ctx?.project_id) {
      throw new Error("tenant_id and project_id are required");
    }
    activeContext = ctx;
    return { ok: true, context: activeContext };
  });

  // Tool: ensure_context
  // If no active context is set, set it with provided fields (requires tenant_id, project_id).
  // Otherwise, return the current active context with created=false.
  server.tool("context.ensure_context", async (req: any) => {
    if (activeContext) {
      return { ok: true, context: activeContext, created: false };
    }
    const r: any = req || {};
    const params = (r.params && Object.keys(r.params || {}).length > 0)
      ? r.params
      : (r.arguments && Object.keys(r.arguments || {}).length > 0)
        ? r.arguments
        : (r.requestInfo?.params && Object.keys(r.requestInfo.params || {}).length > 0)
          ? r.requestInfo.params
          : (r.requestInfo?.arguments && Object.keys(r.requestInfo.arguments || {}).length > 0)
            ? r.requestInfo.arguments
            : r;
    const incoming = params as Partial<Context>;
    if (!incoming?.tenant_id || !incoming?.project_id) {
      throw new Error("context.ensure_context requires tenant_id and project_id when no active context exists.");
    }
    activeContext = {
      tenant_id: incoming.tenant_id!,
      project_id: incoming.project_id!,
      context_id: (incoming.context_id as any) ?? null,
      task_id: (incoming.task_id as any) ?? null,
      env: incoming.env ?? undefined,
      api_version: incoming.api_version ?? undefined
    } as Context;
    return { ok: true, context: activeContext, created: true };
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
