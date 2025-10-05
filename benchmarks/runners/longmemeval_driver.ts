/* benchmarks/runners/longmemeval_driver.ts
   LongMemEval Driver (TypeScript)
   - Consumes a LongMemEval dataset JSON (Python repo, pinned as submodule)
   - Replays session history into Memora (variant C), then answers questions and writes predictions JSONL:
       {"question_id":"<id from dataset>", "hypothesis":"<your model’s final answer>"}
   - This is a minimal driver to establish the contract with the Python evaluator.
   - Current implementation does NOT call an LLM; it produces a stub hypothesis to validate E2E scoring flow.
     Next step: integrate OpenAI client per benchmarks/config/llm.json to generate real answers.
*/
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

// MemoryAdapter and MCP SDK (ESM paths)
import MemoryAdapter, { McpClient } from "../adapters/memora_adapter.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
/* OpenAI import deferred to runtime to avoid loader-time issues */
// import OpenAI from "openai";

type Variant = "A" | "B" | "C";

interface Turn {
  role?: string;
  content?: string;
  text?: string;
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
    }
  }
  return { dataset, out, variant, seed };
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

// Load helper to read JSON config
function loadJSON<T = any>(p: string): T {
  try {
    const s = fs.readFileSync(path.resolve(p), "utf8");
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
}

async function createOpenAI(): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const mod: any = await import("openai");
  const OpenAI = mod?.default ?? mod;
  return new OpenAI({ apiKey });
}

async function answerWithOpenAI(openai: any, llmCfg: any, question: string, context: string): Promise<string> {
  const model = llmCfg?.model ?? "gpt-4.1-mini";
  const temperature = typeof llmCfg?.temperature === "number" ? llmCfg.temperature : 0.2;
  const max_tokens = typeof llmCfg?.max_tokens === "number" ? llmCfg.max_tokens : 512;

  const sys = "You are a focused assistant for question answering over provided context. Use the context if relevant; if the answer is not present, reply with \"I don't know\". Respond concisely with just the final answer, no explanation.";
  const user = `Context:
${context}

Question:
${question}

Answer:`;

  const resp = await openai.chat.completions.create({
    model,
    temperature,
    max_tokens,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });

  const text = resp.choices?.[0]?.message?.content ?? "";
  return (text ?? "").toString().trim();
}

async function replaySessionsToMemora(adapter: MemoryAdapter, seed: number, variant: Variant, qid: string, sessions: Turn[][]) {
  for (const [sIdx, session] of sessions.entries()) {
    for (const [tIdx, turn] of session.entries()) {
      const text = (turn.content ?? turn.text ?? "").toString();
      if (!text || !text.trim()) continue;
      try {
        await adapter.writeIfSalient({
          text,
          tags: ["bench", "longmemeval", `seed:${seed}`, `variant:${variant}`, `qid:${qid}`, `session:${sIdx}`, `turn:${tIdx}`],
          scope: "this_task",
          task_id: `longmemeval-${seed}`
        });
      } catch {
        // Non-fatal for bench driver
      }
    }
  }
}

async function main() {
  const { dataset, out, variant, seed } = parseArgs(process.argv.slice(2));
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

  // Variant A/B: for now, produce a deterministic stub hypothesis (no Memora calls).
  if (variant !== "C") {
    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      const qid = extractQuestionId(ex, i);
      // Minimal placeholder: empty hypothesis to validate scoring plumbing; update in a later step.
      writeJSONL(out, { question_id: qid, hypothesis: "" });
    }
    process.stdout.write(`LongMemEvalDriver wrote ${examples.length} predictions to ${out}\n`);
    return;
  }

  // Variant C: connect to Memora MCP
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;

    transport = new StdioClientTransport({
      command: "node",
      args: ["--import", "./scripts/register-ts-node.mjs", "src/index.ts"],
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

    const adapter = new MemoryAdapter(mcpClient);

    // Iterate dataset: enqueue sessions into Memora, then answer question (stub until LLM is wired)
    for (let i = 0; i < examples.length; i++) {
      const ex = examples[i];
      const qid = extractQuestionId(ex, i);
      const sessions = asTurnsField(ex);
      const question = extractQuestion(ex);

      try {
        await replaySessionsToMemora(adapter, seed, variant, qid, sessions);
      } catch (err: any) {
        writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "replay_sessions", qid, error: String(err?.message ?? err) });
      }

      // Retrieve memory context for the question (k=5); a later step will use an LLM over packed context.
      try {
        await adapter.search(question || "question", 5, { scope: ["this_task", "project"] }, { task_id: `longmemeval-${seed}` });
      } catch {
        // retrieval failures are non-fatal for emitting a stub prediction
      }

      let hypothesis = "";
      try {
        const pack = await adapter.pack(
          question || "question",
          (memoraCfg?.retrieval_budget ?? 8),
          undefined,
          memoraCfg?.filters,
          { task_id: `longmemeval-${seed}` }
        );
        const contextText = pack?.data?.packed ?? "";
        if (openai) {
          hypothesis = await answerWithOpenAI(openai, llmCfg, question || "", contextText);
        }
      } catch (err: any) {
        writeJSONL(out, { ts: new Date().toISOString(), op: "warn", stage: "llm", qid, error: String(err?.message ?? err) });
      }
      writeJSONL(out, { question_id: qid, hypothesis });
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
