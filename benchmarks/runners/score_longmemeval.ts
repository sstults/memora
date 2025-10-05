/* benchmarks/runners/score_longmemeval.ts
   Invoke LongMemEval's Python evaluator on a predictions JSONL produced by our driver.
   Usage:
     node --import ./scripts/register-ts-node.mjs benchmarks/runners/score_longmemeval.ts \\
       --hyp benchmarks/reports/memora_predictions.jsonl \\
       --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \\
       --tag memora
*/
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

function runPython(evalDir: string, args: string[]) {
  const res = spawnSync("python3", args, {
    cwd: evalDir,
    stdio: "inherit"
  });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) {
    throw new Error(`python3 ${args.join(" ")} exited with code ${res.status}`);
  }
}

async function main() {
  const { hyp, dataset, tag, evalDir } = parseArgs(process.argv.slice(2));

  // Validate paths
  assertFileExists(evalDir, "Evaluation directory");
  assertFileExists(hyp, "Predictions JSONL (--hyp)");
  assertFileExists(dataset, "Dataset JSON (--dataset)");

  // Paths must be relative to evalDir for the Python scripts
  const hypRel = path.relative(evalDir, path.resolve(hyp));
  const dsRel = path.relative(evalDir, path.resolve(dataset));
  const logRel = `${hypRel}.log`;

  // 1) Evaluate QA (produces .log alongside the predictions path)
  runPython(evalDir, ["evaluate_qa.py", tag, hypRel, dsRel]);

  // 2) Print metrics summary from the generated log
  runPython(evalDir, ["print_qa_metrics.py", tag, logRel, dsRel]);

  // Also echo absolute paths for convenience
  process.stdout.write(
    `\nScoring complete.\n- Predictions: ${path.resolve(hyp)}\n- Log: ${path.resolve(hyp)}.log\n- Dataset: ${path.resolve(dataset)}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
