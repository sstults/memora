# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Memora is an MCP (Model Context Protocol) server that provides long-term memory and context management for LLM-driven workflows. It stores and retrieves memories through episodic logs, semantic embeddings, and structured facts using OpenSearch as the backing store.

**Current branch**: `feature/promotion` - This implements promotion features on top of the Minimal POC.

**Main branch policy**: The `main` branch implements only the Minimal POC scope (episodic write + lexical BM25 retrieval). Advanced features like semantic search, facts, fusion/RRF, reranking, and promotion are disabled by default and should be developed in feature branches.

## Development Commands

### Setup
```bash
# Install dependencies
npm install

# Start OpenSearch (required for integration tests and local dev)
docker compose -f docker/docker-compose.yml up -d

# Create indices manually (alternative to MEMORA_BOOTSTRAP_OS)
./scripts/create_indices.sh

# Configure environment
cp .env.example .env
# Edit .env to set OPENSEARCH_URL and other variables
```

### Running
```bash
# Development mode (with hot reload via ts-node)
npm run dev

# Build TypeScript to dist/
npm run build

# Run built version
npm start

# Start as MCP server (used by Cline/Claude Code integration)
npm run mcp
```

### Testing
```bash
# Type check only
npm run typecheck

# Run unit tests only (fast, no external dependencies)
npm run test:unit

# Run integration tests (requires OpenSearch running)
INTEGRATION=1 npm run test:integration

# Helper script for integration tests (recommended)
bash scripts/run_integration.sh
# With search pipeline attached:
bash scripts/run_integration.sh --attach

# Watch mode
npm run test:watch

# Coverage report
npm run coverage

# All tests
npm test
```

### Development Tools
```bash
# Linting and formatting
npm run lint
npm run format

# Trace and diagnostics
npm run dev:trace:episodic           # View episodic index traces
npm run dev:trace:episodic:follow    # Follow traces in real-time
npm run dev:trace:filter             # Filter trace files
npm run dev:trace:stats              # Show trace statistics

# Smoke tests
npm run smoke:write                  # Test memory write
npm run smoke:retrieve               # Test memory retrieval

# Seed demo data
npm run seed:demo
```

## Architecture

### Core Components

**MCP Server Entry Point** (`src/index.ts`)
- Initializes the MCP server and registers tool routes
- Handles OpenSearch bootstrap if `MEMORA_BOOTSTRAP_OS=1`
- Connects via stdio transport for MCP communication

**Routes** (`src/routes/`)
- `context.ts`: Context management (set/get/ensure/clear context per tenant/project/task)
- `memory.ts`: Core memory operations (write/retrieve/promote/autopromote)
- `pack.ts`: Prompt packing based on token budgets
- `eval.ts`: Evaluation metrics logging

**Services** (`src/services/`)
- `os-client.ts`: OpenSearch client with retry logic and health checks
- `os-bootstrap.ts`: Index template application and health gating
- `os-ml.ts`: OpenSearch ML Commons integration (pipelines, models, reranking)
- `embedder.ts`: Embedding generation (HTTP endpoint or deterministic fallback)
- `rerank.ts`: Reranking service (HTTP, OpenSearch ML, or local fallback)
- `salience.ts`: Salience scoring, splitting, summarization, redaction
- `packer.ts`: Prompt packing with configurable budgets
- `config.ts`: YAML config loading (retrieval, memory policies, packing)
- `ids.ts`: ID generation and validation
- `log.ts`: Debug logging

**Domain** (`src/domain/`)
- `types.ts`: Core type definitions (Context, Event, RetrievalQuery, etc.)
- `filters.ts`: OpenSearch query filter builders
- `fusion.ts`: RRF fusion, MMR diversity, deduplication

**Configuration** (`config/`)
- `retrieval.yaml`: Multi-stage retrieval settings (episodic/semantic/facts, fusion, rerank, diversity, lexical tuning, time decay, diagnostics gating)
- `memory_policies.yaml`: Salience thresholds, redaction patterns, summarization rules
- `packing.yaml`: Token budgets for prompt sections

### Data Flow

1. **Write Path**: `memory.write` → salience filtering → episodic log + semantic chunks + facts → OpenSearch
2. **Retrieval Path**: `memory.retrieve` → episodic BM25 + semantic kNN + facts → fusion (RRF) → diversity (MMR) → optional rerank → snippets
3. **Context**: All memory operations require context to be set via `context.set_context` or `context.ensure_context`

### Index Strategy

- **Episodic**: Time-series indices `mem-episodic-YYYY-MM-DD` for raw event logs
- **Semantic**: Single index `mem-semantic` (or aliased) for embedded chunks with kNN search
- **Facts**: Single index `mem-facts` for structured entity/relation triples
- **Idempotency**: `mem-idempotency` index for write deduplication
- **Metrics**: `mem-metrics` for eval.log entries

## Key Concepts

### Context Management
Memora uses hierarchical context scoping:
- **tenant_id**: Top-level isolation (organization/user)
- **project_id**: Project within a tenant
- **context_id**: Specific conversation or session
- **task_id**: Individual task within a context

Always call `context.set_context` or `context.ensure_context` before memory operations.

### Retrieval Configuration
The retrieval pipeline is controlled by `config/retrieval.yaml`:
- **Stages**: episodic (BM25), semantic (kNN), facts (structured)
- **Fusion**: RRF (Reciprocal Rank Fusion) to combine results
- **Diversity**: MMR (Maximal Marginal Relevance) to reduce redundancy
- **Rerank**: Optional cross-encoder reranking (via HTTP or OpenSearch ML)
- **Diagnostics**: Gated trace output (enable with `MEMORA_DIAGNOSTICS=1`)

### Feature Flags
Many advanced features are disabled by default on `main`:
- `MEMORA_EMBED_PROVIDER=opensearch_pipeline`: Use OpenSearch ML for embeddings
- `MEMORA_RERANK_ENABLED=true`: Enable reranking stage
- `MEMORA_BOOTSTRAP_OS=1`: Auto-bootstrap indices/templates on startup
- `MEMORA_DIAGNOSTICS=1`: Enable verbose trace output
- `INTEGRATION=1`: Enable integration tests

### Branching Model (Strict)
- **main**: Minimal POC only (episodic + BM25). Do NOT enable semantic/facts/rerank/promotion by default.
- **archive/full-featured**: Read-only snapshot of pre-slimdown code
- **feature/\***: Isolated feature development (keep defaults OFF)
- **hotfix/\***: Emergency fixes to main

See `docs/branch-governance.md` for full policy.

## Testing Strategy

### Unit Tests (`tests/unit/`)
Fast, isolated tests with no external dependencies:
- Domain logic (filters, fusion, salience, packer)
- Uses deterministic fallback embedder (no HTTP calls)
- Run with: `npm run test:unit`

### Integration Tests (`tests/integration/`)
Requires OpenSearch running:
- Real index operations (write, retrieve, promote)
- Validates end-to-end flows
- Run with: `INTEGRATION=1 npm run test:integration` or `bash scripts/run_integration.sh`

### E2E Tests (`tests/e2e/`)
MCP tool surface validation (currently minimal):
- In-process tests with mocked OpenSearch
- Run with: `E2E=1 npm run test:e2e`

## Important Files

- `src/routes/memory.ts`: Core memory tool implementations - main API surface
- `src/services/os-client.ts`: OpenSearch operations with retry/health logic
- `config/retrieval.yaml`: Retrieval behavior configuration
- `docs/branch-governance.md`: Branching and merge policy (MUST READ before PRs to main)
- `docs/agent-integration.md`: MCP tool catalog and agent workflows
- `docs/retrieval-tuning.md`: Guidance for tuning retrieval parameters
- `.env.example`: All available environment variables with examples

## Environment Variables

Key variables (see `.env.example` for complete list):

- **OpenSearch**: `OPENSEARCH_URL` (required, e.g., `http://localhost:9200`)
- **Bootstrap**: `MEMORA_BOOTSTRAP_OS=1` to auto-create indices
- **Embeddings**: `EMBEDDING_ENDPOINT` (optional, falls back to deterministic hash)
- **Embedding Provider**: `MEMORA_EMBED_PROVIDER=opensearch_pipeline` for ML Commons
- **Reranking**: `MEMORA_RERANK_ENABLED=true`, `RERANK_ENDPOINT`, `OPENSEARCH_ML_RERANK_MODEL_ID`
- **Diagnostics**: `MEMORA_DIAGNOSTICS=1` for verbose traces
- **Index names**: `MEMORA_SEMANTIC_INDEX`, `MEMORA_FACTS_INDEX`, `MEMORA_EPI_PREFIX`

## Common Workflows

### Adding a New Feature
1. Create feature branch: `git checkout -b feature/my-feature`
2. Keep feature disabled by default (config flags OFF)
3. Add unit tests in `tests/unit/`
4. Add integration tests in `tests/integration/` with `INTEGRATION=1` guard
5. Update `docs/pr-notes.md` with operator-facing changes
6. If changing main, verify Minimal POC invariants (see `docs/branch-governance.md`)

### Modifying Retrieval Behavior
1. Edit `config/retrieval.yaml` for declarative changes
2. For algorithmic changes, edit `src/routes/memory.ts` (retrieval logic) or `src/domain/fusion.ts`
3. Add test cases in `tests/unit/domain/fusion.spec.ts` or `tests/integration/memory.spec.ts`
4. Use trace tools to validate: `npm run dev:trace:episodic:follow`

### Debugging Retrieval
1. Enable diagnostics: `export MEMORA_DIAGNOSTICS=1`
2. Run retrieval: `npm run smoke:retrieve`
3. Inspect traces: `npm run dev:trace:filter` or `npm run dev:trace:stats`
4. Check OpenSearch queries in trace file: `outputs/memora/trace/retrieve.ndjson`

### Running Benchmarks
Benchmark scripts are in `benchmarks/` (may be on feature branches or archive):
- Typically use `longmemeval` or similar datasets
- Check `benchmarks/reports/` for existing evaluation results
- Benchmark runner scripts may be in `scripts/dev/` or `benchmarks/scripts/`

## CI/CD

### GitHub Actions
- `.github/workflows/ci.yml`: Runs lint, build, unit tests, and integration tests
- `.github/workflows/release.yml`: Tag-driven releases (push `v*.*.*` tags)

### Pre-commit Hooks
Husky is configured for pre-commit checks (lint, typecheck).

## MCP Integration

To use Memora with Cline or other MCP clients, add to your MCP config:

```json
{
  "mcpServers": {
    "memora": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolute/path/to/memora",
      "env": {
        "OPENSEARCH_URL": "http://localhost:9200",
        "MEMORA_BOOTSTRAP_OS": "1"
      }
    }
  }
}
```

## Notes for Future Claude Instances

- **Always check branch**: If on `main`, respect Minimal POC constraints. If on `feature/*`, feature flags may be enabled.
- **Read git status first**: Modified files indicate active work context.
- **Consult `docs/branch-governance.md`**: Before any PR to main.
- **Use trace tools**: Diagnose retrieval issues with built-in trace scripts.
- **Test isolation**: Unit tests are fast and self-contained. Integration tests need OpenSearch.
- **Config-first**: Prefer YAML config changes over code changes when possible.
- **Idiomatic TypeScript**: Use strict typing, ESM imports, async/await patterns.
