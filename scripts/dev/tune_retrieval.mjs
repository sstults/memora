#!/usr/bin/env node
/* eslint-env node */
/* global console, process */
/* eslint-disable no-console */
/**
 * scripts/dev/tune_retrieval.mjs
 * Orchestrate retrieval tuning runs by applying MEMORA_RETRIEVAL_* overrides and invoking benchmark drivers/scorers.
 *
 * Usage:
 *   node scripts/dev/tune_retrieval.mjs \
 *     --scenarios scripts/dev/scenarios/retrieval_sweep.small.json \
 *     --dataset benchmarks/LongMemEval/data/longmemeval_oracle.json \
 *     --seed 42
 *
 * Scenario file format (JSON):
 * [
 *   {
 *     "name": "base",
 *     "overrides": {},
 *     "env": {}
 *   },
 *   {
 *     "name": "sem150",
 *     "overrides": { "stages": { "semantic": { "top_k": 150 } } }
 *   }
 * ]
 *
 * Notes:
 * - Overrides are passed via MEMORA_RETRIEVAL_OVERRIDES_JSON.
 * - Additional env vars (e.g., MEMORA_RERANK_ENABLED=true) can be set per scenario via "env".
 * - Outputs are written under benchmarks/reports/, with scenario name in filenames.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = {
    scenarios: "scripts/dev/scenarios/retrieval_sweep.small.json",
    dataset: "benchmarks/LongMemEval/data/longmemeval_oracle.json",
    seed: 42
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scenarios" && argv[i + 1]) args.scenarios = argv[++i];
    else if (a === "--dataset" && argv[i + 1]) args.dataset = argv[++i];
    else if (a === "--seed" && argv[i + 1]) args.seed = Number(argv[++i]);
  }
  return args;
}

function readScenarios(p) {
  try {
    const raw = fs.readFileSync(path.resolve(p), "utf8");
    const json = JSON.parse(raw);
    if (Array.isArray(json)) return json;
  } catch (e) {
    console.error(`[tune] Failed to read scenarios from ${p}: ${e?.message || e}`);
  }
  return [];
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sanitize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function runStep(cmd, args, env) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    env
  });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")} (exit ${res.status})`);
  }
}

async function main() {
  const { scenarios: scenariosPath, dataset, seed } = parseArgs(process.argv.slice(2));
  const scenarios = readScenarios(scenariosPath);
  if (!scenarios.length) {
    console.error(`[tune] No scenarios found in ${scenariosPath}`);
    process.exit(2);
  }
  console.log(`[tune] Loaded ${scenarios.length} scenario(s) from ${scenariosPath}`);

  for (const sc of scenarios) {
    const name = sc?.name || "scenario";
    const tag = sanitize(name);
    const overrides = sc?.overrides ?? {};
    const extraEnv = sc?.env ?? {};
    const overridesJson = JSON.stringify(overrides);

    const out = `benchmarks/reports/memora_predictions.${tag}.jsonl`;
    ensureDirForFile(out);

    // Build environment for this scenario
    const env = {
      ...process.env,
      MEMORA_RETRIEVAL_OVERRIDES_JSON: overridesJson,
      ...extraEnv
    };

    // Optional: adjust HNSW ef_search if provided in scenario env
    if (extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, "KNN_EF_SEARCH")) {
      const ef = String(extraEnv.KNN_EF_SEARCH);
      if (ef && ef.trim().length > 0) {
        console.log(`[tune] Updating ef_search=${ef}`);
        runStep("bash", ["scripts/dev/update_semantic_ef_search.sh", ef], env);
      }
    }

    // Run driver (Variant C)
    const driverArgs = [
      "--import",
      "./scripts/register-ts-node.mjs",
      "benchmarks/runners/longmemeval_driver.ts",
      "--dataset",
      dataset,
      "--out",
      out,
      "--variant",
      "C",
      "--seed",
      String(seed)
    ];
    console.log(`[tune] Running driver for scenario=${name} -> ${out}`);
    runStep("node", driverArgs, env);

    // Run scorer
    const scoreArgs = [
      "--import",
      "./scripts/register-ts-node.mjs",
      "benchmarks/runners/score_longmemeval.ts",
      "--hyp",
      out,
      "--dataset",
      dataset,
      "--tag",
      tag
    ];
    console.log(`[tune] Scoring results for scenario=${name}`);
    runStep("node", scoreArgs, env);

    console.log(`[tune] Completed scenario=${name}`);
  }

  console.log("[tune] All scenarios complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
