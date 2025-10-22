#!/usr/bin/env npx tsx
/* scripts/parse_benchmark_results.ts
   Standardized utility for parsing and comparing LongMemEval benchmark results.

   Usage:
     parse_benchmark_results.ts parse <eval-results-file>
     parse_benchmark_results.ts compare <baseline-file> <experiment-file>
*/

import * as fs from 'fs';

interface Metadata {
  timestamp: string;
  dataset: {
    path: string;
    name: string;
  };
  variant: string;
  seed: number;
  budget?: number;
  config: {
    llm: {
      model: string;
      temperature: number;
      max_tokens: number;
    };
    memora: {
      retrieval_budget: number;
      query_expansion_enabled: boolean;
      semantic_enabled: boolean;
      rerank_enabled: boolean;
    };
  };
  memora_version: string;
  git_commit: string;
}

interface QuestionResult {
  question_id: string;
  correct: boolean;
  hypothesis: string;
}

interface BenchmarkResult {
  metadata?: Metadata;
  total_questions: number;
  correct: number;
  accuracy: number;
  by_question: QuestionResult[];
}

function parseBenchmarkResults(evalResultsPath: string): BenchmarkResult {
  if (!fs.existsSync(evalResultsPath)) {
    console.error(`❌ Error: File not found: ${evalResultsPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(evalResultsPath, 'utf-8').split('\n').filter(l => l.trim());

  let metadata: Metadata | undefined = undefined;
  const results: QuestionResult[] = [];

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      console.warn(`⚠️  Warning: Failed to parse line: ${line.substring(0, 50)}...`);
      continue;
    }

    // Check for metadata line
    if (obj._metadata) {
      metadata = obj._metadata;
      continue;
    }

    // Parse eval result (must have question_id and autoeval_label)
    if (obj.question_id && obj.autoeval_label) {
      results.push({
        question_id: obj.question_id,
        correct: obj.autoeval_label?.label === true,
        hypothesis: obj.hypothesis || ''
      });
    }
  }

  if (results.length === 0) {
    console.error('❌ Error: No valid evaluation results found in file');
    process.exit(1);
  }

  const correct = results.filter(r => r.correct).length;

  return {
    metadata,
    total_questions: results.length,
    correct,
    accuracy: correct / results.length,
    by_question: results
  };
}

function formatMetadata(metadata: Metadata | undefined): string {
  if (!metadata) {
    return '  No metadata available (old format)';
  }

  return `  Dataset: ${metadata.dataset.name}
  Variant: ${metadata.variant}, Seed: ${metadata.seed}${metadata.budget ? `, Budget: ${metadata.budget}` : ''}
  LLM: ${metadata.config.llm.model} (temp=${metadata.config.llm.temperature})
  Features: semantic=${metadata.config.memora.semantic_enabled}, rerank=${metadata.config.memora.rerank_enabled}
  Version: ${metadata.memora_version} (${metadata.git_commit})
  Timestamp: ${metadata.timestamp}`;
}

function compareResults(baseline: BenchmarkResult, experiment: BenchmarkResult): void {
  console.log('=== Baseline Configuration ===');
  console.log(formatMetadata(baseline.metadata));
  console.log();
  console.log('=== Experiment Configuration ===');
  console.log(formatMetadata(experiment.metadata));
  console.log();

  // Check comparability
  let hasWarnings = false;

  if (baseline.metadata && experiment.metadata) {
    if (baseline.metadata.dataset.name !== experiment.metadata.dataset.name) {
      console.warn('⚠️  WARNING: Different datasets!');
      console.warn(`  Baseline:   ${baseline.metadata.dataset.name}`);
      console.warn(`  Experiment: ${experiment.metadata.dataset.name}`);
      hasWarnings = true;
    }

    if (baseline.metadata.seed !== experiment.metadata.seed) {
      console.warn('⚠️  WARNING: Different seeds - question sets may differ!');
      console.warn(`  Baseline:   ${baseline.metadata.seed}`);
      console.warn(`  Experiment: ${experiment.metadata.seed}`);
      hasWarnings = true;
    }
  } else {
    console.warn('⚠️  WARNING: Missing metadata in one or both files');
    console.warn('  Cannot verify dataset and configuration compatibility');
    hasWarnings = true;
  }

  if (baseline.total_questions !== experiment.total_questions) {
    console.error('❌ ERROR: Different number of questions - results not comparable');
    console.error(`  Baseline:   ${baseline.total_questions} questions`);
    console.error(`  Experiment: ${experiment.total_questions} questions`);
    process.exit(1);
  }

  if (hasWarnings) {
    console.log();
  }

  // Compare results
  console.log('=== Comparison ===');
  console.log(`Baseline:   ${baseline.correct}/${baseline.total_questions} (${(baseline.accuracy * 100).toFixed(1)}%)`);
  console.log(`Experiment: ${experiment.correct}/${experiment.total_questions} (${(experiment.accuracy * 100).toFixed(1)}%)`);

  const diff = experiment.correct - baseline.correct;
  const diffPct = (experiment.accuracy - baseline.accuracy) * 100;
  const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
  const diffPctStr = diffPct > 0 ? `+${diffPct.toFixed(1)}` : `${diffPct.toFixed(1)}`;

  if (diff > 0) {
    console.log(`Difference: ✅ ${diffStr} questions (${diffPctStr}%)`);
  } else if (diff < 0) {
    console.log(`Difference: ❌ ${diffStr} questions (${diffPctStr}%)`);
  } else {
    console.log(`Difference: ⚪ ${diffStr} questions (${diffPctStr}%)`);
  }
  console.log();

  // Show which questions changed
  const improved: string[] = [];
  const regressed: string[] = [];

  for (let i = 0; i < baseline.total_questions; i++) {
    if (baseline.by_question[i].question_id !== experiment.by_question[i].question_id) {
      console.error('❌ ERROR: Question order mismatch at position ' + i);
      console.error(`  Baseline:   ${baseline.by_question[i].question_id}`);
      console.error(`  Experiment: ${experiment.by_question[i].question_id}`);
      console.error('  Results not comparable - questions must be in same order');
      process.exit(1);
    }

    const b = baseline.by_question[i].correct;
    const e = experiment.by_question[i].correct;

    if (!b && e) improved.push(baseline.by_question[i].question_id);
    if (b && !e) regressed.push(baseline.by_question[i].question_id);
  }

  if (improved.length > 0) {
    console.log(`✅ Improved (${improved.length}):`);
    improved.forEach(id => console.log(`  - ${id}`));
    console.log();
  }

  if (regressed.length > 0) {
    console.log(`❌ Regressed (${regressed.length}):`);
    regressed.forEach(id => console.log(`  - ${id}`));
    console.log();
  }

  if (improved.length === 0 && regressed.length === 0) {
    console.log('⚪ No individual question differences (same questions correct/incorrect)');
    console.log();
  }
}

function showUsage(): void {
  console.log('Usage:');
  console.log('  parse_benchmark_results.ts parse <eval-results-file>');
  console.log('  parse_benchmark_results.ts compare <baseline-file> <experiment-file>');
  console.log();
  console.log('Commands:');
  console.log('  parse    - Parse and display results from a single benchmark run');
  console.log('  compare  - Compare two benchmark runs and show differences');
  console.log();
  console.log('Examples:');
  console.log('  # Parse single result');
  console.log('  npx tsx scripts/parse_benchmark_results.ts parse \\');
  console.log('    benchmarks/reports/longmemeval.C.60.baseline.filtered.jsonl.eval-results-gpt-4o');
  console.log();
  console.log('  # Compare two results');
  console.log('  npx tsx scripts/parse_benchmark_results.ts compare \\');
  console.log('    benchmarks/reports/longmemeval.C.60.baseline.filtered.jsonl.eval-results-gpt-4o \\');
  console.log('    benchmarks/reports/longmemeval.C.60.enhanced.filtered.jsonl.eval-results-gpt-4o');
}

// Main CLI
function main() {
  const command = process.argv[2];

  if (!command || command === '--help' || command === '-h') {
    showUsage();
    process.exit(0);
  }

  if (command === 'parse') {
    if (!process.argv[3]) {
      console.error('❌ Error: Missing eval-results-file argument');
      console.error();
      showUsage();
      process.exit(1);
    }

    const result = parseBenchmarkResults(process.argv[3]);

    console.log('=== Benchmark Results ===');
    console.log(formatMetadata(result.metadata));
    console.log();
    console.log(`Total Questions: ${result.total_questions}`);
    console.log(`Correct: ${result.correct}`);
    console.log(`Accuracy: ${(result.accuracy * 100).toFixed(1)}%`);

  } else if (command === 'compare') {
    if (!process.argv[3] || !process.argv[4]) {
      console.error('❌ Error: Missing baseline-file or experiment-file argument');
      console.error();
      showUsage();
      process.exit(1);
    }

    const baseline = parseBenchmarkResults(process.argv[3]);
    const experiment = parseBenchmarkResults(process.argv[4]);
    compareResults(baseline, experiment);

  } else {
    console.error(`❌ Error: Unknown command: ${command}`);
    console.error();
    showUsage();
    process.exit(1);
  }
}

main();
