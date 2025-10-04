# Memora

**Memora** is a developer-friendly [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol) server that provides **long-term memory and context management** for LLM-driven workflows.  

It is designed to support **long-running tasks, multi-project contexts, and collaborative agents**, while keeping the implementation simple and extensible.

---

## Features

- **Context Management**
  - Switch between projects, tasks, and environments (`context.set_context`, `context.get_context`).
- **Memory Write & Retrieval**
  - Store events into episodic, semantic, and fact stores.
  - Retrieve using BM25, k-NN embeddings, and structured fact lookups.
- **Salience Filtering**
  - Score snippets, summarize if long, redact sensitive data before storage.
- **Fusion & Reranking**
  - Fuse episodic/semantic/fact results with RRF + MMR diversity.
  - Optional cross-encoder reranking via HTTP service.
- **Prompt Packing**
  - Configurable budgets for system/task/tools/retrieved/turns.
  - Lightweight compression to stay within model token limits.
- **Config via YAML**
  - Memory policies, packing strategies, and retrieval stages all live under `config/`.

---

## Getting Started

### Requirements
- Node.js 20+
- Docker + docker-compose (for OpenSearch)

### Install
```bash
git clone https://github.com/your-org/memora.git
cd memora
npm install
```

## Run OpenSearch (local)
```bash
docker compose -f docker/docker-compose.yml up -d
```

## Dev Server
```bash
cp .env.example .env
# Set OPENSEARCH_URL (e.g., http://localhost:9200) and optionally EMBEDDING_ENDPOINT
npm run dev
```

## Build & Run
```bash
npm run build
npm start
```

## Dev Quickstart

1) Dev OpenSearch + Dashboards
```bash
docker compose -f docker/docker-compose.yml up -d
```

2) Create indices
```bash
./scripts/create_indices.sh
```

3) Seed demo data (optional)
```bash
npm run seed:demo
```

4) Start MCP
```bash
cp .env.example .env  # set OPENSEARCH_URL, EMBEDDING_ENDPOINT
npm i && npm run dev
```

### OpenSearch bootstrap and health gating

Memora can automatically gate on OpenSearch cluster health and bootstrap templates/indices at startup.

- Health gating:
  - MEMORA_OS_MIN_HEALTH: "yellow" | "green" (default: yellow). Uses cluster.health wait_for_status.
  - MEMORA_OS_HEALTH_TIMEOUT_MS: number (default: 30000).
- Bootstrap (env-gated):
  - MEMORA_BOOTSTRAP_OS: set to 1 or true to enable bootstrap at startup.
  - Applies episodic index template and ensures base indices exist idempotently.
- Vector dim validation:
  - MEMORA_EMBED_DIM: expected embedding dim (default 1024; matches config/index-templates/mem-semantic.json).
  - MEMORA_OS_AUTOFIX_VECTOR_DIM: if true, auto-adjusts knn_vector dimension in loaded mappings to MEMORA_EMBED_DIM.
- Index naming:
  - MEMORA_SEMANTIC_INDEX (default: mem-semantic)
  - MEMORA_FACTS_INDEX (default: mem-facts)
  - MEMORA_EPI_PREFIX (default: mem-episodic-)
  - MEMORA_IDEMP_INDEX (default: mem-idempotency) for idempotent write records
  - MEMORA_BOOTSTRAP_CREATE_TODAY: if true, also ensures today's episodic index (prefix + YYYY-MM-DD).

- Retries/Timeouts:
  - MEMORA_OS_MAX_RETRIES: maximum retry attempts for OpenSearch operations (default: 3).
  - MEMORA_OS_REQUEST_TIMEOUT_MS: request timeout in milliseconds for OpenSearch client (default: 10000).

Example:
```bash
export OPENSEARCH_URL=http://localhost:9200
export MEMORA_BOOTSTRAP_OS=1
export MEMORA_OS_MIN_HEALTH=yellow
export MEMORA_OS_HEALTH_TIMEOUT_MS=30000
export MEMORA_EMBED_DIM=1024
# Optional auto-fix if your template's knn_vector dim differs
# export MEMORA_OS_AUTOFIX_VECTOR_DIM=true

npm run dev
```

Manual alternative (legacy):
```bash
./scripts/create_indices.sh
```

---
 
## Feature flags and defaults

- Embeddings
  - EMBEDDING_ENDPOINT: optional. If unset, Memora uses a deterministic local hash-based embedder suitable for tests and development. Set an HTTP endpoint returning {vectors: number[][]} for production.
- Reranking
  - MEMORA_RERANK_ENABLED: default false. When true, Memora performs a rerank step after fusion.
  - RERANK_ENDPOINT: optional HTTP service for rerank. If provided, Memora POSTs {query, candidates} and expects {scores}. If not provided, a lightweight local fallback reranker is used. When MEMORA_RERANK_ENABLED is false, no rerank step runs.
- Eval mirroring
  - MEMORA_EVAL_EPISODIC_MIRROR: default false. When true, eval.log entries are mirrored to the episodic log as small events for easy timeline inspection.

Example:
```bash
# Optional features
export MEMORA_RERANK_ENABLED=true
export RERANK_ENDPOINT=http://localhost:8081/rerank
export MEMORA_EVAL_EPISODIC_MIRROR=true
```

## Minimal API

Tools and shapes (request params in MCP tool calls):
- context.set_context
  - Request: { tenant_id, project_id, context_id, task_id, env, api_version }
  - Response: { ok: true, context } (or error on missing tenant_id/project_id)
- context.get_context
  - Response: { ok: true, context } or { ok: false, message }
- memory.write
  - Request: { role, content, tags?, artifacts?, task_id?, idempotency_key?, hash? }
  - Response: { ok: true, event_id, semantic_upserts, facts_upserts }
- memory.retrieve
  - Request: {
      objective,
      budget?,
      filters?: { scope: string[], tags?, api_version?, env? },
      task_id?, context_id?
    }
  - Response: { snippets: [{ id, text, score, source, tags, why, context }] }
- memory.promote
  - Request: { mem_id, to_scope }
  - Response: { ok: true, mem_id, scope }
- eval.log
  - Request: { step, success, tokens_in, latency_ms, cost_usd?, retrieved_ids?, p_at_k?, groundedness? }
  - Response: { ok: true, id }

Examples:
- Set context
  ```json
  {
    "params": {
      "tenant_id": "acme",
      "project_id": "memora",
      "context_id": "ctx-1",
      "task_id": "task-42",
      "env": "prod",
      "api_version": "3.1"
    }
  }
  ```
- Retrieve
  ```json
  {
    "params": {
      "objective": "FeatureA introduced_in v1_0",
      "budget": 8,
      "filters": { "scope": ["this_task", "project"] }
    }
  }
  ```

---
 
## Cline Integration

Add Memora as an MCP server in Cline and run it with your local OpenSearch.

mcpServers configuration (add this to your Cline MCP servers configuration):
```json
{
  "mcpServers": {
    "memora": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/your/memora/repo",
      "env": {
        "OPENSEARCH_URL": "http://localhost:9200",
        "MEMORA_BOOTSTRAP_OS": "1"
      }
    }
  }
}
```

Notes:
- Set OPENSEARCH_URL to your OpenSearch endpoint. For local Docker: http://localhost:9200
- MEMORA_BOOTSTRAP_OS=1 will idempotently apply index templates and ensure base indices on first run; remove after bootstrap if desired.
- For deterministic local embeddings in development, leave EMBEDDING_ENDPOINT unset. To use a remote service, set EMBEDDING_ENDPOINT in env.
- The npm script "mcp" starts only the MCP server entrypoint (no seeding or side effects).

60-second first-run checklist:
1) Start OpenSearch
   - docker compose -f docker/docker-compose.yml up -d
2) Configure environment
   - cp .env.example .env
   - Set OPENSEARCH_URL (and optionally EMBEDDING_ENDPOINT)
   - Optionally export MEMORA_BOOTSTRAP_OS=1 for first run
3) Add the MCP server in Cline using the config above (ensure "cwd" points to this repo)
4) Start the server in Cline
5) Quick smoke (via Cline tools):
   - context.set_context → expect { ok: true }
   - memory.write → small log line
   - memory.retrieve → expect at least one snippet
   - memory.promote → on a returned mem:* id
   - eval.log → simple metrics object

## Developer Services (Mocks)

For local development without external services, you can run lightweight mock servers for embeddings and reranking.

- Start mock embedder (HTTP):
  ```bash
  npm run dev:embedder
  # listens on http://localhost:8080
  ```
  - API: POST /embed with
    ```json
    { "texts": ["hello world", "another"], "dim": 1024 }
    ```
    Response:
    ```json
    { "vectors": [[...], [...]] }
    ```
  - Example:
    ```bash
    curl -s http://localhost:8080/embed -H 'Content-Type: application/json' -d '{"texts":["hello world"],"dim":16}' | jq
    ```

- Start mock reranker (HTTP):
  ```bash
  npm run dev:reranker
  # listens on http://localhost:8081
  ```
  - API: POST /rerank with
    ```json
    { "query": "your objective", "candidates": [ { "id": "a", "text": "..." } ] }
    ```
    Response:
    ```json
    { "scores": [0.42, 0.13, ...] }
    ```
  - Example:
    ```bash
    curl -s http://localhost:8081/rerank -H 'Content-Type: application/json' -d '{"query":"hello world","candidates":[{"id":"a","text":"hello"},{"id":"b","text":"planet"}]}' | jq
    ```

Environment examples:
- Embeddings: leave EMBEDDING_ENDPOINT unset to use Memora’s deterministic local fallback, or point it at the mock embedder:
  ```bash
  export EMBEDDING_ENDPOINT=http://localhost:8080/embed
  ```
- Reranker: enable reranking and point to the mock reranker:
  ```bash
  export MEMORA_RERANK_ENABLED=true
  export RERANK_ENDPOINT=http://localhost:8081/rerank
  ```

Notes:
- The mock services are deterministic and meant for development and tests; they do not provide semantic quality but ensure stable shapes and latency.

## Testing

This repo uses Vitest for unit, integration, and e2e test layers.

### Commands
- Run all unit tests:
  ```bash
  npm run test:unit
  ```
- Run integration tests (require OpenSearch running, indices created):
  ```bash
  # Start OpenSearch locally
  docker compose -f docker/docker-compose.yml up -d
  # Create indices from templates
  ./scripts/create_indices.sh
  # Enable integration test run
  INTEGRATION=1 npm run test:integration
  ```
- Run e2e tests (skeleton, off by default):
  ```bash
  E2E=1 npm run test:e2e
  ```
- Watch mode:
  ```bash
  npm run test:watch
  ```
- Coverage:
  ```bash
  npm run coverage
  ```

### Structure and Scope
- Unit tests: fast, isolated validation of domain logic and services
  - `src/domain/filters.ts` → boolean filters for OS queries
  - `src/domain/fusion.ts` → RRF fusion, MMR diversity, dedupe
  - `src/services/salience.ts` → salience scoring, splitting, summarization, redaction
  - `src/services/packer.ts` → prompt packing, budgets, compression
- Integration tests: require OpenSearch
  - Validates `memory.write`, `memory.retrieve`, and `memory.promote` shapes and side-effects
  - Uses local OpenSearch via Docker Compose; indices created by `scripts/create_indices.sh`
- E2E tests (MCP tool surface): in-process tests invoking registered tools; OpenSearch is mocked
  - Basic suite provided at `tests/e2e/mcp.e2e.spec.ts`; enable with `E2E=1`

### Environment for tests
- Unit tests do not require external services. `embedder` uses deterministic local fallback when `EMBEDDING_ENDPOINT` is unset.
- Integration tests require:
  - OpenSearch at `OPENSEARCH_URL` (default `http://localhost:9200`)
  - Index templates applied via `scripts/create_indices.sh`

### CI
GitHub Actions workflow at `.github/workflows/ci.yml` runs:
- Install, lint, build, unit tests, coverage summary

Integration tests in CI:
- The Integration Tests job in `.github/workflows/ci.yml` starts OpenSearch, waits for health, applies index templates, and runs `INTEGRATION=1 npm run test:integration`.

### Developer Notes
- Redaction patterns live in `config/memory_policies.yaml`
- Packing budgets and compression rules in `config/packing.yaml`
- Retrieval configuration in `config/retrieval.yaml`
- Tests are located under `tests/`:
  - `tests/unit/**`
  - `tests/integration/**` (guarded by `INTEGRATION=1`)
  - `tests/e2e/**` (guarded by `E2E=1`)
