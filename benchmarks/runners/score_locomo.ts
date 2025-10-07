/* benchmarks/runners/score_locomo.ts
   Score LoCoMo-style predictions using an OpenAI judge with a generic QA rubric.
   - Loads references via benchmarks/locomo_helpers/dump_references.py (HF dataset or local JSON)
   - Reads predictions JSON produced by locomo_driver.ts at: outputs/memora/LoCoMo/<tag>_SEED{seed}.json
   - For each reference/prediction, builds a yes/no correctness prompt
   - Calls OpenAI chat.completions with a judge model (default gpt-4o)
   - Writes JSONL logs alongside the predictions file:
       <pred_dir>/.eval-results-<method>-<fileTag>
   - Prints overall accuracy and per-question_type accuracy (if provided)

   Usage (examples):
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_locomo.ts \\
       --method memora \\
       [--dataset_id some_org/LoCoMo --split test | --from_file path/to/locomo.json] \\
       [--pred outputs/memora/LoCoMo/LoCoMo_SEED42.json] \\
       [--judge gpt-4o]

   Notes:
   - If --dataset_id/--from_file are omitted, scorer will try to infer from predictions.meta.{dataset_id,from_file}.
*/
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

interface Reference {
  question: string;
  answer: string;
  question_id: string;
  question_type?: string | null;
  context: string;
  source?: string | null;
  abstention?: boolean | null;
}

interface Prediction {
  question_id: string;
  question: string;
  output: string;
  answer: string;
  tokens_in?: number;
  tokens_out?: number;
  llm_latency_ms?: number;
}

interface LogEntry {
  question: string;
  answer: string;
  question_id: string;
  question_type: string;
  context: null; // keep null in logs to reduce size
  autoeval_label: {
    model: string;
    label: boolean;
  };
}

function parseArgs(argv: string[]) {
  let method = "memora";
  let dataset_id = "";
  let from_file = "";
  let split = "test";
  let judge = "gpt-4o";
  let pred = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--method" && argv[i + 1]) method = argv[++i];
    else if (a === "--dataset_id" && argv[i + 1]) dataset_id = argv[++i];
    else if (a === "--from_file" && argv[i + 1]) from_file = argv[++i];
    else if (a === "--split" && argv[i + 1]) split = argv[++i];
    else if (a === "--judge" && argv[i + 1]) judge = argv[++i];
    else if (a === "--pred" && argv[i + 1]) pred = argv[++i];
  }
  return { method, dataset_id, from_file, split, judge, pred };
}

function assertFileExists(p: string, label: string) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function fileTagFromPath(p: string): string {
  return path.basename(p).replace(/\.json$/i, "");
}

function resolveRefsFromPredMeta(predMeta: any) {
  const dataset_id: string = predMeta?.dataset_id || "";
  const from_file: string = predMeta?.from_file || "";
  const split: string = predMeta?.split || "test";
  return { dataset_id, from_file, split };
}

function dumpReferences(dataset_id: string, split: string, from_file: string): Reference[] {
  // Avoid ENOBUFS by writing Python output to a file and reading it back
  const tagBase = from_file
    ? path.basename(from_file).replace(/\*/g, "x")
    : (dataset_id || "locomo").replace(/[/:]/g, ".").replace(/\*/g, "x");
  const outPath = path.join("outputs", "locomo_cache", `.refs-${split}.${tagBase}.json`);
  ensureDirForFile(outPath);

  const args = ["benchmarks/locomo_helpers/dump_references.py", "--out", outPath];
  if (from_file) {
    args.push("--from_file", from_file);
  } else {
    if (!dataset_id) {
      throw new Error("Missing dataset source. Provide --dataset_id/--split or --from_file or ensure predictions.meta has them.");
    }
    args.push("--dataset_id", dataset_id, "--split", split);
  }

  execFileSync("python3", args, { encoding: "utf8" });
  const json = fs.readFileSync(outPath, "utf8");
  const refs = JSON.parse(json) as Reference[];
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error("No references returned from dataset dump");
  }
  return refs;
}

async function createOpenAI(): Promise<any> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPEN_AI_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not set; required for judge");
  }
  const mod: any = await import("openai");
  const OpenAI = mod?.default ?? mod;
  return new OpenAI({ apiKey });
}

function getGenericPrompt(question: string, answer: string, response: string, abstention: boolean): string {
  if (!abstention) {
    const template =
      "I will give you a question, a correct answer, and a response from a model. Answer yes if the response contains or is equivalent to the correct answer; otherwise answer no. Do not explain.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
    return template.replace("{}", question).replace("{}", answer).replace("{}", response);
  } else {
    const template =
      "I will give you an unanswerable question, an explanation, and a response from a model. Answer yes if the model correctly identifies the question as unanswerable (e.g., says \"I don't know\" or indicates missing information). Otherwise answer no. Do not explain.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";
    return template.replace("{}", question).replace("{}", answer).replace("{}", response);
  }
}

async function judgePair(openai: any, judgeModel: string, question: string, answer: string, response: string, abstention: boolean): Promise<boolean> {
  const prompt = getGenericPrompt(question, answer, response, abstention);
  const t0 = performance.now();
  const completion = await openai.chat.completions.create({
    model: judgeModel,
    temperature: 0,
    max_tokens: 10,
    messages: [{ role: "user", content: prompt }]
  });
  /* latency ignored */ void (performance.now() - t0);
  const text = completion.choices?.[0]?.message?.content?.toString()?.trim()?.toLowerCase() ?? "";
  return text.includes("yes");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Load predictions
  if (!args.pred) {
    throw new Error("--pred is required or pass a path via NPM script");
  }
  assertFileExists(args.pred, "Predictions JSON");
  const predictions = JSON.parse(fs.readFileSync(args.pred, "utf8")) as { data: Prediction[]; meta?: any };

  // Resolve reference source
  let dataset_id = args.dataset_id;
  let from_file = args.from_file;
  let split = args.split;
  if (!dataset_id && !from_file) {
    const meta = predictions?.meta || {};
    const resolved = resolveRefsFromPredMeta(meta);
    dataset_id = resolved.dataset_id || dataset_id;
    from_file = resolved.from_file || from_file;
    split = resolved.split || split;
  }

  // Load references and predictions array
  const refs = dumpReferences(dataset_id, split, from_file);
  const hyps: Prediction[] = Array.isArray(predictions?.data) ? predictions.data : [];

  if (hyps.length !== refs.length) {
    process.stdout.write(`Warning: predictions count (${hyps.length}) != references count (${refs.length}); proceeding by index position.\n`);
  }

  const openai = await createOpenAI();

  // Prepare result file path: .eval-results-<method>-<fileTag>
  const outDir = path.dirname(args.pred);
  const fileTag = fileTagFromPath(args.pred);
  const resultPath = path.join(outDir, `.eval-results-${args.method}-${fileTag}`);
  ensureDirForFile(resultPath);

  const qtype2acc: Record<string, number[]> = {};
  const logs: LogEntry[] = [];

  const n = Math.min(refs.length, hyps.length);
  for (let idx = 0; idx < n; idx++) {
    const r = refs[idx];
    const h = hyps[idx];

    const qtype = (r?.question_type ?? "unknown") || "unknown";
    if (!qtype2acc[qtype]) qtype2acc[qtype] = [];

    let label = false;
    try {
      label = await judgePair(openai, args.judge, r.question, r.answer, h?.output ?? "", !!r.abstention);
    } catch (err: any) {
      process.stdout.write(`Judge failed at idx=${idx}; qid=${r?.question_id}; error=${String(err?.message ?? err)}\n`);
    }

    const entry: LogEntry = {
      question: r.question,
      answer: r.answer,
      question_id: r.question_id,
      question_type: qtype,
      context: null,
      autoeval_label: { model: args.judge, label }
    };
    logs.push(entry);
    fs.appendFileSync(resultPath, JSON.stringify(entry) + "\n", "utf8");
    qtype2acc[qtype].push(label ? 1 : 0);
  }

  // Summaries
  const overall = logs.length ? logs.reduce((s, x) => s + (x.autoeval_label.label ? 1 : 0), 0) / logs.length : 0;
  process.stdout.write(`Accuracy: ${overall.toFixed(4)}\n`);
  for (const k of Object.keys(qtype2acc)) {
    const v = qtype2acc[k];
    const acc = v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
    process.stdout.write(`\t${k}: ${acc.toFixed(4)} (${v.length})\n`);
  }
  process.stdout.write(`Saved results to ${resultPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
