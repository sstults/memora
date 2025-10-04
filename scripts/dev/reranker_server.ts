// scripts/dev/reranker_server.ts
// Lightweight mock reranker HTTP service for development.
// Endpoint: POST /rerank with JSON { query: string, candidates: { id: string, text: string }[], model?: string }
// Response: { scores: number[] } where higher is better.
//
// Scoring: deterministic lexical overlap (Jaccard) plus minor tie-breaker based on stable hash.
// This mirrors the protocol expected by src/services/rerank.ts.
//
// Usage:
//   npm run dev:reranker
//   curl -s http://localhost:8081/rerank -H 'Content-Type: application/json' \\
//     -d '{"query":"hello world","candidates":[{"id":"a","text":"hello"},{"id":"b","text":"planet"}]}' | jq

import http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.RERANK_PORT || 8081);

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
      if (data.length > 1_000_000) { // ~1MB guard
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

function tokenize(s: string): Set<string> {
  return new Set(
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9_./:-]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 1 && w !== "the" && w !== "and")
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

// FNV-1a 32-bit for deterministic small tie-breaker
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function stableTinyNoise(q: string, t: string): number {
  // Map hash into [-0.01, 0.01] for tiny perturbation
  const h = fnv1a(q + "::" + t) >>> 0;
  return ((h % 2001) - 1000) / 100000; // [-0.01, 0.01] approx
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/rerank") {
      const body = (await parseBody(req)) as RerankRequest;
      const query = String(body.query ?? "");
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];

      if (!query || candidates.length === 0) {
        return sendJson(res, 400, { error: "query and candidates[] are required" });
      }

      const qTok = tokenize(query);
      const scores = candidates.map((c) => {
        const lex = jaccard(qTok, tokenize(c.text || ""));
        return Math.max(0, Math.min(1, lex + stableTinyNoise(query, c.text || "")));
      });

      return sendJson(res, 200, { scores });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err: any) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-reranker] listening on http://localhost:${PORT}`);
});
