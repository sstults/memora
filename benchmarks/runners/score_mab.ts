/* benchmarks/runners/score_mab.ts
   Score MemoryAgentBench predictions using an OpenAI judge, mirroring upstream evaluator logic.
   - Loads references from Hugging Face via benchmarks/mab_helpers/dump_references.py
   - Reads predictions JSON produced by mab_driver.ts at: outputs/{method}/{split}/{source}_SEED{seed}.json
   - For each reference/prediction pair, builds an evaluation prompt based on question_type and abstention flag
   - Calls OpenAI chat.completions with model gpt-4o (configurable via --judge) to get yes/no correctness
   - Writes a result file alongside predictions:
       outputs/{method}/{split}/.eval-results-{method}-{fileTag}
     containing JSONL log entries (one per question), similar to the upstream Python evaluator
   - Prints overall accuracy and per-question-type accuracy

   Usage:
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_mab.ts \\
       --method memora \\
       --source 'longmemeval_s*' \\
       --split Accurate_Retrieval \\
       --seed 42 \\
       [--pred outputs/memora/Accurate_Retrieval/longmemeval_s*_SEED42.json] \\
       [--judge gpt-4o]
*/
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

type Split = "Accurate_Retrieval";

interface Reference {
  question: string;
  answer: string;
  question_id: string;
  question_type: string;
  context: string;
  source?: string;
  abstention?: boolean;
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
  context: null; // to match upstream evaluator we null context in logs
  autoeval_label: {
    model: string;
    label: boolean;
  };
}

function parseArgs(argv: string[]) {
  let method = "memora";
  let source = "longmemeval_s*";
  let split: Split = "Accurate_Retrieval";
  let seed = 42;
  let judge = "gpt-4o";
  let pred = "";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--method" && argv[i + 1]) method = argv[++i];
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--split" && argv[i + 1]) split = argv[++i] as Split;
    else if (a === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
    else if (a === "--pred" && argv[i + 1]) pred = argv[++i];
    else if (a === "--judge" && argv[i + 1]) judge = argv[++i];
  }

  if (!pred) {
    pred = path.join("outputs", method, split, `${source}_SEED${seed}.json`);
  }

  return { method, source, split, seed, pred, judge };
}

function assertFileExists(p: string, label: string) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function dumpReferences(source: string, split: Split): Reference[] {
  // Avoid ENOBUFS by writing Python output to a file and reading it back
  const tagSafe = source.replace(/\*/g, "x");
  const outPath = path.join("outputs", "memora", split, `.refs-${tagSafe}.json`);
  ensureDirForFile(outPath);
  execFileSync(
    "python3",
    ["benchmarks/mab_helpers/dump_references.py", "--source", source, "--split", split, "--out", outPath],
    { encoding: "utf8" }
  );
  const json = fs.readFileSync(outPath, "utf8");
  const refs = JSON.parse(json) as Reference[];
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error("No references returned from HF dataset dump");
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

function getAnscheckPrompt(task: string, question: string, answer: string, response: string, abstention: boolean): string {
  if (!abstention) {
    if (task === "single-session-user" || task === "single-session-assistant" || task === "multi-session") {
      const template =
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
      return template.replace("{}", question).replace("{}", answer).replace("{}", response);
    } else if (task === "temporal-reasoning") {
      const template =
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
      return template.replace("{}", question).replace("{}", answer).replace("{}", response);
    } else if (task === "knowledge-update") {
      const template =
        "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
      return template.replace("{}", question).replace("{}", answer).replace("{}", response);
    } else if (task === "single-session-preference") {
      const template =
        "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.";
      return template.replace("{}", question).replace("{}", answer).replace("{}", response);
    } else {
      throw new Error(`Unsupported question_type: ${task}`);
    }
  } else {
    const template =
      "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.";
    return template.replace("{}", question).replace("{}", answer).replace("{}", response);
  }
}

async function judgePair(openai: any, judgeModel: string, question: string, answer: string, response: string, qtype: string, abstention: boolean): Promise<boolean> {
  const prompt = getAnscheckPrompt(qtype, question, answer, response, abstention);
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

function fileTagFromPath(p: string): string {
  return path.basename(p).replace(/\.json$/i, "");
}

async function main() {
  const { method, source, split, pred, judge } = parseArgs(process.argv.slice(2));
  assertFileExists(pred, "Predictions JSON");

  // Load references and predictions
  const refs = dumpReferences(source, split);
  const predictions = JSON.parse(fs.readFileSync(pred, "utf8")) as { data: Prediction[]; meta?: any };
  const hyps: Prediction[] = Array.isArray(predictions?.data) ? predictions.data : [];

  if (hyps.length !== refs.length) {
    process.stdout.write(`Warning: predictions count (${hyps.length}) != references count (${refs.length}); proceeding by index position.\n`);
  }

  const openai = await createOpenAI();

  // Prepare result file path similar to upstream: .eval-results-{method}-{fileTag}
  const outDir = path.dirname(pred);
  const fileTag = fileTagFromPath(pred);
  const resultPath = path.join(outDir, `.eval-results-${method}-${fileTag}`);
  ensureDirForFile(resultPath);

  const qtype2acc: Record<string, number[]> = {};
  const logs: LogEntry[] = [];

  const n = Math.min(refs.length, hyps.length);
  for (let idx = 0; idx < n; idx++) {
    const r = refs[idx];
    const h = hyps[idx];

    // Upstream expects the answer embedded in the predictions to match the reference answer
    if ((h?.answer ?? "") !== (r?.answer ?? "")) {
      process.stdout.write(`ans mismatch at idx=${idx}; qid=${r?.question_id}\n`);
      // continue but do not throw; mirror upstream behavior (they throw), we will be permissive but note mismatch
    }

    const qtype = r.question_type ?? "unknown";
    if (!qtype2acc[qtype]) qtype2acc[qtype] = [];

    let label = false;
    try {
      label = await judgePair(openai, judge, r.question, r.answer, h?.output ?? "", qtype, !!r.abstention);
    } catch (err: any) {
      process.stdout.write(`Judge failed at idx=${idx}; qid=${r?.question_id}; error=${String(err?.message ?? err)}\n`);
    }

    const entry: LogEntry = {
      question: r.question,
      answer: r.answer,
      question_id: r.question_id,
      question_type: qtype,
      context: null,
      autoeval_label: { model: judge, label }
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
