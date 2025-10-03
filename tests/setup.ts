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
