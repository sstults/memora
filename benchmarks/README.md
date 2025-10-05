# Benchmarks scaffold

This folder contains a minimal scaffold to benchmark Memora as a memory backend via a thin TypeScript adapter and per-suite runners.

Structure:
- adapters/memora_adapter.ts — TypeScript MemoryAdapter that wraps Memora MCP tools
- config/
  - llm.json — pinned LLM/provider settings (OpenAI gpt-4.1-mini, temp 0–0.2, no streaming)
  - memora.json — Memora retrieval defaults (scopes, budget)
- runners/
  - run_longmemeval.sh — runner script with A/B/C variants; currently emits a JSONL header (wire in the real harness)
- reports/
  - .gitkeep — placeholder for results

Variants:
- A: Sliding-window only (no memory)
- B: Vector RAG baseline (no Memora policies)
- C: Memora MCP (full policies)

Usage (current scaffold):
- Ensure Memora MCP server and required environment are running
- Run a placeholder LongMemEval run (writes a single JSON line):
  bash benchmarks/runners/run_longmemeval.sh --variant C --seed 42 --out benchmarks/reports/longmemeval.C.42.jsonl

Next steps to integrate LongMemEval:
1) Add a Node/TS runner that:
   - Creates an MCP client connected to Memora
   - Instantiates MemoryAdapter and passes it into LongMemEval's agent/memory hooks
   - Loads configs from benchmarks/config/*.json
   - Emits JSONL per trial and aggregates summary tables/plots
2) Extend runners for MemoryAgentBench, LoCoMo, MemBench, and ablations for BABILong/ETHIC
3) Implement A/B/C switching:
   - A: skip memory calls (sliding-window only)
   - B: route to a simple embedding index without Memora policies
   - C: route to MemoryAdapter + Memora MCP tools
4) Record telemetry:
   - p50/p95 latency for write/search/e2e, footprint, throughput, forgetting curve bins
   - MemoryScore and frontier plots (Accuracy vs p95Latency)
