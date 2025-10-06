/* benchmarks/runners/mab_driver.ts
   MemoryAgentBench Driver (TypeScript)
   - Loads references (questions/answers) from Hugging Face via a small Python helper
   - Replays long contexts into Memora once per source, then answers questions using Memora + LLM
   - Produces a JSON file compatible with MemoryAgentBench evaluator format:
       {
         "data": [
           { "question_id": "...", "question": "...", "output": "<model answer>", "answer": "<ground truth>" },
           ...
         ],
         "meta": { ... run info ... }
       }
*/
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

// Memora adapter and MCP client
import MemoryAdapter, { McpClient, type Scope } from "../adapters/memora_adapter.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Split = "Accurate_Retrieval";
interface Reference {
  question: string;
  answer: string;
  question_id: string;
  question_type?: string;
  context: string;
  source?: string;
  abstention?: boolean;
}

function parseArgs(argv: string[]) {
  let source = "longmemeval_s*";
  let split: Split = "Accurate_Retrieval";
  let seed = 42;
  let limit: number | null = null;
  let out = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" && argv[i + 1]) {
      source = argv[++i];
    } else if (a === "--split" && argv[i + 1]) {
      split = argv[++i] as Split;
    } else if (a === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === "--limit" && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[++i];
    }
  }

  // Default output follows MemoryAgentBench directory convention:
  // ./outputs/{method}/Accurate_Retrieval/longmemeval_s*_SEED{seed}.json
  if (!out) {
    const method = "memora";
    const baseDir = path.join("outputs", method, split);
    const fname = `${source}_SEED${seed}.json`; // '*' is valid on POSIX; MemoryAgentBench scripts sometimes search with the literal '*'
    out = path.join(baseDir, fname);
  }

  return { source, split, seed, limit, out };
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJSON(filePath: string, obj: any) {
  ensureDirForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}

function loadJSON<T = any>(p: string): T {
  try {
    const s = fs.readFileSync(path.resolve(p), "utf8");
    return JSON.parse(s) as T;
  } catch {
    return {} as T;
  }
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

// naive token estimate fallback
function estimateTokensApprox(text: string): number {
  const s = (text ?? "");
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}


function dumpReferences(source: string, split: Split): Reference[] {
  const args = [
    "benchmarks/mab_helpers/dump_references.py",
    "--source",
    source,
    "--split",
    split
  ];
  // Allow large JSON payloads from the HF datasets loader to avoid ENOBUFS
  const out = execFileSync("python3", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  const data = JSON.parse(out) as Reference[];
  return data;
}

async function main() {
  const { source, split, seed, limit, out } = parseArgs(process.argv.slice(2));

  // Load configs and initialize LLM
  const llmCfg = loadJSON<any>("benchmarks/config/llm.json");
  const memoraCfg = loadJSON<any>("benchmarks/config/memora.json");
  const openai = await createOpenAI();

  // 1) Load references from HF via helper (ensures identical order to evaluator)
  let refs = dumpReferences(source, split);
  if (typeof limit === "number" && limit > 0) {
    refs = refs.slice(0, Math.min(limit, refs.length));
  }

  // 2) Connect to Memora MCP
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>;

    transport = new StdioClientTransport({
      command: "node",
      args: ["--experimental-specifier-resolution=node", "dist/src/index.js"],
      cwd: process.cwd(),
      env
    });
    client = new Client({ name: "memora-mab-driver", version: "0.1.0" });
    await client.connect(transport);

    const mcpClient: McpClient = {
      callTool: async (name: string, params?: any) => {
        return await client!.callTool({ name, arguments: params ?? {} });
      }
    };
    const adapter = new MemoryAdapter(mcpClient);

    // Bootstrap bench context
    const ctxParams = {
      tenant_id: "memora",
      project_id: "benchmarks",
      context_id: `mab-${seed}`,
      task_id: `mab-${seed}`,
      env: "bench",
      api_version: "3.1"
    };
    await mcpClient.callTool("context.ensure_context", ctxParams);

    // 3) Replay long contexts once per unique context (or source) to Memora
    // Use a hash to dedupe even if strings repeat
    const seenContexts = new Set<string>();
    for (const r of refs) {
      const h = sha256(r.context || "");
      if (seenContexts.has(h)) continue;
      seenContexts.add(h);

      // Salience-aware write with low threshold to maximize recall
      try {
        await adapter.writeIfSalient(
          {
            text: r.context || "",
            tags: ["bench", "mab", split, `source:${r.source ?? "unknown"}`],
            scope: "this_task",
            task_id: `mab-${seed}`
          },
          0.05
        );
      } catch {
        // non-fatal
      }
    }

    // 4) Answer questions
    const results: { question_id: string; question: string; output: string; answer: string; tokens_in?: number; tokens_out?: number; llm_latency_ms?: number }[] = [];
    const k = typeof memoraCfg?.retrieval_budget === "number" ? memoraCfg.retrieval_budget : 20;

    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      const q = r.question || "";
      let contextText = "";

      try {
        // Retrieve and pack using Memora
        const filtersC: { scope: Scope[] } = { scope: ["this_task", "project"] };
        const pack = await adapter.pack(q || "question", k, {}, filtersC, { task_id: `mab-${seed}` });
        contextText = pack?.data?.packed ?? "";
      } catch {
        // ignore
      }

      let output = "";
      let tokens_in: number | undefined;
      let tokens_out: number | undefined;
      let llm_latency_ms: number | undefined;

      if (openai) {
        try {
          const result = await answerWithOpenAI(openai, llmCfg, q, contextText);
          output = result.text;
          llm_latency_ms = typeof (result as any)?.latency_ms === "number" ? (result as any).latency_ms : undefined;

          const usage = (result as any)?.usage;
          const inCandidates = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
          const outCandidates = usage?.completion_tokens ?? usage?.output_tokens ?? null;
          if (typeof inCandidates === "number" && typeof outCandidates === "number") {
            tokens_in = inCandidates;
            tokens_out = outCandidates;
          } else {
            tokens_in = estimateTokensApprox(q || "") + estimateTokensApprox(contextText) + 20;
            tokens_out = estimateTokensApprox(output || "");
          }
        } catch {
          output = "";
        }
      } else {
        // No LLM key -> stub empty output
        output = "";
      }

      results.push({
        question_id: r.question_id,
        question: q,
        output,
        answer: r.answer,
        tokens_in,
        tokens_out,
        llm_latency_ms
      });
    }

    // 5) Write MemoryAgentBench-compatible JSON
    const meta = {
      ts: new Date().toISOString(),
      source,
      split,
      seed,
      k,
      method: "memora",
      items: results.length
    };
    ensureDirForFile(out);
    writeJSON(out, { data: results, meta });
    process.stdout.write(`MAB driver wrote ${results.length} predictions to ${out}\n`);
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
