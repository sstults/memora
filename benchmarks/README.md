# Benchmarks

This directory contains Memora’s benchmarking scaffolding and runners. It integrates the Python LongMemEval harness and provides a TypeScript driver that replays dataset sessions into Memora via MCP, then emits predictions JSONL for scoring.

Structure:
- adapters/memora_adapter.ts — TypeScript MemoryAdapter wrapping Memora MCP tools with latency telemetry
- config/
  - llm.json — pinned LLM/provider settings (OpenAI gpt-4.1-mini, temp 0–0.2, no streaming)
  - memora.json — Memora retrieval defaults (scopes, budget)
- runners/
  - longmemeval.ts — Node/TS runner scaffold (connectivity + telemetry)
  - longmemeval_driver.ts — Node/TS LongMemEval driver (produces predictions JSONL)
  - score_longmemeval.ts — Node/TS scorer that calls the Python harness to compute metrics
  - run_longmemeval.sh — shell wrapper preferring compiled output (still supported)
- reports/
  - .gitkeep — placeholder for results

Variants:
- A: Sliding-window only (no memory)
- B: Vector RAG baseline (no Memora policies)
- C: Memora MCP (full policies; default for driver)

Current status:
- LongMemEval harness added as a pinned submodule
- TypeScript driver emits a valid predictions JSONL with stub hypotheses (for end-to-end plumbing)
- Scoring helper invokes the Python evaluator to produce metrics

Important: The driver currently emits empty string hypotheses as placeholders. Next step is to integrate an LLM using config/llm.json to produce real answers.

---

LongMemEval harness (Python) — install and pin

Pinned repo (ICLR 2025):
- https://github.com/xiaowu0162/LongMemEval
- Pinned commit: b60a5b7 (Apr 27, 2025)

Submodule setup:
- The repository already includes the harness as a git submodule at benchmarks/LongMemEval.
- If you just cloned this repo, initialize submodules:
  git submodule update --init --recursive

Python environment (evaluation only):
- Recommended Python 3.9 with a minimal environment (requirements-lite.txt)
  cd benchmarks/LongMemEval
  # e.g., using conda (optional)
  conda create -n longmemeval-lite python=3.9 -y
  conda activate longmemeval-lite
  pip install -r requirements-lite.txt

Dataset:
- Follow the dataset links in the harness README to download data.
- Place the JSON(s) under benchmarks/LongMemEval/data, e.g.:
  benchmarks/LongMemEval/data/longmemeval_oracle.json
- If provided as an archive (.tar.gz), extract within the data directory per upstream instructions.

---

Node/TS driver and scoring

Driver (produces predictions JSONL):
- The driver replays each example’s history into Memora (variant C), retrieves relevant memories, and emits one line:
  {"question_id":"<id>", "hypothesis":"<answer>"}
- For now, the hypothesis is an empty string to validate the scoring pipeline. Replace with actual LLM calls in a later step.

Scorer (invokes Python evaluator):
- Calls the LongMemEval evaluation scripts to score the predictions JSONL and print a metric summary.

NPM scripts:
- Smoke end-to-end run (driver + scoring):
  npm run bench:longmem:smoke
- Just the driver (writes predictions JSONL):
  npm run bench:longmem:driver
- Just the scorer (consumes the predictions JSONL and dataset JSON):
  npm run bench:longmem:score

Defaults used by scripts:
- Predictions JSONL: benchmarks/reports/memora_predictions.jsonl
- Dataset JSON: benchmarks/LongMemEval/data/longmemeval_oracle.json
- Variant: C
- Seed: 42

Manual invocation (examples):
- TypeScript driver:
  node --import ./scripts/register-ts-node.mjs benchmarks/runners/longmemeval_driver.ts \
    --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \
    --out benchmarks/reports/memora_predictions.jsonl \
    --variant C --seed 42

- TypeScript scorer (which calls Python):
  node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts \
    --hyp benchmarks/reports/memora_predictions.jsonl \
    --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \
    --tag memora

Requirements for scoring:
- A working Python 3.9 env with requirements-lite.txt installed
- Dataset file at the specified path

---

A/B/C baselines

- A (sliding-window only): the driver currently emits stub predictions without calling Memora. Intended for baseline plumbing.
- B (vector RAG baseline): implement a simple vector index without Memora policies (TODO).
- C (Memora MCP, default): uses MemoryAdapter over MCP tools to write, retrieve, and later pack context for the LLM.

Telemetry and reporting

- The driver emits JSONL headers and can log MCP call latency for Memora interactions.
- Scoring produces a .log file within the same directory as the predictions JSONL; the scorer prints aggregate metrics.
- Reports directory:
  benchmarks/reports/

Next steps

- Integrate LLM in the driver using config/llm.json (OpenAI gpt-4.1-mini with temperature 0–0.2).
- Record tokens_in/out where available (or estimate with a tokenizer, with disclosure).
- Aggregate results into CSV/Markdown and generate frontier plots (Accuracy vs p95Latency).
- Implement baseline B using a simple vector index (OpenSearch kNN or lightweight local embedding index).
- Add seed matrices and variant switching in the driver (A/B/C) with consolidated JSONL outputs.

---

MemoryAgentBench (MAB) integration

This repository includes a pluggable runner for MemoryAgentBench (Accurate_Retrieval split), producing predictions JSON compatible with the upstream evaluator and a local OpenAI-judge scorer.

Files:
- mab_helpers/dump_references.py — Python helper to load references from HuggingFace (ai-hyz/MemoryAgentBench), filter by split/source, and emit [{question, answer, question_id, question_type, context, source, abstention}].
- runners/mab_driver.ts — TypeScript driver that:
  - Dumps references via the helper
  - Writes each unique long context into Memora (salience-aware)
  - Packs and answers each question with an LLM (or emits empty answers if no OPENAI_API_KEY)
  - Writes predictions to outputs/memora/{split}/{source}_SEED{seed}.json with shape:
    { "data": [ {question_id, question, output, answer, ...} ], "meta": {...} }
- runners/score_mab.ts — TypeScript scorer that:
  - Reloads references
  - Prompts an OpenAI judge (default gpt-4o) with task-specific rubric to grade yes/no
  - Writes results to outputs/memora/{split}/.eval-results-memora-{fileTag} (JSONL)
- runners/run_memoryagentbench.sh — Shell wrapper to build, run the driver, and (optionally) score.

Prereqs:
- Node 20+
- Python 3.10+ with pip install datasets
- OPENAI_API_KEY (only required for scoring or for non-empty answers)

NPM scripts:
- Build only:
  npm run build
- Driver (defaults: source 'longmemeval_s*', split Accurate_Retrieval, seed 42):
  npm run bench:mab:driver
- Scorer (uses OpenAI judge gpt-4o by default):
  npm run bench:mab:score
- End-to-end (build + driver + scorer):
  npm run bench:mab:smoke

Direct shell:
- End-to-end with optional limit for quick smoke:
  bash benchmarks/runners/run_memoryagentbench.sh --source 'longmemeval_s*' --split Accurate_Retrieval --seed 42 --limit 10
  # If OPENAI_API_KEY is not set, the scorer step is skipped.

Outputs:
- Predictions JSON: outputs/memora/Accurate_Retrieval/longmemeval_s*_SEED42.json
- Eval results (JSONL): outputs/memora/Accurate_Retrieval/.eval-results-memora-longmemeval_s*_SEED42
- Logs: benchmarks/logs/

Notes:
- The driver reuses Memora MCP tools via MemoryAdapter and packing.yaml to build a compact retrieval context.
- With no OPENAI_API_KEY, predictions contain empty output; this is still useful to verify plumbing and reference alignment.
