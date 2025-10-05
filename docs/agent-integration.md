# Memora Agent Integration Guide (MCP)

This guide explains how MCP-capable agents can autonomously use Memora to persist, retrieve, and promote memories, without human-in-the-loop prompts. All capabilities are exposed as MCP tools.

Highlights:
- Explicit tool surface for agent workflows
- Context bootstrap helpers
- Salience-aware writes
- Retrieve-and-pack convenience
- Promotion utilities
- Metrics logging

Prerequisites:
- Ensure `context.set_context` (or `context.ensure_context`) is called before memory/eval tools.
- Configure OpenSearch and environment per README when running against a real cluster. For local development you can use mock embedder/reranker.

---

## Tool Catalog

All tools are registered under the MCP server process.

### 1) Context

- context.set_context
  - Request: { tenant_id, project_id, context_id?, task_id?, env?, api_version? }
  - Response: { ok: true, context }
  - Notes: Required before memory/eval tools; sets active process-local context.

- context.ensure_context
  - Request: { tenant_id, project_id, context_id?, task_id?, env?, api_version? }
  - Response: { ok: true, context, created: boolean }
  - Behavior: If no context is active, sets it and returns created=true. If already set, returns existing context and created=false.
  - Use-case: Safe bootstrap in multi-agent orchestrations.

- context.get_context
  - Response: { ok: true, context } or { ok: false, message }

- context.clear_context
  - Response: { ok: true }

Context is process-local. When orchestrating multiple tenants/tasks in a single Memora process, switch contexts explicitly with `context.set_context` or run separate Memora instances per agent.

### 2) Memory

- memory.write
  - Request: { role, content, tags?, artifacts?, scope?("this_task"|"project"|"tenant"), task_id?, idempotency_key?, hash? }
  - Response: { ok: true, event_id, semantic_upserts, facts_upserts }
  - Behavior:
    - Always writes to episodic log.
    - Applies salience filtering, summarization/redaction, and embeddings to upsert semantic chunks and lightweight facts.
    - Idempotency: Provide idempotency_key (or hash) to deduplicate at-least-once writes.

- memory.write_if_salient
  - Request: Same as memory.write, plus optional { min_score_override?: number }
  - Response: { ok: true, written: boolean, reason?: "below_threshold", event_id?, semantic_upserts?, facts_upserts? }
  - Behavior: Fast pass to check if any atom exceeds salience threshold; only persists if salient.

- memory.retrieve
  - Request: {
      objective: string,
      budget?: number,
      filters?: { scope?: string[], tags?: string[], api_version?: string, env?: string },
      task_id?, context_id?
    }
  - Response: { snippets: [{ id, text, score, source: "episodic"|"semantic"|"facts", tags, why, context }] }
  - Behavior: Episodic BM25 + Semantic kNN + Facts keyword → fused via RRF + MMR; optional rerank if enabled. Touches `last_used` on returned semantic chunks.

- memory.retrieve_and_pack
  - Request: All memory.retrieve params, plus optional sections:
    - { system?: string, task_frame?: string, tool_state?: string, recent_turns?: string }
  - Response: { snippets, packed_prompt }
  - Behavior: Performs `memory.retrieve` then composes a packed prompt using `config/packing.yaml` via the built-in packer.

- memory.promote
  - Request: { mem_id, to_scope }
  - Response: { ok: true, mem_id, scope }
  - Notes: Accepts either raw id or `mem:<id>` form. Updates `task_scope` for a semantic memory.

- memory.autopromote
  - Request: {
      to_scope: "project"|"tenant"|"this_task",
      limit?: number (default 10, max 100),
      sort_by?: "last_used"|"salience",
      filters?: { scope?, tags?, api_version?, env?, context_id? }
    }
  - Response: { ok: true, promoted: string[], scope }
  - Behavior: Queries top candidates from semantic index then promotes them.

### 3) Packing

- pack.prompt
  - Request: { sections: [{ name: string, content: string, tokens?: number }] }
  - Response: { packed: string }
  - Behavior: Packs content per `config/packing.yaml` order/limits. Section names typically include:
    - system, task_frame, tool_state, retrieved, recent_turns

### 4) Evaluation

- eval.log
  - Request: {
      step: number, success: boolean, tokens_in: number, latency_ms: number,
      cost_usd?, retrieved_ids?, p_at_k?, groundedness?,
      tenant_id?, project_id?, context_id?, task_id?, env?, api_version?
    }
  - Response: { ok: true, id }
  - Behavior: Uses active context for any missing IDs. Optionally mirrors a tiny event to episodic when `MEMORA_EVAL_EPISODIC_MIRROR=true`.

---

## Recommended Agent Flows

### A) Session Bootstrap (single agent)
1) context.ensure_context or context.set_context
2) memory.retrieve to prime with relevant context
3) Use snippets to plan next step
4) After each step/tool action, memory.write (or memory.write_if_salient) with an `idempotency_key`
5) Optionally memory.promote or memory.autopromote for durable knowledge
6) eval.log the step metrics

### B) Retrieve and build the model prompt
- Prefer memory.retrieve_and_pack with sections:
  - system: constant rails
  - task_frame: current objective/instructions
  - tool_state: structured status
  - recent_turns: small rolling window
- Or fetch via memory.retrieve and use pack.prompt directly.

### C) Multi-project orchestration
- Maintain a Memora process per project/tenant OR call context.set_context before each agent’s turn.
- Use tags and scope to segregate retrieval.
- Use idempotency_key to dedupe logs across retries.

---

## Best Practices

- Idempotency: Always populate `idempotency_key` when logging actions or observations.
- Scoping:
  - Use `scope: "this_task"` for transient task state.
  - Promote to "project" for reusable artifacts.
- Tags: Attach tags to improve retrievability and later filtering (e.g., ["planning", "design", "error"]).
- Redaction: Sensitive content is redacted on write; still prefer to avoid raw secrets in content.
- Budgets: Tune retrieval/packing budgets in YAML configs to stay within token limits.
- Rerank: Enable server-side rerank for higher precision when available.
- Health/Bootstrap: In dev, use `MEMORA_BOOTSTRAP_OS=1` to idempotently apply index templates.

---

## Examples

Context bootstrap:
```json
{ "params": { "tenant_id": "acme", "project_id": "alpha", "context_id": "ctx-42", "task_id": "t-1", "env": "prod", "api_version": "3.1" } }
```

Salience-aware write:
```json
{ "params": { "role": "tool", "content": "FeatureA introduced_in v1_0 ...", "tags": ["design"], "idempotency_key": "obs-123" } }
```

Retrieve and pack:
```json
{
  "params": {
    "objective": "FeatureA introduced_in v1_0",
    "budget": 8,
    "filters": { "scope": ["this_task", "project"] },
    "system": "You are a coding assistant.",
    "task_frame": "Implement FeatureA.",
    "recent_turns": "TURN1 ...\n---TURN---\nTURN2 ..."
  }
}
```

Promote:
```json
{ "params": { "mem_id": "mem:abc123", "to_scope": "project" } }
```

Autopromote:
```json
{ "params": { "to_scope": "project", "limit": 5, "sort_by": "last_used", "filters": { "tags": ["design"] } } }
```

Eval log:
```json
{ "params": { "step": 3, "success": true, "tokens_in": 900, "latency_ms": 1500, "retrieved_ids": ["mem:abc123"] } }
