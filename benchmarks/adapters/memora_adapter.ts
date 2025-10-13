/* benchmarks/adapters/memora_adapter.ts
   Thin adapter to make benchmark harnesses treat Memora as their memory backend.
   Methods wrap Memora MCP tools and provide simple telemetry (latency, optional tokens).
*/
import { performance } from "node:perf_hooks";

export interface McpClient {
  // Generic MCP client that can call tools by name with params.
  callTool(name: string, params?: any): Promise<any>;
}

export type Scope = "this_task" | "project" | "tenant";

export interface WriteItem {
  text: string;
  role?: string;
  tags?: string[];
  idempotency_key?: string;
  scope?: Scope;
  task_id?: string;
}

export interface SearchFilters {
  scope?: Scope[];
  tags?: string[];
  api_version?: string;
  env?: string;
}

export interface SearchCtx {
  task_id?: string;
  context_id?: string;
}

export interface Telemetry<T> {
  data: T;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
}

export class MemoryAdapter {
  constructor(private mcp: McpClient) {}

  // Write always persists to episodic; semantic/facts are gated by salience policies server-side
  async write(item: WriteItem): Promise<Telemetry<{ id: string; semantic_upserts: number; facts_upserts: number }>> {
    const t0 = performance.now();

    // Try to pull active context from the server; include it in write as a fallback
    // so writes succeed even if the server hasn't captured context in-process.
    let ctx: any = undefined;
    try {
      const ctxRes = await this.mcp.callTool("context.get_context");
      ctx = ctxRes?.ok ? ctxRes?.context : undefined;
    } catch {
      // ignore; no context available
    }

    const res = await this.mcp.callTool("memory.write", {
      role: item.role ?? "tool",
      content: item.text,
      tags: item.tags,
      idempotency_key: item.idempotency_key,
      scope: item.scope,
      task_id: item.task_id,
      ...(ctx ? {
        tenant_id: ctx.tenant_id,
        project_id: ctx.project_id,
        context_id: ctx.context_id,
        env: ctx.env,
        api_version: ctx.api_version
      } : {
        // Fallback when no active context is set in the server (force episodic writes in bench)
        tenant_id: process.env.TENANT || "memora",
        project_id: process.env.PROJECT || "benchmarks",
        context_id: process.env.CONTEXT_ID,
        env: process.env.MEMORA_ENV || process.env.NODE_ENV,
        api_version: process.env.MEMORA_API_VERSION
      })
    });
    return {
      data: {
        id: res.event_id,
        semantic_upserts: Number(res.semantic_upserts ?? 0),
        facts_upserts: Number(res.facts_upserts ?? 0)
      },
      latency_ms: performance.now() - t0
    };
  }

  // Salience pre-check: only writes when content has a salient atom
  async writeIfSalient(item: WriteItem, min_score_override?: number): Promise<Telemetry<{ written: boolean; id?: string }>> {
    const t0 = performance.now();

    // Include active context (if available) to ensure writes don't fail when server-side context is missing
    let ctx: any = undefined;
    try {
      const ctxRes = await this.mcp.callTool("context.get_context");
      ctx = ctxRes?.ok ? ctxRes?.context : undefined;
    } catch {
      // ignore
    }

    const res = await this.mcp.callTool("memory.write_if_salient", {
      role: item.role ?? "tool",
      content: item.text,
      tags: item.tags,
      idempotency_key: item.idempotency_key,
      scope: item.scope,
      task_id: item.task_id,
      min_score_override,
      ...(ctx ? {
        tenant_id: ctx.tenant_id,
        project_id: ctx.project_id,
        context_id: ctx.context_id,
        env: ctx.env,
        api_version: ctx.api_version
      } : {
        // Fallback when no active context is set in the server
        tenant_id: process.env.TENANT || "memora",
        project_id: process.env.PROJECT || "benchmarks",
        context_id: process.env.CONTEXT_ID,
        env: process.env.MEMORA_ENV || process.env.NODE_ENV,
        api_version: process.env.MEMORA_API_VERSION
      })
    });
    return {
      data: { written: !!res.written, id: res.event_id },
      latency_ms: performance.now() - t0
    };
  }

  // Retrieve fused snippets from episodic/semantic/facts
  async search(query: string, k = 5, filters?: SearchFilters, ctx?: SearchCtx): Promise<Telemetry<{ items: any[] }>> {
    const t0 = performance.now();
    const res = await this.mcp.callTool("memory.retrieve", {
      objective: query,
      budget: k,
      filters,
      ...ctx
    });
    return { data: { items: Array.isArray(res?.snippets) ? res.snippets : [] }, latency_ms: performance.now() - t0 };
  }

  // Adapter-level "update": latest-wins by writing a superseding fact/event
  async update(id: string, patch: any): Promise<Telemetry<{ ok: boolean; policy: "latest_wins" }>> {
    const t0 = performance.now();
    await this.mcp.callTool("memory.write", {
      role: "tool",
      content: JSON.stringify({ supersedes: id, patch }),
      tags: ["supersede", `superseded:${id}`]
    });
    return { data: { ok: true, policy: "latest_wins" }, latency_ms: performance.now() - t0 };
  }

  // Adapter-level soft-delete: mark to exclude in retrieval; no hard delete
  async delete(id: string): Promise<Telemetry<{ ok: boolean; policy: "soft_delete" }>> {
    const t0 = performance.now();
    await this.mcp.callTool("memory.write", {
      role: "tool",
      content: JSON.stringify({ delete: id }),
      tags: ["deleted", `deleted:${id}`]
    });
    return { data: { ok: true, policy: "soft_delete" }, latency_ms: performance.now() - t0 };
  }

  // Promote a semantic memory to broader scope
  async promote(mem_id: string, to_scope: Scope): Promise<Telemetry<{ ok: boolean; mem_id: string; scope: Scope }>> {
    const t0 = performance.now();
    const res = await this.mcp.callTool("memory.promote", { mem_id, to_scope });
    return {
      data: { ok: !!res?.ok, mem_id: res?.mem_id ?? String(mem_id), scope: (res?.scope ?? to_scope) as Scope },
      latency_ms: performance.now() - t0
    };
  }

  // Retrieve and return a packed prompt using server-side packer
  async pack(
    query: string,
    k = 8,
    sections?: { system?: string; task_frame?: string; tool_state?: string; recent_turns?: string },
    filters?: SearchFilters,
    ctx?: SearchCtx
  ): Promise<Telemetry<{ packed: string; snippets: any[] }>> {
    const t0 = performance.now();
    const res = await this.mcp.callTool("memory.retrieve_and_pack", {
      objective: query,
      budget: k,
      ...sections,
      filters,
      ...ctx
    });
    return {
      data: { packed: res?.packed_prompt ?? "", snippets: Array.isArray(res?.snippets) ? res.snippets : [] },
      latency_ms: performance.now() - t0
    };
  }
}

export default MemoryAdapter;
