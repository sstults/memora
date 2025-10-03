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

3) Start MCP
```bash
cp .env.example .env  # set OPENSEARCH_URL, EMBEDDING_ENDPOINT
npm i && npm run dev
```

---

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
- E2E tests (MCP tool surface): process-level tests invoking registered tools end-to-end
  - Skeleton provided; can be enabled with `E2E=1` when server launch harness is added

### Environment for tests
- Unit tests do not require external services. `embedder` uses deterministic local fallback when `EMBEDDING_ENDPOINT` is unset.
- Integration tests require:
  - OpenSearch at `OPENSEARCH_URL` (default `http://localhost:9200`)
  - Index templates applied via `scripts/create_indices.sh`

### CI
GitHub Actions workflow at `.github/workflows/ci.yml` runs:
- Install, lint, build, unit tests, coverage summary

To run integration tests in CI, add a follow-up job that:
- Starts OpenSearch service (or uses Docker Compose)
- Waits for health, applies index templates
- Runs `INTEGRATION=1 npm run test:integration`

### Developer Notes
- Redaction patterns live in `config/memory_policies.yaml`
- Packing budgets and compression rules in `config/packing.yaml`
- Retrieval configuration in `config/retrieval.yaml`
- Tests are located under `tests/`:
  - `tests/unit/**`
  - `tests/integration/**` (guarded by `INTEGRATION=1`)
  - `tests/e2e/**` (guarded by `E2E=1`)
