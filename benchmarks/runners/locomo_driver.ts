/* benchmarks/runners/locomo_driver.ts
   LoCoMo-style Long-Context QA Driver (TypeScript)
   - Loads references (questions/answers) from HF or local JSON via a Python helper
   - Replays long contexts into Memora once per unique context, then answers questions using Memora + LLM
   - Produces a JSON file compatible with a generic evaluator format:
       {
         "data": [
           { "question_id": "...", "question": "...", "output": "<model answer>", "answer": "<ground truth>" },
           ...
         ],
         "meta": { ... run info ... }
       }

   Usage (examples):
     # From a HF dataset id/split (requires `pip install datasets`)
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/locomo_driver.ts \
       --dataset_id some_org/LoCoMo \
       --split test \
       --seed 42 \
       --out outputs/memora/LoCoMo/LoCoMo_SEED42.json

     # From a local normalized JSON file
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/locomo_driver.ts \
       --from_file path/to/locomo.json \
       --seed 42
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
  let dataset_id = "";
  let split = "test";
  let from_file: string | null = null;
  let seed = 42;
  let limit: number | null = null;
  let out = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset_id" && argv[i + 1]) {
      dataset_id = argv[++i];
    } else if (a === "--split" && argv[i + 1]) {
      split = argv[++i];
    } else if (a === "--from_file" && argv[i + 1]) {
      from_file = argv[++i];
    } else if (a === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === "--limit" && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[++i];
    }
  }

  // Build a tag for filenames
  const tagBase = from_file
    ? path.basename(from_file).replace(/\*/g, "x")
    : (dataset_id || "locomo").replace(/[/:]/g, ".").replace(/\*/g, "x");

  // Default output follows project convention:
  // ./outputs/memora/LoCoMo/<tagBase>_SEED{seed}.json
  if (!out) {
    const baseDir = path.join("outputs", "memora", "LoCoMo");
    const fname = `${tagBase}_SEED${seed}.json`;
    out = path.join(baseDir, fname);
  }

  if (!dataset_id && !from_file) {
    // Runner requires one of dataset_id or from_file
    process.stderr.write("ERROR: Provide --dataset_id (requires `pip install datasets`) or --from_file\n");
    process.exit(2);
  }

  return { dataset_id, split, from_file, seed, limit, out, tagBase };
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

function dumpReferences(dataset_id: string, split: string, from_file: string | null, tagBase: string): Reference[] {
  // Write large JSON to a file to avoid ENOBUFS on stdout
  const cacheDir = path.join("outputs", "locomo_cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outFile = path.join(cacheDir, `${split}.${tagBase}.refs.json`);

  const args = ["benchmarks/locomo_helpers/dump_references.py"];
  if (from_file) {
    args.push("--from_file", from_file);
  } else {
    args.push("--dataset_id", dataset_id, "--split", split);
  }
  args.push("--out", outFile);

  execFileSync("python3", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 4 });

  const raw = fs.readFileSync(outFile, "utf8");
  const data = JSON.parse(raw) as Reference[];
  return data;
}

async function main() {
  const { dataset_id, split, from_file, seed, limit, out, tagBase } = parseArgs(process.argv.slice(2));

  // Load configs and initialize LLM
  const llmCfg = loadJSON<any>("benchmarks/config/llm.json");
  const memoraCfg = loadJSON<any>("benchmarks/config/memora.json");
  const openai = await createOpenAI();

  // 1) Load references
  let refs = dumpReferences(dataset_id, split, from_file, tagBase);
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
    client = new Client({ name: "memora-locomo-driver", version: "0.1.0" });
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
      context_id: `locomo-${seed}`,
      task_id: `locomo-${seed}`,
      env: "bench",
      api_version: "3.1"
    };
    await mcpClient.callTool("context.ensure_context", ctxParams);

    // 3) Replay long contexts once per unique context
    const seenContexts = new Set<string>();
    for (const r of refs) {
      const h = sha256(r.context || "");
      if (seenContexts.has(h)) continue;
      seenContexts.add(h);

      try {
        await adapter.writeIfSalient({
          text: r.context || "",
          tags: ["bench", "locomo", split, `source:${r.source ?? "unknown"}`],
          scope: "this_task",
          task_id: `locomo-${seed}`
        });
      } catch {
        // non-fatal
      }
    }

    // 4) Answer questions
    const results: {
      question_id: string;
      question: string;
      output: string;
      answer: string;
      tokens_in?: number;
      tokens_out?: number;
      llm_latency_ms?: number;
    }[] = [];

    const k = typeof memoraCfg?.retrieval_budget === "number" ? memoraCfg.retrieval_budget : 20;

    for (let i = 0; i < refs.length; i++) {
      const r = refs[i];
      const q = r.question || "";
      let contextText = "";

      try {
        // Retrieve and pack using Memora
        const filtersC: { scope: Scope[] } = { scope: ["this_task", "project"] };
        const pack = await adapter.pack(q || "question", k, {}, filtersC, { task_id: `locomo-${seed}` });
        contextText = (pack as any)?.data?.packed ?? "";
      } catch {
        // ignore retrieval/packing errors; continue with empty context
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
        // No LLM key -> stub empty output for plumbing validation
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

    // 5) Write predictions JSON
    const meta = {
      ts: new Date().toISOString(),
      dataset_id: dataset_id || null,
      from_file: from_file || null,
      split,
      seed,
      k,
      method: "memora",
      items: results.length
    };
    ensureDirForFile(out);
    writeJSON(out, { data: results, meta });
    process.stdout.write(`LoCoMo driver wrote ${results.length} predictions to ${out}\n`);
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
