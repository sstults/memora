// src/routes/eval.ts
// Per-turn and per-task evaluation logging for Memora MCP.

import { EvalMetrics, Context } from "../domain/types";
import { requireContext } from "./context";
import { getClient } from "../services/os-client";

const METRICS_INDEX = process.env.MEMORA_METRICS_INDEX || "mem-metrics";
const EPISODIC_MIRROR = process.env.MEMORA_EVAL_EPISODIC_MIRROR === "true"; // optional

export function registerEval(server: any) {
  server.tool("eval.log", async (req: any) => {
    const ctx = ensureContextDefaults(req.params as Partial<EvalMetrics>);
    validateMetrics(ctx);

    const client = getClient();
    const docId = `${ctx.project_id}:${ctx.task_id}:${ctx.step}:${Date.now()}`;

    // 1) Write to metrics index
    await client.index({
      index: METRICS_INDEX,
      id: docId,
      body: {
        ...ctx,
        ts: new Date().toISOString(),
        // Flatten retrieved_ids for easier aggregations
        retrieved_count: ctx.retrieved_ids?.length ?? 0
      },
      refresh: true
    });

    // 2) Optional mirror to episodic as a tiny event
    if (EPISODIC_MIRROR) {
      const episodicIndex = `mem-episodic-${new Date().toISOString().slice(0, 10)}`;
      await client.index({
        index: episodicIndex,
        body: {
          tenant_id: ctx.tenant_id,
          project_id: ctx.project_id,
          context_id: ctx.context_id,
          task_id: ctx.task_id,
          event_id: docId,
          ts: new Date().toISOString(),
          role: "eval",
          content: `eval step ${ctx.step}: success=${ctx.success} tokens=${ctx.tokens_in} latency_ms=${ctx.latency_ms}`,
          tags: ["eval"],
          artifacts: [],
          hash: docId
        }
      });
    }

    return { ok: true, id: docId };
  });
}

/** Ensure tenant/project (and other context fields) are present; pull from active context if missing. */
function ensureContextDefaults(partial: Partial<EvalMetrics>): EvalMetrics {
  const active: Context = requireContext();
  return {
    tenant_id: partial.tenant_id ?? active.tenant_id,
    project_id: partial.project_id ?? active.project_id,
    context_id: partial.context_id ?? active.context_id,
    task_id: partial.task_id ?? active.task_id ?? "unknown-task",
    env: partial.env ?? active.env,
    api_version: partial.api_version ?? active.api_version,

    // required eval fields
    step: num(partial.step, 0),
    success: !!partial.success,
    tokens_in: num(partial.tokens_in, 0),
    latency_ms: num(partial.latency_ms, 0),
    cost_usd: partial.cost_usd !== undefined ? Number(partial.cost_usd) : undefined,
    retrieved_ids: partial.retrieved_ids ?? [],
    p_at_k: partial.p_at_k !== undefined ? Number(partial.p_at_k) : undefined,
    groundedness: partial.groundedness !== undefined ? Number(partial.groundedness) : undefined
  };
}

function validateMetrics(m: EvalMetrics) {
  if (!m.tenant_id) throw new Error("eval.log: tenant_id is required (set context first).");
  if (!m.project_id) throw new Error("eval.log: project_id is required (set context first).");
  if (!m.task_id) throw new Error("eval.log: task_id is required.");
  if (m.step < 0) throw new Error("eval.log: step must be >= 0.");
  if (m.tokens_in < 0) throw new Error("eval.log: tokens_in must be >= 0.");
  if (m.latency_ms < 0) throw new Error("eval.log: latency_ms must be >= 0.");
}

function num(v: any, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
