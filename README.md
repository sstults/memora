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
git clone https://github.com/sstults/memora.git
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
# Set OPENSEARCH_URL (e.g., http://localhost:19200 for local Docker Compose) and optionally EMBEDDING_ENDPOINT
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
  - MEMORA_EMBED_DIM: expected embedding dim (default 384; matches config/index-templates/mem-semantic.json).
  - MEMORA_OS_AUTOFIX_VECTOR_DIM: if true, auto-adjusts knn_vector dimension in loaded mappings to MEMORA_EMBED_DIM.
- Index naming:
  - MEMORA_SEMANTIC_INDEX (default: mem-semantic; alias recommended to mem-semantic-384)
  - MEMORA_FACTS_INDEX (default: mem-facts)
  - MEMORA_EPI_PREFIX (default: mem-episodic-)
  - MEMORA_IDEMP_INDEX (default: mem-idempotency) for idempotent write records
  - MEMORA_BOOTSTRAP_CREATE_TODAY: if true, also ensures today's episodic index (prefix + YYYY-MM-DD).

- Retries/Timeouts:
  - MEMORA_OS_MAX_RETRIES: maximum retry attempts for OpenSearch operations (default: 3).
  - MEMORA_OS_REQUEST_TIMEOUT_MS: request timeout in milliseconds for OpenSearch client (default: 10000).

Example:
```bash
export OPENSEARCH_URL=http://localhost:19200
export MEMORA_BOOTSTRAP_OS=1
export MEMORA_OS_MIN_HEALTH=yellow
export MEMORA_OS_HEALTH_TIMEOUT_MS=30000
export MEMORA_EMBED_DIM=384
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
        "OPENSEARCH_URL": "http://localhost:19200",
        "MEMORA_BOOTSTRAP_OS": "1"
      }
    }
  }
}
```

Notes:
- Set OPENSEARCH_URL to your OpenSearch endpoint. For local Docker Compose: http://localhost:19200
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
    { "texts": ["hello world", "another"], "dim": 384 }
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

- Helper script (recommended for local dev):
  ```bash
  # Sets required env safely and runs the integration suite
  bash scripts/run_integration.sh

  # Also attach the search pipeline as index.search.default_pipeline
  bash scripts/run_integration.sh --attach
  ```

- Search pipeline provisioning example (idempotency + optional default attachment):
  ```bash
  # With OpenSearch running and indices created (see above), run:
  INTEGRATION=1 \
  MEMORA_EMBED_PROVIDER=opensearch_pipeline \
  MEMORA_SEMANTIC_INDEX=mem-semantic \
  MEMORA_OS_SEARCH_PIPELINE_NAME=mem-search \
  MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=false \
  MEMORA_OS_SEARCH_PIPELINE_BODY_JSON='{"request_processors":[{"filter_query":{"description":"integration smoke","query":{"match_all":{}}}}],"response_processors":[]}' \
  npm run test:integration

  # To also assert default attachment, set:
  # MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true
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
  - OpenSearch at `OPENSEARCH_URL` (local Docker Compose default `http://localhost:19200`; CI default `http://localhost:9200`)
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

## Embeddings via OpenSearch ML Pipelines (optional)

You can use OpenSearch ML Commons to generate embeddings inside the cluster via pipelines. This reduces app-side complexity and HTTP calls.

Requirements:
- OpenSearch 3.2+ with ML Commons, Neural Search, and k-NN plugins
- An ONNX embedding model registered and deployed (e.g., MiniLM-L6 384-dim)

Environment configuration:
- Provider selection
  - MEMORA_EMBED_PROVIDER=opensearch_pipeline
- Model configuration (defaults shown for local/dev)
  - OPENSEARCH_ML_MODEL_NAME=huggingface/sentence-transformers/all-MiniLM-L6-v2
  - OPENSEARCH_ML_MODEL_VERSION=1.0.2
  - OPENSEARCH_ML_MODEL_FORMAT=ONNX
  - OPENSEARCH_ML_MODEL_ID=<your_deployed_model_id>  <!-- required to create/update the ingest pipeline -->
  - MEMORA_OS_APPLY_DEV_ML_SETTINGS=true|false
- Pipelines
  - MEMORA_OS_INGEST_PIPELINE_NAME=mem-text-embed
  - MEMORA_OS_TEXT_SOURCE_FIELD=text
  - MEMORA_OS_EMBED_FIELD=embedding
  - MEMORA_OS_DEFAULT_PIPELINE_ATTACH=false
- Vector dim alignment
  - MEMORA_EMBED_DIM should match your model output dimension (MiniLM-L6 ONNX is 384)
  - MEMORA_OS_AUTOFIX_VECTOR_DIM=true can auto-adjust loaded mappings to the expected dimension

Bootstrap provisioning:
- When MEMORA_BOOTSTRAP_OS=1 and MEMORA_EMBED_PROVIDER=opensearch_pipeline, Memora will on startup:
  - Optionally apply dev ML settings when MEMORA_OS_APPLY_DEV_ML_SETTINGS=true
  - Create or update the ingest pipeline (MEMORA_OS_INGEST_PIPELINE_NAME) using OPENSEARCH_ML_MODEL_ID, mapping MEMORA_OS_TEXT_SOURCE_FIELD → MEMORA_OS_EMBED_FIELD
  - Optionally attach that ingest pipeline as the index default_pipeline when MEMORA_OS_DEFAULT_PIPELINE_ATTACH=true

What remains manual:
1) Register and deploy the model via ML Commons to obtain OPENSEARCH_ML_MODEL_ID (ONNX recommended for dev resource usage).
2) Ensure your semantic index mapping uses knn_vector with the correct dimension (e.g., 384) or set MEMORA_OS_AUTOFIX_VECTOR_DIM=true to auto-adjust loaded bodies at bootstrap time.

Notes:
- The text_embedding ingest processor on 3.2 does not support token_limit.
- A search-time pipeline is available to embed queries server-side using search processors. Configure MEMORA_OS_SEARCH_PIPELINE_NAME, MEMORA_OS_SEARCH_PIPELINE_BODY_JSON, and set MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true to attach as the index.search.default_pipeline. See .env.example for examples and the OpenSearch docs for processor shapes.

### Search pipeline examples (shapes vary by OpenSearch version; consult official docs)

Example A — Request-time query embedding (ml_inference request processor):
```json
{
  "request_processors": [
    {
      "ml_inference": {
        "description": "Embed query and stash vector for kNN/neural",
        "model_id": "YOUR_EMBED_MODEL_ID",
        "input_map": { "text": "params.query_text" },
        "output_map": { "vector": "ctx.query_vector" }
      }
    }
  ],
  "response_processors": []
}
```
Notes:
- Supply a query_text parameter to the pipeline (see OpenSearch docs for passing pipeline params).
- Your search body can then reference the embedded vector (ctx.query_vector) in a neural/kNN query as supported by your version.

Example B — Response-time reranking:
```json
{
  "request_processors": [],
  "response_processors": [
    {
      "rerank": {
        "description": "Cross-encoder rerank of top_k hits",
        "model_id": "YOUR_RERANK_MODEL_ID",
        "top_k": 50
      }
    }
  ]
}
```

### search_pipeline parameter vs index.search.default_pipeline

- Using the search_pipeline query parameter:
  - Specify the pipeline on a per-request basis without changing index settings.
  - Useful for A/B testing or gradual rollouts.
  - Does not require index privileges to modify settings.

- Attaching index.search.default_pipeline:
  - The pipeline runs transparently for all searches on that index.
  - Use MEMORA_OS_SEARCH_DEFAULT_PIPELINE_ATTACH=true with ensureSearchPipelineFromEnv or call attachDefaultSearchPipelineToIndex().
  - Best for consistent behavior across all queries once validated.

## Release (GitHub-only)

This repository uses a tag-driven GitHub Actions workflow located at `.github/workflows/release.yml`. It runs automatically when you push a tag matching `v*.*.*` (for example, `v0.1.0`). The workflow:
- Installs dependencies
- Lints
- Builds
- Runs unit tests
- Packs an npm tarball (`memora-*.tgz`) for convenience
- Creates a GitHub Release with auto-generated notes and attaches the tarball

Release steps:
1) Ensure main is green (CI passing)
2) Bump version and create a tag (SemVer):
   ```bash
   npm version patch   # or: minor | major
   ```
3) Push commit and tag:
   ```bash
   git push --follow-tags
   ```
4) The Release workflow will run and publish the GitHub Release. You can edit release notes in the GitHub UI if desired.

Notes:
- Integration tests are covered in `.github/workflows/ci.yml` (separate job). Ensure CI is healthy before tagging.
- No npm publish is performed; artifacts are attached to the GitHub Release only.
