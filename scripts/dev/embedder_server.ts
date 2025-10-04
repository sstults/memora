// scripts/dev/embedder_server.ts
// Lightweight mock embedding HTTP service for development.
// Endpoint: POST /embed with JSON { texts: string[], dim?: number }
// Response: { vectors: number[][] } with L2-normalized deterministic vectors.
//
// Usage:
//   npm run dev:embedder
//   curl -s http://localhost:8080/embed -H 'Content-Type: application/json' \
//     -d '{"texts":["hello world","another"],"dim":16}' | jq

import http from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.EMBED_PORT || 8080);

type EmbedRequest = {
  texts?: string[];
  dim?: number;
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
      // basic guard against huge bodies
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

function unitNormalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function simpleTokens(s: string): string[] {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9_./:-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2048);
}

// FNV-1a 32-bit for simplicity and determinism
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // force 32-bit signed
  return h | 0;
}

// Tiny deterministic PRNG for small noise/amplitude generation
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embedOne(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = simpleTokens(text);
  const seed = fnv1a(text);
  const rng = mulberry32(seed);

  for (const tok of tokens) {
    const h1 = fnv1a(tok + "|a");
    const h2 = fnv1a(tok + "|b");
    const i = Math.abs(h1) % dim;
    const j = Math.abs(h2) % dim;

    const phase = ((h1 ^ h2) >>> 0) * 0.0001;
    const amp = 0.5 + 0.5 * rng(); // 0.5..1.0
    vec[i] += Math.sin(phase) * amp;
    vec[j] += Math.cos(phase) * amp * 0.7;
  }

  // small noise for tie-breaking
  for (let k = 0; k < dim; k++) vec[k] += (rng() - 0.5) * 0.01;

  return unitNormalize(vec);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/embed") {
      const body = (await parseBody(req)) as EmbedRequest;
      const texts = Array.isArray(body.texts) ? body.texts : [];
      const dimRaw = Number(body.dim);
      const dim = Number.isFinite(dimRaw) && dimRaw > 0 && dimRaw <= 4096 ? Math.floor(dimRaw) : 1024;

      if (texts.length === 0) {
        return sendJson(res, 400, { error: "texts must be a non-empty string array" });
      }

      const vectors = texts.map((t) => embedOne(String(t), dim));
      return sendJson(res, 200, { vectors });
    }

    // 404 for everything else
    sendJson(res, 404, { error: "Not found" });
  } catch (err: any) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[dev-embedder] listening on http://localhost:${PORT}`);
});
