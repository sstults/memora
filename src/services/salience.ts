// src/services/salience.ts
// Heuristic salience scoring, atomic splitting, summarization, and redaction.
// Reads config/memory_policies.yaml for thresholds, boosts, and redaction patterns.

import fs from "fs";
import yaml from "js-yaml";

// -----------------------------
// Config (lazy-loaded)
// -----------------------------
type Policies = {
  salience?: {
    min_score?: number;
    boost_keywords?: string[];
    max_chunk_tokens?: number;
  };
  redaction?: { patterns?: string[] };
  compression?: {
    enabled?: boolean;
    min_tokens?: number;
    preserve_anchors?: boolean;
  };
};

let policiesCache: Policies | null = null;
function policies(): Policies {
  if (policiesCache) return policiesCache;
  const raw = fs.readFileSync("config/memory_policies.yaml", "utf8");
  policiesCache = yaml.load(raw) as Policies;
  return policiesCache || {};
}

// -----------------------------
// Public API
// -----------------------------

/** Score how worth-storing a text span is (0..1). Higher = more salient. */
export function scoreSalience(text: string, opts?: { tags?: string[] }): number {
  const t = (text || "").trim();
  if (!t) return 0;

  const pol = policies();
  const boosts = new Set((pol.salience?.boost_keywords ?? []).map(s => s.toLowerCase()));

  // Base signal from length (log-scaled up to ~2k chars)
  const len = t.length;
  const lenScore = clamp01(Math.log10(1 + Math.min(len, 2000)) / Math.log10(2001));

  // Structural signals
  const hasStack = /exception|stack trace|traceback|NullPointer|ReferenceError|TypeError/i.test(t);
  const hasCodeFence = /```/.test(t) || /{.*}|\[.*\]\(.*\)|;|\bclass\b|\bdef\b/.test(t);
  const hasDecision = /\b(decision|choose|we will|let's|plan:|resolution:)\b/i.test(t);
  const hasAPI = /\b(api|endpoint|schema|contract|request|response|param|field)\b/i.test(t);

  let structural = 0;
  if (hasStack) structural += 0.35;
  if (hasCodeFence) structural += 0.2;
  if (hasDecision) structural += 0.25;
  if (hasAPI) structural += 0.15;
  structural = Math.min(0.8, structural);

  // Keyword boosts from config and tags alignment
  let kwBoost = 0;
  const lower = t.toLowerCase();
  boosts.forEach(b => {
    if (lower.includes(b)) kwBoost += 0.08;
  });
  if (opts?.tags && opts.tags.length) {
    const tagHits = opts.tags.filter(tag => lower.includes(tag.toLowerCase())).length;
    kwBoost += Math.min(0.15, tagHits * 0.04);
  }

  // Penalties for obvious noise
  const isNoise = /^[\s\-=_*#]+$/.test(t) || t.length < 10;
  const penalty = isNoise ? -0.3 : 0;

  const score = clamp01(0.35 * lenScore + structural + kwBoost + penalty);
  return score;
}

/** Split a long blob into smaller "atomic" chunks. */
export function atomicSplit(text: string): string[] {
  if (!text) return [];
  // First split by code fences to keep code blocks intact.
  const parts = splitKeepDelims(text, /```/g);

  const atoms: string[] = [];
  let inFence = false;
  let buffer: string[] = [];

  for (const p of parts) {
    if (p === "```") {
      if (inFence) {
        // close fence: emit code block
        buffer.push("```");
        atoms.push(buffer.join("\n").trim());
        buffer = [];
        inFence = false;
      } else {
        // open fence
        if (buffer.length) {
          atoms.push(...splitParagraphs(buffer.join("\n")));
          buffer = [];
        }
        buffer.push("```");
        inFence = true;
      }
      continue;
    }
    buffer.push(p);
  }
  if (buffer.length) {
    if (inFence) {
      // Unclosed fence—treat as code block anyway.
      atoms.push(buffer.join("\n").trim());
    } else {
      atoms.push(...splitParagraphs(buffer.join("\n")));
    }
  }

  // Final cleanup: remove empties and trim
  return atoms
    .map(a => a.trim())
    .filter(a => a.length > 0)
    // Limit atom size to ~1200 tokens by hard-cutting exceptionally large blobs
    .map(a => hardLimit(a, 1200 * 4));
}

/** If text exceeds maxTokens, produce an extractive summary that keeps anchors. */
export function summarizeIfLong(text: string, maxTokens: number): string {
  const tokens = estTokens(text);
  if (tokens <= maxTokens) return text;

  // Extract anchors we always want to keep
  const anchors = extractAnchors(text);

  // Score sentences by keyword density + presence of anchors
  const sentences = splitSentences(text);
  const scored = sentences.map(s => ({
    s,
    score: sentenceScore(s, anchors)
  }));

  // Keep top-N sentences until ~maxTokens (plus anchors)
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  let used = 0;

  for (const { s } of scored) {
    const t = estTokens(s);
    if (used + t > maxTokens) continue;
    out.push(s);
    used += t;
    if (used >= maxTokens) break;
  }

  // Ensure anchors are present (dedup automatically)
  const anchorLine = anchors.length ? `\n[anchors] ${Array.from(new Set(anchors)).join(" ")}` : "";
  const summary = out.join(" ").trim() + anchorLine;

  // Final safety truncate
  return truncateTokens(summary, maxTokens);
}

/** Redact secrets using regex patterns from config. */
export function redact(text: string): string {
  if (!text) return text;
  const pats = policies().redaction?.patterns ?? [];
  let out = text;
  for (let p of pats) {
    try {
      // Support inline case-insensitive flag from YAML patterns like (?i)...
      let flags = "g";
      if (p.startsWith("(?i)")) {
        flags += "i";
        p = p.replace(/^\(\?i\)/, "");
      }
      const re = new RegExp(p, flags);
      out = out.replace(re, "[REDACTED]");
    } catch {
      // ignore malformed user regex
    }
  }
  return out;
}

// -----------------------------
// Internals
// -----------------------------

function splitKeepDelims(s: string, re: RegExp): string[] {
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[0]);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function splitParagraphs(s: string): string[] {
  // Split on headings, bullet points, blank lines.
  const lines = s.split(/\r?\n/);
  const out: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const chunk = buf.join("\n").trim();
    if (chunk) out.push(chunk);
    buf = [];
  };

  for (const ln of lines) {
    if (/^\s*#{1,6}\s+/.test(ln) || /^\s*[-*+]\s+/.test(ln) || /^\s*\d+\.\s+/.test(ln) || ln.trim() === "") {
      if (buf.length) flush();
      if (ln.trim() !== "") out.push(ln.trim());
    } else {
      buf.push(ln);
    }
  }
  if (buf.length) flush();

  return out;
}

function hardLimit(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n…\n${tail}`;
}

function estTokens(text: string): number {
  // ~4 chars per token heuristic
  return Math.ceil(text.length / 4);
}

function truncateTokens(text: string, maxTokens: number): string {
  const approxChars = maxTokens * 4;
  if (text.length <= approxChars) return text;
  return text.slice(0, approxChars - 1) + "…";
}

function splitSentences(text: string): string[] {
  // Basic sentence segmentation; keep code lines intact.
  const codey = /```[\s\S]*?```/g;
  const blocks: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codey.exec(text)) !== null) {
    if (m.index > last) blocks.push(text.slice(last, m.index));
    blocks.push(m[0]);
    last = codey.lastIndex;
  }
  if (last < text.length) blocks.push(text.slice(last));

  const sentences: string[] = [];
  for (const b of blocks) {
    if (b.startsWith("```")) {
      sentences.push(b.trim());
    } else {
      // Split prose
      const parts = b
        .replace(/\n+/g, " ")
        .split(/(?<=[.!?])\s+(?=[A-Z(])/)
        .map(s => s.trim())
        .filter(Boolean);
      sentences.push(...parts);
    }
  }
  return sentences;
}

function extractAnchors(text: string): string[] {
  const anchors = new Set<string>();

  // File paths / filenames
  const fileRe = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6})/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) anchors.add(m[1]);

  // Error codes like ABC-1234 or E1234
  const errRe = /\b([A-Z]{2,}-\d{2,}|E\d{3,5}|ERR_\w+)\b/g;
  while ((m = errRe.exec(text)) !== null) anchors.add(m[1]);

  // API names / symbols (very rough)
  const symRe = /\b([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\b/g;
  while ((m = symRe.exec(text)) !== null) anchors.add(m[1]);

  return Array.from(anchors).slice(0, 50); // cap
}

function sentenceScore(s: string, anchors: string[]): number {
  let score = 0;

  // Anchor presence
  for (const a of anchors) {
    if (s.includes(a)) score += 1.5;
  }

  // Heuristic keywords
  const kw = [
    "error",
    "exception",
    "fix",
    "decision",
    "design",
    "api",
    "contract",
    "requires",
    "introduced_in",
    "version",
    "null",
    "undefined",
    "stack",
    "trace",
    "failed",
    "passed"
  ];
  const sl = s.toLowerCase();
  for (const k of kw) if (sl.includes(k)) score += 0.3;

  // Prefer shorter, information-dense sentences
  const lenTok = estTokens(s);
  score += Math.max(0, 2.0 - lenTok / 80); // small preference against very long sentences

  // Code blocks get a big boost (they're often crucial)
  if (s.startsWith("```")) score += 2.5;

  return score;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
