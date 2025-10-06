// scripts/dev/reranker_cohere_server.ts
// Cohere-backed reranker HTTP service implementing the same protocol as scripts/dev/reranker_server.ts
// Endpoint: POST /rerank with JSON { query: string, candidates: { id: string, text: string }[], model?: string }
// Response: { scores: number[] } where higher is better.
//
// Requirements:
// - Node >= 20 (global fetch available)
// - COHERE_API_KEY in env
//
// Usage:
//   export COHERE_API_KEY=sk_...
//   npm run dev:reranker:cohere
//   curl -s http://localhost:8081/rerank -H 'Content-Type: application/json' \\
//     -d '{"query":"hello world","candidates":[{"id":"a","text":"hello world guide"},{"id":"b","text":"unrelated"}]}' | jq
//
// Notes:
// - This adapter requests top_n = candidates.length and maps Cohere relevance_score back to the original order.
// - If Cohere returns fewer than top_n results, missing entries are scored as 0.

import http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.RERANK_PORT || 8081);
const COHERE_API_KEY = process.env.COHERE_API_KEY || "";
const COHERE_API_BASE = (process.env.COHERE_API_BASE || "https://api.cohere.com/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = process.env.COHERE_RERANK_MODEL || "rerank-english-v3.0";

type RerankRequest = {
  query?: string;
  candidates?: { id: string; text?: string }[];
  model?: string;
};

function sendJson(res: ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.socket.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function cohereRerank(
  query: string,
  candidates: { id: string; text?: string }[],
  model?: string,
  timeoutMs: number = 1500
): Promise<number[]> {
  if (!COHERE_API_KEY) {
    throw new Error("COHERE_API_KEY is not set");
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  const payload = {
    model: model || DEFAULT_MODEL,
    query,
    documents: candidates.map((c) => ({ id: c.id, text: String(c.text || "") })),
    top_n: candidates.length,
    return_documents: false,
  };

  try {
    const res = await fetch(`${COHERE_API_BASE}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${COHERE_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`Cohere HTTP ${res.status}: ${txt.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      results?: { index: number; relevance_score?: number }[];
    };

    const scores = new Array<number>(candidates.length).fill(0);
    if (Array.isArray(data.results)) {
      for (const r of data.results) {
        const i = Number(r.index);
        if (Number.isInteger(i) && i >= 0 && i < scores.length) {
          const s = typeof r.relevance_score === "number" ? r.relevance_score : 0;
          scores[i] = Number.isFinite(s) ? s : 0;
        }
      }
    }
    return scores;
  } finally {
    clearTimeout(t);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/rerank") {
      const body = (await parseBody(req)) as RerankRequest;
      const query = String(body.query ?? "");
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const model = body.model;

      if (!query || candidates.length === 0) {
        return sendJson(res, 400, { error: "query and candidates[] are required" });
      }

      try {
        const scores = await cohereRerank(query, candidates, model, numFromEnv("RERANK_TIMEOUT_MS", 1500));
        return sendJson(res, 200, { scores });
      } catch (e: any) {
        return sendJson(res, 502, { error: String(e?.message || e) });
      }
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err: any) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[cohere-reranker] listening on http://localhost:${PORT} -> ${COHERE_API_BASE}/rerank (model=${DEFAULT_MODEL})`);
});

// ----------------------------
// Utils
// ----------------------------
function numFromEnv(k: string, dflt: number): number {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : dflt;
}
