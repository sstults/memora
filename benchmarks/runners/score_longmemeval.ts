/* benchmarks/runners/score_longmemeval.ts
   Invoke LongMemEval's Python evaluator on a predictions JSONL produced by our driver.
   Usage:
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts \\
       --hyp benchmarks/reports/memora_predictions.jsonl \\
       --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \\
       --tag memora
*/
import "dotenv/config";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function parseArgs(argv: string[]) {
  let hyp = "benchmarks/reports/memora_predictions.jsonl";
  let dataset = "benchmarks/LongMemEval/data/longmemeval_oracle.json";
  let tag = "memora";
  let evalDir = "benchmarks/LongMemEval/src/evaluation";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hyp" && argv[i + 1]) hyp = argv[++i];
    else if (a === "--dataset" && argv[i + 1]) dataset = argv[++i];
    else if (a === "--tag" && argv[i + 1]) tag = argv[++i];
    else if (a === "--evalDir" && argv[i + 1]) evalDir = argv[++i];
  }
  return { hyp, dataset, tag, evalDir };
}

function assertFileExists(p: string, label: string) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}

function runPython(evalDir: string, pythonBin: string, args: string[]) {
  const res = spawnSync(pythonBin, args, {
    cwd: evalDir,
    stdio: "inherit"
  });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) {
    throw new Error(`${pythonBin} ${args.join(" ")} exited with code ${res.status}`);
  }
}

async function main() {
  const { hyp, dataset, tag, evalDir } = parseArgs(process.argv.slice(2));

  // Validate paths
  assertFileExists(evalDir, "Evaluation directory");
  assertFileExists(hyp, "Predictions JSONL (--hyp)");
  assertFileExists(dataset, "Dataset JSON (--dataset)");

  // Paths must be relative to evalDir for the Python scripts
  // Also pre-filter the hypotheses file to only include lines with {question_id, hypothesis}
  const hypAbs = path.resolve(hyp);
  const dsAbs = path.resolve(dataset);

  // Produce filtered hypotheses alongside original
  const filteredHypAbs = hypAbs.replace(/\.jsonl$/, ".filtered.jsonl");
  try {
    const raw = fs.readFileSync(hypAbs, "utf8").split(/\r?\n/);
    const out: string[] = [];
    for (const line of raw) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (obj && typeof obj === "object" && "question_id" in obj && "hypothesis" in obj) {
          out.push(JSON.stringify({ question_id: obj.question_id, hypothesis: obj.hypothesis }));
        }
      } catch {
        // ignore non-JSON lines (e.g., telemetry headers)
      }
    }
    fs.writeFileSync(filteredHypAbs, out.join("\n") + (out.length ? "\n" : ""), "utf8");
  } catch (e) {
    throw new Error(`Failed to pre-filter hypotheses JSONL: ${e}`);
  }

  const hypRel = path.relative(evalDir, filteredHypAbs);
  const dsRel = path.relative(evalDir, dsAbs);

  // Choose Python interpreter: prefer LongMemEval venv if present
  // evalDir = benchmarks/LongMemEval/src/evaluation
  // venv is at benchmarks/LongMemEval/.venv-longmemeval/bin/python3 (two levels up)
  const candidates = [
    path.resolve(evalDir, "../../.venv-longmemeval/bin/python3"),
    path.resolve(evalDir, "../.venv-longmemeval/bin/python3") // fallback if layout changes
  ];
  const venvPython = candidates.find((p) => fs.existsSync(p)) ?? "python3";

  // Ensure minimal evaluator dependencies (idempotent)
  // Workaround: httpx 0.28+ drops 'proxies' kwarg used by OpenAI client path in this evaluator.
  // Pin compatible versions to avoid TypeError: Client.__init__() got an unexpected keyword argument 'proxies'
  runPython(evalDir, venvPython, ["-m", "pip", "install", "httpx==0.27.2", "httpcore==1.0.7", "h11==0.14.0"]);
  if (fs.existsSync(path.resolve(evalDir, "../../requirements-lite.txt"))) {
    runPython(evalDir, venvPython, ["-m", "pip", "install", "-r", "../../requirements-lite.txt"]);
  }

  // Normalize model tag: LongMemEval expects a supported model tag (e.g., "gpt-4o")
  const allowedModels = new Set(["gpt-4o","gpt-4o-mini","gpt-4.1","gpt-4.1-mini"]);
  const modelTag = (tag && allowedModels.has(tag)) ? tag : "gpt-4o";
  const resultRel = `${hypRel}.eval-results-${modelTag}`;

  // 1) Evaluate QA (produces .log alongside the predictions path)
  runPython(evalDir, venvPython, ["evaluate_qa.py", modelTag, hypRel, dsRel]);

  // 2) Print metrics summary from the generated log (expects just log file and dataset)
  runPython(evalDir, venvPython, ["print_qa_metrics.py", resultRel, dsRel]);

  // Also echo absolute paths for convenience
  const resultAbs = path.resolve(evalDir, resultRel);
  process.stdout.write(
    `\nScoring complete.\n- Predictions (filtered used for eval): ${filteredHypAbs}\n- Eval Results: ${resultAbs}\n- Dataset: ${path.resolve(dataset)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
