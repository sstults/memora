import { beforeAll } from "vitest";
/* Vitest global setup for Memora tests.
 * - Keep Node fetch available (Node 20+)
 * - Set sane default envs for deterministic behavior
 * - Ensure working directory is project root so relative config paths resolve
 */

process.env.TZ = "UTC";

// Keep remote services disabled by default in unit tests
process.env.EMBEDDING_ENDPOINT = process.env.EMBEDDING_ENDPOINT || "";
process.env.MEMORA_RERANK_ENABLED = process.env.MEMORA_RERANK_ENABLED || "false";

// OpenSearch defaults for integration tests (may be overridden in CI)
process.env.OPENSEARCH_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";

// Reduce noisy logs during tests
const origWarn = console.warn;
console.warn = (...args: any[]) => {
  if (String(args[0] ?? "").includes("[embedder] remote endpoint failed")) return;
  origWarn(...args);
};

// Integration test readiness gate and client tuning
if (process.env.INTEGRATION === "1") {
  process.env.MEMORA_OS_MIN_HEALTH = process.env.MEMORA_OS_MIN_HEALTH || "yellow";
  process.env.MEMORA_OS_HEALTH_TIMEOUT_MS = process.env.MEMORA_OS_HEALTH_TIMEOUT_MS || "120000";
  process.env.MEMORA_OS_CLIENT_TIMEOUT_MS = process.env.MEMORA_OS_CLIENT_TIMEOUT_MS || "30000";
  process.env.MEMORA_OS_CLIENT_MAX_RETRIES = process.env.MEMORA_OS_CLIENT_MAX_RETRIES || "5";
  // Use default local OpenSearch port unless explicitly overridden
  process.env.OPENSEARCH_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";

  // Defer import to avoid pulling client in unit runs
  const gate = async () => {
    const mod = await import("../src/services/os-client");
    await mod.assertHealthy();
  };

  beforeAll(async () => {
    await gate();
  }, 120000);
}
