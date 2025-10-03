// src/services/ids.ts
// Utilities for generating stable IDs, hashes, and index-friendly helpers.

//
// Public API
//
export function makeEventId(): string {
  return `${EVENT_PREFIX}${randomBase32(16)}`;
}

export function makeMemIdFromText(text: string): string {
  // Stable ID from content hash; good for dedup/upserts
  return `${MEM_PREFIX}${sha256Hex(text).slice(0, 24)}`;
}

export function makeFactId(s: string, p: string, o: string): string {
  // Stable triple id
  return `${FACT_PREFIX}${sha256Hex(`${s}|${p}|${o}`).slice(0, 24)}`;
}

export function shortId(prefix = "id_"): string {
  return `${prefix}${randomBase32(10)}`;
}

export function safeNowIso(): string {
  return new Date().toISOString();
}

export function dailyIndex(prefix: string, d: Date = new Date()): string {
  // prefix like "mem-episodic-"
  return `${prefix}${d.toISOString().slice(0, 10)}`;
}

export function contentHash(obj: unknown): string {
  return sha256Hex(stableJson(obj));
}

export function stableJson(obj: unknown): string {
  // Deterministic JSON stringify (sorted keys)
  return JSON.stringify(sortKeys(obj), null, 0);
}

export function parseDocId(id: string): { kind: "mem" | "evt" | "fact" | "other"; raw: string } {
  if (id.startsWith(MEM_PREFIX)) return { kind: "mem", raw: id.slice(MEM_PREFIX.length) };
  if (id.startsWith(EVENT_PREFIX)) return { kind: "evt", raw: id.slice(EVENT_PREFIX.length) };
  if (id.startsWith(FACT_PREFIX)) return { kind: "fact", raw: id.slice(FACT_PREFIX.length) };
  return { kind: "other", raw: id };
}

//
// Internals
//
const MEM_PREFIX = "mem_";
const EVENT_PREFIX = "evt_";
const FACT_PREFIX = "fact_";

/** SHA-256 hex (browser/node without external deps) */
export function sha256Hex(input: string | Uint8Array): string {
  if (typeof (globalThis as any).crypto?.subtle !== "undefined") {
    // Browser/WebCrypto path (async)
    throw new Error("sha256Hex called in async WebCrypto context; use sha256HexAsync instead.");
  }
  // Node built-in
  const crypto = require("crypto") as typeof import("crypto");
  const hash = crypto.createHash("sha256");
  hash.update(typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input));
  return hash.digest("hex");
}

/** Async WebCrypto version for environments without Node crypto */
export async function sha256HexAsync(input: string | Uint8Array): Promise<string> {
  if (typeof (globalThis as any).crypto?.subtle === "undefined") {
    return sha256Hex(input);
  }
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await (globalThis as any).crypto.subtle.digest("SHA-256", data);
  return buf2hex(new Uint8Array(digest));
}

function buf2hex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out += (b >>> 4).toString(16);
    out += (b & 0x0f).toString(16);
  }
  return out;
}

/** Random base32 string (no padding), deterministic length */
function randomBase32(len: number): string {
  // Prefer Node crypto or Web Crypto
  let bytes: Uint8Array;
  const nBytes = Math.ceil((len * 5) / 8); // 5 bits per base32 char
  if (typeof (globalThis as any).crypto?.getRandomValues === "function") {
    bytes = new Uint8Array(nBytes);
    (globalThis as any).crypto.getRandomValues(bytes);
  } else {
    const crypto = require("crypto") as typeof import("crypto");
    bytes = crypto.randomBytes(nBytes);
  }
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567"; // crockford-ish, lowercased
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length && output.length < len; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5 && output.length < len) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (output.length < len) {
    // pad with pseudo-random picks if rounding lost some chars
    while (output.length < len) output += alphabet[Math.floor(Math.random() * 32)];
  }
  return output;
}

/** Recursively sort object keys for deterministic hashing */
function sortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeys) as any;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) sorted[k] = sortKeys(o[k]);
    return sorted as any;
  }
  return v;
}
