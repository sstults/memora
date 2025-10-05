/* benchmarks/runners/aggregate_longmemeval.ts
   Aggregate latency and token metrics from a LongMemEval predictions JSONL.

   Inputs:
     --in      Path to predictions JSONL (contains mixed telemetry + predictions)
     --outcsv  Path to write CSV summary (optional; defaults beside input)
     --outmd   Path to write Markdown summary (optional; defaults beside input)

   The driver writes per-prediction lines like:
     {"question_id":"...", "hypothesis":"...", "tokens_in":123, "tokens_out":45, "llm_latency_ms":789.0}

   And telemetry lines for MCP tool calls like:
     {"ts":"...","op":"mcp_call","tool":"context.ensure_context","latency_ms":12.3,"backend":"memora","success":true}

   This script computes:
     - LLM latency p50/p95 and mean
     - Token counts (in/out) mean, p50/p95, and sum
     - MCP tool call latency p50/p95 and mean per tool and overall
*/

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

type Aggregates = {
  llmLatencies: number[];
  tokensIn: number[];
  tokensOut: number[];
  mcpLatenciesByTool: Record<string, number[]>;
  mcpLatenciesAll: number[];
};

function parseArgs(argv: string[]) {
  let inPath = "";
  let outCsv = "";
  let outMd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in" && argv[i + 1]) {
      inPath = argv[++i];
    } else if (a === "--outcsv" && argv[i + 1]) {
      outCsv = argv[++i];
    } else if (a === "--outmd" && argv[i + 1]) {
      outMd = argv[++i];
    }
  }
  if (!inPath) {
    throw new Error("Missing --in <path to predictions JSONL>");
  }
  const base = inPath.replace(/\.jsonl$/i, "");
  if (!outCsv) outCsv = `${base}.stats.csv`;
  if (!outMd) outMd = `${base}.stats.md`;
  return { inPath, outCsv, outMd };
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function aggregateFile(inPath: string): Promise<Aggregates> {
  const agg: Aggregates = {
    llmLatencies: [],
    tokensIn: [],
    tokensOut: [],
    mcpLatenciesByTool: {},
    mcpLatenciesAll: []
  };

  const stream = fs.createReadStream(inPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const lineRaw of rl) {
    const s = lineRaw.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }

    // Prediction line from driver with tokens/latency
    if (obj && typeof obj === "object" && "question_id" in obj) {
      const li = Number(obj.llm_latency_ms);
      if (Number.isFinite(li)) agg.llmLatencies.push(li);

      const ti = Number(obj.tokens_in);
      if (Number.isFinite(ti)) agg.tokensIn.push(ti);

      const to = Number(obj.tokens_out);
      if (Number.isFinite(to)) agg.tokensOut.push(to);
      continue;
    }

    // MCP call telemetry
    if (obj && obj.op === "mcp_call") {
      const tool = String(obj.tool ?? "unknown");
      const lat = Number(obj.latency_ms);
      if (Number.isFinite(lat)) {
        agg.mcpLatenciesAll.push(lat);
        if (!agg.mcpLatenciesByTool[tool]) agg.mcpLatenciesByTool[tool] = [];
        agg.mcpLatenciesByTool[tool].push(lat);
      }
      continue;
    }
  }

  return agg;
}

function toCsv(agg: Aggregates): string {
  const rows: string[] = [];
  rows.push("metric,scope,tool,count,mean,p50,p95,sum");

  // LLM latency
  {
    const arr = [...agg.llmLatencies].sort((a, b) => a - b);
    const cnt = arr.length;
    const m = mean(arr);
    const p50 = percentile(arr, 50);
    const p95 = percentile(arr, 95);
    rows.push(`llm_latency_ms,prediction,,${cnt},${isNaN(m) ? "" : m.toFixed(3)},${isNaN(p50) ? "" : p50.toFixed(3)},${isNaN(p95) ? "" : p95.toFixed(3)},`);
  }

  // Tokens
  {
    const inArr = [...agg.tokensIn].sort((a, b) => a - b);
    const outArr = [...agg.tokensOut].sort((a, b) => a - b);
    const inCnt = inArr.length;
    const outCnt = outArr.length;
    const inMean = mean(inArr);
    const outMean = mean(outArr);
    const inP50 = percentile(inArr, 50);
    const inP95 = percentile(inArr, 95);
    const outP50 = percentile(outArr, 50);
    const outP95 = percentile(outArr, 95);
    const inSum = inArr.reduce((a, b) => a + b, 0);
    const outSum = outArr.reduce((a, b) => a + b, 0);
    rows.push(`tokens_in,prediction,,${inCnt},${isNaN(inMean) ? "" : inMean.toFixed(3)},${isNaN(inP50) ? "" : inP50.toFixed(3)},${isNaN(inP95) ? "" : inP95.toFixed(3)},${inSum}`);
    rows.push(`tokens_out,prediction,,${outCnt},${isNaN(outMean) ? "" : outMean.toFixed(3)},${isNaN(outP50) ? "" : outP50.toFixed(3)},${isNaN(outP95) ? "" : outP95.toFixed(3)},${outSum}`);
  }

  // MCP overall
  {
    const arr = [...agg.mcpLatenciesAll].sort((a, b) => a - b);
    const cnt = arr.length;
    const m = mean(arr);
    const p50 = percentile(arr, 50);
    const p95 = percentile(arr, 95);
    rows.push(`mcp_latency_ms,telemetry,ALL,${cnt},${isNaN(m) ? "" : m.toFixed(3)},${isNaN(p50) ? "" : p50.toFixed(3)},${isNaN(p95) ? "" : p95.toFixed(3)},`);
  }

  // MCP per tool
  for (const [tool, arr0] of Object.entries(agg.mcpLatenciesByTool)) {
    const arr = [...arr0].sort((a, b) => a - b);
    const cnt = arr.length;
    const m = mean(arr);
    const p50 = percentile(arr, 50);
    const p95 = percentile(arr, 95);
    rows.push(`mcp_latency_ms,telemetry,${tool},${cnt},${isNaN(m) ? "" : m.toFixed(3)},${isNaN(p50) ? "" : p50.toFixed(3)},${isNaN(p95) ? "" : p95.toFixed(3)},`);
  }

  return rows.join("\n") + "\n";
}

function toMarkdown(agg: Aggregates): string {
  const llmArr = [...agg.llmLatencies].sort((a, b) => a - b);
  const llmCnt = llmArr.length;
  const llmMean = mean(llmArr);
  const llmP50 = percentile(llmArr, 50);
  const llmP95 = percentile(llmArr, 95);

  const tiArr = [...agg.tokensIn].sort((a, b) => a - b);
  const toArr = [...agg.tokensOut].sort((a, b) => a - b);
  const tiSum = tiArr.reduce((a, b) => a + b, 0);
  const toSum = toArr.reduce((a, b) => a + b, 0);

  const mcpAll = [...agg.mcpLatenciesAll].sort((a, b) => a - b);
  const mcpCnt = mcpAll.length;
  const mcpMean = mean(mcpAll);
  const mcpP50 = percentile(mcpAll, 50);
  const mcpP95 = percentile(mcpAll, 95);

  const lines: string[] = [];
  lines.push(`# LongMemEval Aggregates`);
  lines.push("");
  lines.push(`- LLM latency (ms): count=${llmCnt}, mean=${isNaN(llmMean) ? "-" : llmMean.toFixed(3)}, p50=${isNaN(llmP50) ? "-" : llmP50.toFixed(3)}, p95=${isNaN(llmP95) ? "-" : llmP95.toFixed(3)}`);
  lines.push(`- Tokens In: count=${tiArr.length}, sum=${tiSum}, mean=${isNaN(mean(tiArr)) ? "-" : mean(tiArr).toFixed(3)}, p50=${isNaN(percentile(tiArr, 50)) ? "-" : percentile(tiArr, 50).toFixed(3)}, p95=${isNaN(percentile(tiArr, 95)) ? "-" : percentile(tiArr, 95).toFixed(3)}`);
  lines.push(`- Tokens Out: count=${toArr.length}, sum=${toSum}, mean=${isNaN(mean(toArr)) ? "-" : mean(toArr).toFixed(3)}, p50=${isNaN(percentile(toArr, 50)) ? "-" : percentile(toArr, 50).toFixed(3)}, p95=${isNaN(percentile(toArr, 95)) ? "-" : percentile(toArr, 95).toFixed(3)}`);
  lines.push(`- MCP Latency (ms, all tools): count=${mcpCnt}, mean=${isNaN(mcpMean) ? "-" : mcpMean.toFixed(3)}, p50=${isNaN(mcpP50) ? "-" : mcpP50.toFixed(3)}, p95=${isNaN(mcpP95) ? "-" : mcpP95.toFixed(3)}`);
  lines.push("");
  lines.push(`## MCP Latency by Tool (ms)`);
  for (const [tool, arr0] of Object.entries(agg.mcpLatenciesByTool)) {
    const arr = [...arr0].sort((a, b) => a - b);
    const cnt = arr.length;
    const m = mean(arr);
    const p50 = percentile(arr, 50);
    const p95 = percentile(arr, 95);
    lines.push(`- ${tool}: count=${cnt}, mean=${isNaN(m) ? "-" : m.toFixed(3)}, p50=${isNaN(p50) ? "-" : p50.toFixed(3)}, p95=${isNaN(p95) ? "-" : p95.toFixed(3)}`);
  }
  lines.push("");
  lines.push(`Note: LLM usage tokens are taken from API usage when available; otherwise estimated from text length.`);
  return lines.join("\n") + "\n";
}

async function main() {
  const { inPath, outCsv, outMd } = parseArgs(process.argv.slice(2));
  const agg = await aggregateFile(inPath);
  const csv = toCsv(agg);
  const md = toMarkdown(agg);
  ensureDirForFile(outCsv);
  ensureDirForFile(outMd);
  fs.writeFileSync(outCsv, csv, "utf8");
  fs.writeFileSync(outMd, md, "utf8");
  process.stdout.write(`Aggregates written:\n- CSV: ${path.resolve(outCsv)}\n- Markdown: ${path.resolve(outMd)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
