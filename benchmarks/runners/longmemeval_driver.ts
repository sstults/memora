/* benchmarks/runners/longmemeval_driver.ts
   LongMemEval Driver (TypeScript)
   - Consumes a LongMemEval dataset JSON (Python repo, pinned as submodule)
   - Replays session history into Memora (variant C), then answers questions and writes predictions JSONL:
       {"question_id":"<id from dataset>", "hypothesis":"<your model’s final answer>"}
   - This is a minimal driver to establish the contract with the Python evaluator.
   - Current implementation does NOT call an LLM; it produces a stub hypothesis to validate E2E scoring flow.
     Next step: integrate OpenAI client per benchmarks/config/llm.json to generate real answers.
*/
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// MemoryAdapter and MCP SDK (ESM paths)
import MemoryAdapter, { McpClient, type Scope } from "../adapters/memora_adapter.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
/* OpenAI import deferred to runtime to avoid loader-time issues */
// import OpenAI from "openai";

type Variant = "A" | "B" | "C";

interface Turn {
  role?: string;
  content?: string;
  text?: string;
  ts?: string;
  timestamp?: string;
  time?: string;
  date?: string;
  created_at?: string;
  updated_at?: string;
}

interface Sample {
  id?: string | number;
  question_id?: string | number;
  qid?: string | number;
  uid?: string | number;
  question?: string;
  query?: string;
  prompt?: string;
  haystack_sessions?: Turn[] | Turn[][];
  sessions?: Turn[] | Turn[][];
  history?: Turn[] | Turn[][];
  conversation?: Turn[] | Turn[][];
  turns?: Turn[] | Turn[][];
  // other fields ignored
}

function parseArgs(argv: string[]) {
  let dataset = "benchmarks/LongMemEval/data/longmemeval_oracle.json";
  let out = "benchmarks/reports/memora_predictions.jsonl";
  let variant: Variant = "C";
  let seed = 42;
  let qids = "";
  let replayMode: "write" | "salient" = "salient";
  let budget = 20;
  let scopeProject = 1;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset" && argv[i + 1]) {
      dataset = argv[++i];
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[++i];
    } else if (a === "--variant" && argv[i + 1]) {
      variant = argv[++i] as Variant;
    } else if (a === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === "--qids" && argv[i + 1]) {
      qids = argv[++i];
    } else if (a === "--replayMode" && argv[i + 1]) {
      const v = argv[++i];
      replayMode = v === "write" ? "write" : "salient";
    } else if (a === "--budget" && argv[i + 1]) {
      budget = Number(argv[++i]);
    } else if (a === "--scopeProject" && argv[i + 1]) {
      scopeProject = Number(argv[++i]);
    }
  }
  return { dataset, out, variant, seed, qids, replayMode, budget, scopeProject };
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJSONL(filePath: string, obj: any) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

function loadDataset(p: string): Sample[] {
  const s = fs.readFileSync(p, "utf8");
  const raw = JSON.parse(s);
  if (Array.isArray(raw)) return raw as Sample[];
  if (Array.isArray(raw?.data)) return raw.data as Sample[];
  if (Array.isArray(raw?.examples)) return raw.examples as Sample[];
  if (Array.isArray(raw?.items)) return raw.items as Sample[];
  // Map-like object: convert to array
  if (raw && typeof raw === "object") {
    return Object.values(raw) as Sample[];
  }
  return [];
}

function asTurnsField(sample: Sample): Turn[][] {
  // Handle both flat and grouped sessions. Normalize to array of sessions, each a list of turns.
  const candidates = [
    sample.haystack_sessions,
    sample.sessions,
    sample.history,
    sample.conversation,
    sample.turns
  ].filter(Boolean) as (Turn[] | Turn[][])[];

  if (candidates.length === 0) return [];

  const v = candidates[0];
  if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
    return v as Turn[][];
  }
  if (Array.isArray(v)) {
    return [v as Turn[]];
  }
  return [];
}

function extractQuestion(sample: Sample): string {
  return (sample.question ?? sample.query ?? sample.prompt ?? "").toString();
}

function extractQuestionId(sample: Sample, idx: number): string {
  const id = sample.question_id ?? sample.id ?? sample.qid ?? sample.uid ?? idx;
  return String(id);
}

/* Load helper to read JSON config */
function loadJSON<T = any>(p: string): T {
  try {
    const s = fs.readFileSync(path.resolve(p), "utf8");
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}

/* Rough token estimator used when API usage is unavailable.
   Approximation: ~4 characters per token. */
function estimateTokensApprox(text: string): number {
  const s = (text ?? "");
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/* Helpers for baselines A and B */

// Flatten sessions to a simple list of turn texts (in chronological order)
function flattenSessions(sessions: Turn[][]): string[] {
  const texts: string[] = [];
  for (const session of sessions) {
    for (const turn of session) {
      const t = (turn?.content ?? turn?.text ?? "").toString();
      if (t && t.trim()) texts.push(t.trim());
    }
  }
  return texts;
}

// Build sliding-window context from the last N turns
function buildSlidingWindowContext(sessions: Turn[][], windowTurns: number): string {
  const texts = flattenSessions(sessions);
  const recent = texts.slice(Math.max(0, texts.length - windowTurns));
  if (recent.length === 0) return "";
  const lines = recent.map((t, i) => `Turn -${recent.length - i}: ${t}`);
  return `Recent context (sliding window ${windowTurns}):\n` + lines.join("\n");
}

// Build a recent_turns text block delimited for packer trimming
function buildRecentTurnsText(sessions: Turn[][]): string {
  const texts = flattenSessions(sessions);
  if (texts.length === 0) return "";
  return texts.join("\n---TURN---\n");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) {
    const s = (v ?? "").toString().trim();
    if (!s) continue;
    seen.add(s);
  }
  return Array.from(seen);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(value.map((v) => (v ?? "").toString()));
  }
  if (typeof value === "string") {
    return dedupeStrings([(value ?? "").toString()]);
  }
  return [];
}

function normalizeIsoTimestamp(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
  } catch {
    return undefined;
  }
}

function extractCandidateTimestamp(turn: Turn): string | undefined {
  const candidates = [turn.ts, turn.timestamp, turn.time, turn.date, turn.created_at, turn.updated_at];
  for (const candidate of candidates) {
    const iso = normalizeIsoTimestamp(candidate);
    if (iso) return iso;
  }
  return undefined;
}

function collectProvidedFacts(turn: Turn): string[] {
  const direct = asStringArray((turn as any)?.facts);
  const meta = asStringArray((turn as any)?.metadata?.facts);
  return dedupeStrings([...direct, ...meta]);
}

function extractRoundFacts(text: string): string[] {
  const s = text ?? "";
  const facts = new Set<string>();

  const patterns: RegExp[] = [
    /\bI\s+(?:really\s+)?(?:like|love|enjoy)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:really\s+)?(?:dislike|hate)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:am|\'m)\s+(?:from|in|living in|based in|located in|live in)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:work|worked)\s+(?:at|for)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:study|studied)\s+(?:at|in)\s+([^.!?\n]{3,80})/gi,
    /\bMy\s+favorite\s+([^.!?\n]{2,40})\s+(?:is|are)\s+([^.!?\n]{2,80})/gi,
    /\bI\s+(?:prefer)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:was|were)\s+born\s+(?:in|on)\s+([^.!?\n]{3,80})/gi,
    /\bI\s+(?:have|own)\s+([^.!?\n]{3,80})/gi
  ];

  for (const pattern of patterns) {
    const matches = s.matchAll(pattern);
    for (const match of matches) {
      const [, subject, object] = match;
      if (object) {
        facts.add(`${match[0]}`.replace(/\s+/g, " ").trim());
      } else if (subject) {
        facts.add(`${match[0]}`.replace(/\s+/g, " ").trim());
      }
    }
  }

  return Array.from(facts);
}

interface RoundChunk {
  text: string;
  facts: string[];
  roundIndex: number;
  roundTs?: string;
  roundDate?: string;
}

function sessionToRounds(session: Turn[]): RoundChunk[] {
  const rounds: RoundChunk[] = [];
  let buffer: { formatted: string; turn: Turn; ts?: string; providedFacts: string[] }[] = [];
  let roundIndex = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const joined = buffer.map((b) => b.formatted).join("\n").trim();
    if (!joined) {
      buffer = [];
      return;
    }
    const heuristicFacts = extractRoundFacts(joined);
    const providedFacts = buffer.flatMap((b) => b.providedFacts);
    const tsCandidate = buffer.find((b) => b.ts)?.ts;
    const isoTs = tsCandidate ? normalizeIsoTimestamp(tsCandidate) : undefined;
    const roundDate = isoTs ? isoTs.slice(0, 10) : undefined;
    rounds.push({
      text: joined,
      facts: dedupeStrings([...providedFacts, ...heuristicFacts]),
      roundIndex: roundIndex++,
      roundTs: isoTs,
      roundDate
    });
    buffer = [];
  };

  for (const turn of session) {
    const rawText = (turn?.content ?? turn?.text ?? "").toString().trim();
    if (!rawText) continue;
    const role = (turn?.role ?? "").toString().trim().toLowerCase();
    if (role === "user" && buffer.length > 0) {
      flush();
    }
    const roleLabel = role ? role.toUpperCase() : "TURN";
    buffer.push({
      formatted: `${roleLabel}: ${rawText}`,
      turn,
      ts: extractCandidateTimestamp(turn),
      providedFacts: collectProvidedFacts(turn)
    });
    if (role === "assistant" || role === "tool") {
      flush();
    }
  }

  flush();
  return rounds;
}

// Simple vector ops for baseline B
type Vec = number[];

function dot(a: Vec, b: Vec): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

function cosineSim(a: Vec, b: Vec): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

async function embedText(openai: any, model: string, text: string): Promise<Vec> {
  const resp = await openai.embeddings.create({
    model,
    input: text
  });
  const v = resp?.data?.[0]?.embedding;
  return Array.isArray(v) ? (v as number[]) : [];
}

async function buildVectorRagContext(
  openai: any,
  sessions: Turn[][],
  question: string,
  k: number,
  embedModel: string,
  cache: Map<string, Vec>
): Promise<string> {
  const texts = flattenSessions(sessions);
  const candidates = texts.filter((t) => !!t);
  if (candidates.length === 0) return "";

  // Embed question
  const qVec = await embedText(openai, embedModel, question || "question");

  // Embed candidates with simple cache
  const items: { text: string; vec: Vec }[] = [];
  for (const t of candidates) {
    let v = cache.get(t);
    if (!v) {
      v = await embedText(openai, embedModel, t);
      cache.set(t, v);
    }
    items.push({ text: t, vec: v });
  }

  // Rank by cosine similarity to the question
  items.sort((a, b) => cosineSim(b.vec, qVec) - cosineSim(a.vec, qVec));
  const top = items.slice(0, Math.max(1, k)).map((it) => it.text);

  const lines = top.map((t, i) => `${i + 1}. ${t}`);
  return `Top-${Math.max(1, k)} relevant snippets (vector baseline):\n` + lines.join("\n");
}

async function createOpenAI(): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_KEY;
  if (!apiKey) return null;
  const mod: any = await import("openai");
  const OpenAI = mod?.default ?? mod;
  return new OpenAI({ apiKey });
}

async function answerWithOpenAI(openai: any, llmCfg: any, question: string, context: string): Promise<{ text: string; usage?: any; latency_ms: number }> {
  const model = llmCfg?.model ?? "gpt-4.1-mini";
  const temperature = typeof llmCfg?.temperature === "number" ? llmCfg.temperature : 0.2;
  const max_tokens = typeof llmCfg?.max_tokens === "number" ? llmCfg.max_tokens : 512;

  const sys = "You are a focused assistant for question answering over provided context. Use the context if relevant; if the answer is not present, reply with \"I don't know\". Respond concisely with just the final answer, no explanation.";
  const user = `Context:
${context}

Question:
${question}

Answer:`;

  const t0 = performance.now();
  const resp = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  const latency_ms = performance.now() - t0;

  const text = resp.choices?.[0]?.message?.content ?? "";
  return { text: (text ?? "").toString().trim(), usage: resp?.usage, latency_ms };
}

async function replaySessionsToMemora(
  adapter: MemoryAdapter,
  seed: number,
  variant: Variant,
  qid: string,
  sessions: Turn[][],
  mode: "write" | "salient" = "salient"
): Promise<{ attempted: number; written: number }> {
  let attempted = 0;
  let written = 0;
  for (const [sIdx, session] of sessions.entries()) {
    const rounds = sessionToRounds(session);
    for (const round of rounds) {
      const text = round.text;
      if (!text || !text.trim()) continue;
      attempted++;
      const roundKey = `${qid}::${sIdx}::${round.roundIndex}`;
      try {
        const common = {
          tags: [
            "bench",
            "longmemeval",
            `seed:${seed}`,
            `variant:${variant}`,
            `qid:${qid}`,
            `session:${sIdx}`,
            `round:${round.roundIndex}`
          ],
          scope: "this_task" as const,
          task_id: `longmemeval-${seed}`,
          idempotency_key: roundKey,
          round_id: roundKey,
          round_index: round.roundIndex,
          round_ts: round.roundTs,
          round_date: round.roundDate,
          facts_text: round.facts
        };
        if (mode === "write") {
          await adapter.write({
            text,
            ...common
          });
          written++;
        } else {
          const wr = await adapter.writeIfSalient(
            {
              text,
              ...common
            },
            0.05 // low threshold to maximize recall
          );
          if (wr?.data?.written) written++;
        }
      } catch {
        // Non-fatal for bench driver
      }
    }
  }
  return { attempted, written };
}

async function main() {
  const { dataset, out, variant, seed, qids, replayMode, budget, scopeProject } = parseArgs(process.argv.slice(2));
  ensureDirForFile(out);

  // Write a header for traceability
  writeJSONL(out, {
    ts: new Date().toISOString(),
    op: "longmemeval_driver_start",
    dataset,
    out,
    variant,
    seed
  });

  // Load configs and initialize LLM
  const llmCfg = loadJSON<any>("benchmarks/config/llm.json");
  const memoraCfg = loadJSON<any>("benchmarks/config/memora.json");
  const openai = await createOpenAI();

  // Load dataset
  let examples: Sample[] = [];
  try {
    examples = loadDataset(dataset);
  } catch (err: any) {
    writeJSONL(out, { ts: new Date().toISOString(), op: "error", stage: "load_dataset", message: String(err?.message ?? err) });
    throw err;
  }

  // Optional filter: include only specified question IDs
  const qidList = (qids || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (qidList.length > 0) {
    const qset = new Set(qidList);
    const before = examples.length;
    examples = examples.filter((ex, idx) => qset.has(extractQuestionId(ex, idx)));
    writeJSONL(out, { ts: new Date().toISOString(), op: "filter", include_qids: qidList, before, after: examples.length });
  }

  // Variants A and B baselines (no Memora policies)
  if (variant !== "C") {
    // Require OpenAI for baselines; otherwise fallback to stub outputs
    if (!openai) {
      for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        const qid = extractQuestionId(ex, i);
        writeJSONL(out, { question_id: qid, hypothesis: "" });
      }
      process.stdout.write(`LongMemEvalDriver (no OPENAI_API_KEY) wrote ${examples.length} stub predictions to ${out}\n`);
      return;
    }

    const k = typeof (memoraCfg?.retrieval_budget) === "number" ? memoraCfg.retrieval_budget : 8;
    const windowTurns = typeof (memoraCfg?.sliding_window_turns) === "number" ? memoraCfg.sliding_window_turns : k;
    const embedModel = llmCfg?.embeddings_model ?? "text-embedding-3-small";
    const embedCache = new Map<string, number[]>();

    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      const qid = extractQuestionId(ex, i);
      const sessions = asTurnsField(ex);
      const question = extractQuestion(ex);

      let contextText = "";
      if (variant === "A") {
        // Sliding-window: last N turns only
        contextText = buildSlidingWindowContext(sessions, windowTurns);
      } else {
        // Vector RAG baseline without Memora policies
        try {
          contextText = await buildVectorRagContext(openai, sessions, question || "", k, embedModel, embedCache);
        } catch {
          // Fallback to sliding window if embeddings fail
          contextText = buildSlidingWindowContext(sessions, windowTurns);
        }
      }

      let hypothesis = "";
      let tokens_in: number | null = null;
      let tokens_out: number | null = null;
      let llm_latency_ms: number | null = null;
      try {
        const result = await answerWithOpenAI(openai, llmCfg, question || "", contextText);
        hypothesis = result.text;
        llm_latency_ms = typeof (result as any)?.latency_ms === "number" ? (result as any).latency_ms : null;

        const usage = (result as any)?.usage;
        const inCandidates = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
        const outCandidates = usage?.completion_tokens ?? usage?.output_tokens ?? null;
        if (typeof inCandidates === "number" && typeof outCandidates === "number") {
          tokens_in = inCandidates;
          tokens_out = outCandidates;
        } else {
          tokens_in = estimateTokensApprox(question || "") + estimateTokensApprox(contextText) + 20;
          tokens_out = estimateTokensApprox(hypothesis || "");
        }
      } catch {
        // If the LLM call fails, leave an empty hypothesis for this question
        hypothesis = "";
      }

      writeJSONL(out, { question_id: qid, hypothesis, tokens_in, tokens_out, llm_latency_ms });
    }

    process.stdout.write(`LongMemEvalDriver (variant ${variant}) wrote ${examples.length} predictions to ${out}\n`);
    return;
  }

  // Variant C: connect to Memora MCP
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;

    // Launch compiled MCP server to avoid ts-node ESM loader issues
    transport = new StdioClientTransport({
      command: "node",
      args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
      cwd: process.cwd(),
      env
    });
    client = new Client({ name: "memora-longmemeval-driver", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (err: any) {
      writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "mcp_connect", error: String(err?.message ?? err) });
      for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        const qid = extractQuestionId(ex, i);
        writeJSONL(out, { question_id: qid, hypothesis: "" });
      }
      process.stdout.write(`LongMemEvalDriver (fallback: no MCP) wrote ${examples.length} predictions to ${out}\n`);
      return;
    }

    const mcpClient: McpClient = {
      callTool: async (name: string, params?: any) => {
        const t0 = performance.now();
        try {
          const res = await client!.callTool({ name, arguments: params ?? {} });
          const latency_ms = performance.now() - t0;
          writeJSONL(out, { ts: new Date().toISOString(), op: "mcp_call", tool: name, latency_ms, backend: "memora", success: true });
          return res;
        } catch (err: any) {
          const latency_ms = performance.now() - t0;
          writeJSONL(out, { ts: new Date().toISOString(), op: "mcp_call", tool: name, latency_ms, backend: "memora", success: false, error: String(err?.message ?? err) });
          throw err;
        }
      }
    };

    // Bootstrap context for this driver run
    const ctxParams = {
      tenant_id: "memora",
      project_id: "benchmarks",
      context_id: `longmemeval-${seed}-C-driver`,
      task_id: `longmemeval-${seed}`,
      env: "bench",
      api_version: "3.1"
    };
    try {
      await mcpClient.callTool("context.ensure_context", ctxParams);
    } catch (err: any) {
      writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "ensure_context", error: String(err?.message ?? err) });
      for (let i = 0; i < examples.length; i++) {
        const ex = examples[i];
        const qid = extractQuestionId(ex, i);
        writeJSONL(out, { question_id: qid, hypothesis: "" });
      }
      process.stdout.write(`LongMemEvalDriver (fallback: context unavailable) wrote ${examples.length} predictions to ${out}\n`);
      return;
    }

    // Ensure active context is set for this process; memory.retrieve requires it
    await mcpClient.callTool("context.set_context", ctxParams);
    const adapter = new MemoryAdapter(mcpClient);

    // Iterate dataset: enqueue sessions into Memora, then answer question (stub until LLM is wired)
    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      const qid = extractQuestionId(ex, i);
      const sessions = asTurnsField(ex);
      const question = extractQuestion(ex);

      try {
        const replayStats = await replaySessionsToMemora(adapter, seed, variant, qid, sessions, replayMode);
        writeJSONL(out, { ts: new Date().toISOString(), op: "diag", stage: "replay", qid, mode: replayMode, attempted: replayStats.attempted, written: replayStats.written });
      } catch (err: any) {
        writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "replay_sessions", qid, error: String(err?.message ?? err) });
      }

      // Retrieve memory context for the question with expanded budget and tags
      try {
        const scopes: Scope[] = scopeProject ? ["this_task", "project"] : ["this_task"];
        const filtersC: { scope: Scope[] } = { scope: scopes };
        await adapter.search(question || "question", budget, filtersC, { task_id: `longmemeval-${seed}` });
      } catch {
        // retrieval failures are non-fatal for emitting a stub prediction
      }

      let hypothesis = "";
      let tokens_in: number | null = null;
      let tokens_out: number | null = null;
      let llm_latency_ms: number | null = null;
      try {
        const kC = budget;
        const scopes: Scope[] = scopeProject ? ["this_task", "project"] : ["this_task"];
        const filtersC: { scope: Scope[] } = { scope: scopes };
        const recentText = buildRecentTurnsText(sessions);
        const pack = await adapter.pack(
          question || "question",
          kC,
          { recent_turns: recentText },
          filtersC,
          { task_id: `longmemeval-${seed}` }
        );
        const contextText = pack?.data?.packed ?? "";
        const packSnippets = Array.isArray(pack?.data?.snippets) ? pack.data.snippets.length : 0;
        writeJSONL(out, { ts: new Date().toISOString(), op: "diag", stage: "pack", qid, k: kC, scope: scopes, snippets: packSnippets, packed_len: contextText.length });
        if (openai) {
          const result = await answerWithOpenAI(openai, llmCfg, question || "", contextText);
          hypothesis = result.text;
          llm_latency_ms = typeof (result as any)?.latency_ms === "number" ? (result as any).latency_ms : null;

          const usage = (result as any)?.usage;
          const inCandidates = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
          const outCandidates = usage?.completion_tokens ?? usage?.output_tokens ?? null;

          if (typeof inCandidates === "number" && typeof outCandidates === "number") {
            tokens_in = inCandidates;
            tokens_out = outCandidates;
          } else {
            // Fallback: approximate token counts (question + context + small overhead)
            tokens_in = estimateTokensApprox(question || "") + estimateTokensApprox(contextText) + 20;
            tokens_out = estimateTokensApprox(hypothesis || "");
          }
        }
      } catch (err: any) {
        writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "llm", qid, error: String(err?.message ?? err) });
      }
      writeJSONL(out, { question_id: qid, hypothesis, tokens_in, tokens_out, llm_latency_ms });
    }

    process.stdout.write(`LongMemEvalDriver wrote ${examples.length} predictions to ${out}\n`);
  } finally {
    try {
      await client?.close();
    } catch {
      void 0;
    }
    try {
      await transport?.close();
    } catch {
      void 0;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
