// src/services/os-client.ts
// OpenSearch client factory + small helpers (singleton).
// Env:
//   OPENSEARCH_URL (default: http://localhost:9200)
//   OPENSEARCH_USERNAME / OPENSEARCH_PASSWORD (optional)
//   OPENSEARCH_SSL_REJECT_UNAUTHORIZED=false (optional; for self-signed local dev)
 //   MEMORA_OS_CLIENT_MAX_RETRIES=3 (preferred; falls back to MEMORA_OS_MAX_RETRIES)
 //   MEMORA_OS_CLIENT_TIMEOUT_MS=10000 (preferred; falls back to MEMORA_OS_REQUEST_TIMEOUT_MS)

import { Client } from "@opensearch-project/opensearch";
import { debug } from "./log.js";
import fs from "node:fs";
import path from "node:path";

const log = debug("memora:os-client");
const TRACE = (process.env.MEMORA_QUERY_TRACE || "").toLowerCase() === "true";
const TRACE_FILE = process.env.MEMORA_TRACE_FILE || "";

function traceWrite(event: string, payload: any) {
  // Write if a trace file is configured, regardless of MEMORA_QUERY_TRACE
  if (!TRACE_FILE) return;
  try {
    fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
    fs.appendFileSync(
      TRACE_FILE,
      JSON.stringify({ ts: new Date().toISOString(), event, ...payload }) + "\n"
    );
  } catch {
    // ignore
  }
}

// Environment snapshot early to confirm env propagation when server boots
try {
  traceWrite("env.snapshot", {
    cwd: process.cwd(),
    OPENSEARCH_URL: process.env.OPENSEARCH_URL || "unset",
    MEMORA_EPI_PREFIX: process.env.MEMORA_EPI_PREFIX || "unset",
    DEBUG: process.env.DEBUG || "unset",
    MEMORA_QUERY_TRACE: process.env.MEMORA_QUERY_TRACE || "unset",
    MEMORA_TRACE_FILE: TRACE_FILE || "unset"
  });
} catch {
  // ignore
}

let _client: Client | null = null;

export function getClient(): Client {
  if (_client) return _client;

  const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
  const username = process.env.OPENSEARCH_USERNAME;
  const password = process.env.OPENSEARCH_PASSWORD;
  const rejectUnauthorized = (process.env.OPENSEARCH_SSL_REJECT_UNAUTHORIZED ?? "true") !== "false";
  const maxRetries = Number(process.env.MEMORA_OS_CLIENT_MAX_RETRIES ?? process.env.MEMORA_OS_MAX_RETRIES ?? 3);
  const requestTimeout = Number(process.env.MEMORA_OS_CLIENT_TIMEOUT_MS ?? process.env.MEMORA_OS_REQUEST_TIMEOUT_MS ?? 10000);

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

  if (TRACE) {
    log("client.init", { node, maxRetries, requestTimeout, rejectUnauthorized });
    traceWrite("client.init", { node, maxRetries, requestTimeout, rejectUnauthorized });
  }
  _client = new Client(opts);
  return _client;
}

/** Quick ping to verify connectivity; throws with a friendly message on failure. */
export async function assertHealthy(): Promise<void> {
  const client = getClient();

  // Configurable gating
  const minStatus = ((process.env.MEMORA_OS_MIN_HEALTH || "yellow").toLowerCase()) as "yellow" | "green";
  const timeoutMs = Number(process.env.MEMORA_OS_HEALTH_TIMEOUT_MS ?? 30000);
  const timeout = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;

  try {
    // Prefer cluster.health with wait_for_status to actually gate on readiness
    const res = await (client as any).cluster.health({
      wait_for_status: minStatus,
      timeout
    });

    const body = (res as any)?.body ?? res;
    const status: string = body?.status || "unknown";
    const order: Record<string, number> = { red: 0, yellow: 1, green: 2 };

    if ((order[status] ?? 0) < (order[minStatus] ?? 1)) {
      throw new Error(`Cluster health '${status}' did not reach '${minStatus}' within ${timeout}`);
    }
  } catch (err: any) {
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    // Fall back to a simple ping just to improve the error message if cluster.health is unsupported
    try {
      const ping = await (client as any).ping();
      const ok = (ping as any)?.body ?? ping;
      if (!ok) throw new Error("OpenSearch ping returned false");
    } catch {
      // ignore - original error is more actionable
    }
    throw new Error(`OpenSearch health check failed for ${node}. Ensure the cluster is up and reachable. Root cause: ${err?.message || err}`);
  }
}

/** Ensure an index exists; if not, create with provided body (mappings/settings). */
export async function ensureIndex(name: string, body?: Record<string, any>): Promise<void> {
  const client = getClient();
  await withRetries(async () => {
    const exists = await client.indices.exists({ index: name });
    const existsBody = (exists as any)?.body ?? exists;
    if (!existsBody) {
      await client.indices.create({ index: name, body });
    }
  }, Number(process.env.MEMORA_OS_MAX_RETRIES ?? 3));
}

/** Apply (or overwrite) an index template by name. */
export async function putIndexTemplate(name: string, templateBody: Record<string, any>): Promise<void> {
  const client = getClient();
  await withRetries(() => client.indices.putIndexTemplate({ name, body: templateBody }));
}

/** Lightweight bulk helper with basic error surfacing. */
export async function bulkSafe(body: any[], refresh: boolean | "wait_for" = false): Promise<void> {
  if (!Array.isArray(body) || body.length === 0) return;
  const client = getClient();
  const resp = await withRetries(() => client.bulk({ body, refresh } as any));
  const resBody = (resp as any)?.body ?? resp;
  if (resBody.errors) {
    const failed = (resBody.items || []).filter((i: any) => {
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
  try {
    const idx: any = (params as any)?.index;
    const body: any = (params as any)?.body;
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    log("search.request", { node, index: idx, body });
    traceWrite("search.request", { node, index: idx, body });
  } catch {
    // best-effort logging
  }
  const res = await withRetries(() => client.search(params as any), attempts);
  try {
    const idx: any = (params as any)?.index;
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    const hits = (res as any)?.body?.hits?.hits ?? [];
    const total = (res as any)?.body?.hits?.total ?? null;
    const took = (res as any)?.body?.took ?? null;
    traceWrite("search.response", { node, index: idx, took, total, count: Array.isArray(hits) ? hits.length : 0 });
  } catch {
    // ignore
  }
  return res;
}

/** Convenience index with retries. */
export async function indexWithRetries(params: Parameters<Client["index"]>[0], attempts = 3) {
  const client = getClient();
  try {
    const idx: any = (params as any)?.index;
    const id: any = (params as any)?.id;
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    log("index.request", { node, index: idx, id });
    traceWrite("index.request", { node, index: idx, id });
  } catch {
    // best-effort logging
  }
  const res = await withRetries(() => client.index(params as any), attempts);
  try {
    const idx: any = (params as any)?.index;
    const node = process.env.OPENSEARCH_URL || "http://localhost:9200";
    const body = (res as any)?.body ?? res;
    const statusCode = (res as any)?.statusCode ?? null;
    const result = body?.result ?? null;
    const _id = body?._id ?? null;
    traceWrite("index.response", { node, index: idx, id: _id, result, statusCode });
  } catch {
    // ignore
  }
  return res;
}
