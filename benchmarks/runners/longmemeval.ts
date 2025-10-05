/* benchmarks/runners/longmemeval.ts
   Node/TS runner scaffold for LongMemEval.
   - Parses args: --variant A|B|C, --seed, --out
   - Loads configs from benchmarks/config/*.json
   - For variant C, spawns Memora MCP server via stdio and exercises MemoryAdapter
   - Emits JSONL entries to the provided --out path
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import MemoryAdapter, { McpClient } from "../adapters/memora_adapter.js";

// MCP client SDK (ESM paths)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Variant = "A" | "B" | "C";

function parseArgs(argv: string[]) {
  let variant: Variant = "C";
  let seed = 42;
  let out = `benchmarks/reports/longmemeval.${variant}.${seed}.jsonl`;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant" && argv[i + 1]) {
      variant = argv[++i] as Variant;
    } else if (a === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === "--out" && argv[i + 1]) {
      out = argv[++i];
    }
  }
  return { variant, seed, out };
}

function readJson(p: string): any {
  const s = fs.readFileSync(p, "utf8");
  return JSON.parse(s);
}

function sha256File(p: string): string {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJSONL(filePath: string, obj: any) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

async function run() {
  const { variant, seed, out } = parseArgs(process.argv.slice(2));

  // Load configs (used for header and later harness params)
  const llmConfigPath = "benchmarks/config/llm.json";
  const memoraConfigPath = "benchmarks/config/memora.json";
  let llmConfig: any = {};

  try {
    llmConfig = readJson(llmConfigPath);
  } catch {
    // optional config missing
    void 0;
  }

  // Adapter hash for reproducibility
  const adapterPath = "benchmarks/adapters/memora_adapter.ts";
  const adapterHash = fs.existsSync(adapterPath) ? sha256File(adapterPath) : "";

  ensureDirForFile(out);

  // Trial header
  writeJSONL(out, {
    ts: new Date().toISOString(),
    op: "run_longmemeval",
    variant,
    seed,
    model_config_path: llmConfigPath,
    memora_config_path: memoraConfigPath,
    model: llmConfig?.model ?? "gpt-4.1-mini",
    temperature: llmConfig?.temperature ?? 0,
    streaming: llmConfig?.streaming ?? false,
    adapter_hash: adapterHash,
    harness_version: 1
  });

  if (variant !== "C") {
    // A/B placeholders – sliding window only, or vector baseline without Memora policies
    writeJSONL(out, {
      ts: new Date().toISOString(),
      op: "variant_selected",
      backend: variant === "A" ? "none" : "vector-baseline",
      success: true
    });
    process.stdout.write(`Wrote ${out}\n`);
    return;
  }

  // Variant C: exercise Memora MCP tools via stdio transport and MemoryAdapter
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    // Spawn Memora MCP server as a child process via stdio transport
    const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>;
    transport = new StdioClientTransport({
      command: "node",
      args: ["--import", "./scripts/register-ts-node.mjs", "src/index.ts"],
      cwd: process.cwd(),
      env
    });
    client = new Client({ name: "memora-bench-longmemeval", version: "0.1.0" });
    await client.connect(transport);

    const mcpClient: McpClient = {
      callTool: async (name: string, params?: any) => {
        const t0 = performance.now();
        try {
          // SDK client.callTool(name, params) in v1.19.x accepts params directly
          const res = await client!.callTool({ name, arguments: params ?? {} });
          const latency_ms = performance.now() - t0;
          writeJSONL(out, {
            ts: new Date().toISOString(),
            op: "mcp_call",
            tool: name,
            latency_ms,
            backend: "memora",
            success: true
          });
          return res;
        } catch (err: any) {
          const latency_ms = performance.now() - t0;
          writeJSONL(out, {
            ts: new Date().toISOString(),
            op: "mcp_call",
            tool: name,
            latency_ms,
            backend: "memora",
            success: false,
            error: String(err?.message ?? err)
          });
          throw err;
        }
      }
    };

    // Bootstrap context for this run
    const ctxParams = {
      tenant_id: "memora",
      project_id: "benchmarks",
      context_id: `longmemeval-${seed}-C`,
      task_id: `longmemeval-${seed}`,
      env: "bench",
      api_version: "3.1"
    };
    await mcpClient.callTool("context.ensure_context", ctxParams);

    const adapter = new MemoryAdapter(mcpClient);

    // Connectivity check: salience-aware write
    try {
      const wr = await adapter.writeIfSalient({
        text: `LongMemEval seed=${seed} variant=${variant} connectivity check at ${new Date().toISOString()}`,
        tags: ["bench", "longmemeval", `seed:${seed}`, `variant:${variant}`],
        scope: "this_task",
        task_id: `longmemeval-${seed}`
      });
      writeJSONL(out, {
        ts: new Date().toISOString(),
        op: "write_if_salient",
        backend: "memora",
        success: true,
        latency_ms: wr.latency_ms,
        written: wr.data.written
      });
    } catch (err: any) {
      writeJSONL(out, {
        ts: new Date().toISOString(),
        op: "write_if_salient",
        backend: "memora",
        success: false,
        error: String(err?.message ?? err)
      });
    }

    // Connectivity check: retrieval
    try {
      const sr = await adapter.search("connectivity check", 3, { scope: ["this_task", "project"] }, { task_id: `longmemeval-${seed}` });
      writeJSONL(out, {
        ts: new Date().toISOString(),
        op: "search",
        backend: "memora",
        success: true,
        latency_ms: sr.latency_ms,
        k: 3,
        items_returned: sr.data.items?.length ?? 0
      });
    } catch (err: any) {
      writeJSONL(out, {
        ts: new Date().toISOString(),
        op: "search",
        backend: "memora",
        success: false,
        error: String(err?.message ?? err)
      });
    }
  } finally {
    try {
      await client?.close();
    } catch {
      // ignore close errors
      void 0;
    }
    try {
      await transport?.close();
    } catch {
      // ignore close errors
      void 0;
    }
  }

  process.stdout.write(`Wrote ${out}\n`);
}

run().catch((err) => {
  // Emit a terminal JSONL error if possible (fallback path is stdout)
  try {
    const { out } = parseArgs(process.argv.slice(2));
    ensureDirForFile(out);
    writeJSONL(out, {
      ts: new Date().toISOString(),
      op: "error",
      message: String((err as any)?.message ?? err)
    });
  } catch {
    // ignore JSONL error write failures
    void 0;
  }
  console.error(err);
  process.exit(1);
});
