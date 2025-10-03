// src/services/os-client.ts
// OpenSearch client factory + small helpers (singleton).
// Env:
//   OPENSEARCH_URL (default: http://localhost:9200)
//   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional)
//   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false (optional; for self-signed local dev)
//   MEMORA_OS_MAX_RETRIES=3
//   MEMORA_OS_REQUEST_TIMEOUT_MS=10000

import { Client } from "@opensearch-project/opensearch";

let _client: Client | null = null;

export function getClient(): Client {
  if (_client) return _client;

  const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
  const username = process.env.OPENSEARCH_USERNAME;
  const password = process.env.OPENSEARCH_PASSWORD;
  const rejectUnauthorized = (process.env.OPENSEARCH_SSL_REJECT_UNAUTHORIZED ?? "true") !== "false";
  const maxRetries = Number(process.env.MEMORA_OS_MAX_RETRIES ?? 3);
  const requestTimeout = Number(process.env.MEMORA_OS_REQUEST_TIMEOUT_MS ?? 10000);

  // Build client opts
  const opts: any = {
    node,
    maxRetries,
    requestTimeout,
    ssl: { rejectUnauthorized }
  };
  if (username && password) {
    opts.auth = { username, password };
  }

  _client = new Client(opts);
  return _client;
}

/** Quick ping to verify connectivity; throws with a friendly message on failure. */
export async function assertHealthy(): Promise<void> {
  const client = getClient();
  try {
    const res = await client.ping();
    if (!res) throw new Error("OpenSearch ping returned false");
  } catch (err: any) {
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    throw new Error(`Unable to reach OpenSearch at ${node}. Is Docker up and indices created? Root cause: ${err?.message || err}`);
  }
}

/** Ensure an index exists; if not, create with provided body (mappings/settings). */
export async function ensureIndex(name: string, body?: Record<string, any>): Promise<void> {
  const client = getClient();
  const exists = await client.indices.exists({ index: name });
  if (!exists) {
    await client.indices.create({ index: name, body });
  }
}

/** Apply (or overwrite) an index template by name. */
export async function putIndexTemplate(name: string, templateBody: Record<string, any>): Promise<void> {
  const client = getClient();
  await client.indices.putIndexTemplate({ name, body: templateBody });
}

/** Lightweight bulk helper with basic error surfacing. */
export async function bulkSafe(body: any[], refresh: "true" | "false" | "wait_for" = "false"): Promise<void> {
  if (!Array.isArray(body) || body.length === 0) return;
  const client = getClient();
  const resp = await client.bulk({ body, refresh });
  if (resp.errors) {
    const failed = (resp.items || []).filter((i: any) => {
      const op = Object.keys(i)[0] as keyof typeof i;
      return (i[op] as any)?.error;
    }).slice(0, 3);
    throw new Error(`OpenSearch bulk had errors (showing first 3): ${JSON.stringify(failed)}`);
  }
}

/** Small retry wrapper for transient ops (connection/reset). */
export async function withRetries<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 150): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const jitter = Math.floor(Math.random() * 100);
      const delay = Math.min(2000, baseDelayMs * Math.pow(2, i)) + jitter;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Convenience search with retries. */
export async function searchWithRetries(params: Parameters<Client["search"]>[0], attempts = 3) {
  const client = getClient();
  return withRetries(() => client.search(params as any), attempts);
}

/** Convenience index with retries. */
export async function indexWithRetries(params: Parameters<Client["index"]>[0], attempts = 3) {
  const client = getClient();
  return withRetries(() => client.index(params as any), attempts);
}
