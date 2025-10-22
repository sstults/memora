#!/usr/bin/env npx tsx
/**
 * Analyze failed questions from LongMemEval benchmark
 * Categorizes failures as retrieval vs reasoning issues
 */

import * as fs from "fs";

interface AutoevalLabel {
  model: string;
  label: boolean;
}

interface EvalResult {
  question_id: string;
  hypothesis: string;
  autoeval_label: AutoevalLabel;
}

interface MemorySnippet {
  id?: string;
  content: string;
  timestamp?: string;
  score?: number;
  source?: string;
}

interface TraceRecord {
  question_id: string;
  question?: string;
  gold_answer?: string;
  hypothesis?: string;
  retrieved?: MemorySnippet[];
  retrieval_stats?: {
    episodic_count?: number;
    semantic_count?: number;
    fused_count?: number;
    diversified_count?: number;
    reranked_count?: number;
  };
}

interface FailureAnalysis {
  question_id: string;
  question: string;
  gold_answer: string;
  hypothesis: string;
  retrieved_count: number;
  top_3_snippets: string[];
  category: "retrieval_failure" | "reasoning_failure" | "edge_case" | "unknown";
  notes: string;
}

async function main() {
  const evalFile = "benchmarks/reports/longmemeval.C.43.with_rerank.filtered.jsonl.eval-results-gpt-4o";
  const traceFile = "benchmarks/reports/longmemeval.C.43.with_rerank.jsonl";
  const outputFile = "benchmarks/reports/longmemeval.C.43.failure_analysis.json";

  console.log("📊 Analyzing LongMemEval failures...\n");

  // Step 1: Load eval results and identify failures
  const evalResults = fs
    .readFileSync(evalFile, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as EvalResult);

  const failures = evalResults.filter((r) => !r.autoeval_label.label);
  console.log(`Found ${failures.length} failures out of ${evalResults.length} total predictions`);
  console.log(`Failure rate: ${((failures.length / evalResults.length) * 100).toFixed(1)}%\n`);

  // Step 2: Load trace records for failed questions
  const failedQuestionIds = new Set(failures.map((f) => f.question_id));
  const traceRecords: Map<string, TraceRecord> = new Map();

  const lines = fs.readFileSync(traceFile, "utf-8").trim().split("\n");
  for (const line of lines) {
    const record = JSON.parse(line) as TraceRecord;
    if (failedQuestionIds.has(record.question_id)) {
      traceRecords.set(record.question_id, record);
    }
  }

  console.log(`Loaded trace data for ${traceRecords.size} failed questions\n`);

  // Step 3: Analyze each failure
  const analyses: FailureAnalysis[] = [];

  for (const failure of failures) {
    const trace = traceRecords.get(failure.question_id);
    if (!trace) {
      console.warn(`⚠️  No trace data for ${failure.question_id}`);
      continue;
    }

    const retrieved = trace.retrieved || [];
    const top3 = retrieved
      .slice(0, 3)
      .map((s) => s.content.substring(0, 150).replace(/\n/g, " "));

    // Simple heuristic categorization
    let category: FailureAnalysis["category"] = "unknown";
    let notes = "";

    if (failure.hypothesis === "I don't know." || failure.hypothesis.includes("I don't have")) {
      category = "retrieval_failure";
      notes = "LLM explicitly stated lack of information";
    } else if (retrieved.length === 0) {
      category = "retrieval_failure";
      notes = "No documents retrieved";
    } else if (retrieved.length < 3) {
      category = "retrieval_failure";
      notes = `Low retrieval count: ${retrieved.length}`;
    } else {
      // Need manual inspection if we have retrieved docs but wrong answer
      category = "reasoning_failure";
      notes = "Retrieved docs available, may be reasoning issue (needs manual review)";
    }

    analyses.push({
      question_id: failure.question_id,
      question: trace.question || "",
      gold_answer: trace.gold_answer || "",
      hypothesis: failure.hypothesis,
      retrieved_count: retrieved.length,
      top_3_snippets: top3,
      category,
      notes,
    });
  }

  // Step 4: Categorize and report
  const categoryCounts = {
    retrieval_failure: 0,
    reasoning_failure: 0,
    edge_case: 0,
    unknown: 0,
  };

  analyses.forEach((a) => categoryCounts[a.category]++);

  console.log("=".repeat(80));
  console.log("FAILURE CATEGORIZATION");
  console.log("=".repeat(80));
  console.log(`Retrieval Failures: ${categoryCounts.retrieval_failure} (${((categoryCounts.retrieval_failure / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  - Right document not found in top results`);
  console.log(`Reasoning Failures: ${categoryCounts.reasoning_failure} (${((categoryCounts.reasoning_failure / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  - Right document retrieved, wrong answer produced`);
  console.log(`Edge Cases: ${categoryCounts.edge_case} (${((categoryCounts.edge_case / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  - Ambiguous questions or data issues`);
  console.log(`Unknown: ${categoryCounts.unknown} (${((categoryCounts.unknown / analyses.length) * 100).toFixed(1)}%)`);
  console.log(`  - Requires manual inspection`);
  console.log("");

  // Step 5: Show sample failures by category
  console.log("=".repeat(80));
  console.log("SAMPLE FAILURES");
  console.log("=".repeat(80));

  for (const cat of ["retrieval_failure", "reasoning_failure"] as const) {
    const samples = analyses.filter((a) => a.category === cat).slice(0, 3);
    if (samples.length === 0) continue;

    console.log(`\n${cat.toUpperCase().replace(/_/g, " ")} (showing ${samples.length}):`);
    console.log("-".repeat(80));

    for (const sample of samples) {
      console.log(`\nQuestion ID: ${sample.question_id}`);
      console.log(`Question: ${sample.question.substring(0, 150)}...`);
      console.log(`Gold Answer: ${sample.gold_answer.substring(0, 100)}...`);
      console.log(`Hypothesis: ${sample.hypothesis.substring(0, 100)}...`);
      console.log(`Retrieved: ${sample.retrieved_count} documents`);
      if (sample.top_3_snippets.length > 0) {
        console.log(`Top snippet: ${sample.top_3_snippets[0]}...`);
      }
      console.log(`Notes: ${sample.notes}`);
    }
  }

  // Step 6: Save detailed analysis
  fs.writeFileSync(outputFile, JSON.stringify(analyses, null, 2));
  console.log(`\n✅ Detailed analysis saved to: ${outputFile}`);
  console.log(`\nRecommendations:`);
  if (categoryCounts.retrieval_failure > categoryCounts.reasoning_failure) {
    console.log(`- Focus on retrieval improvements (BM25 tuning, field boosts)`);
    console.log(`- Current retrieval is missing relevant documents`);
  } else {
    console.log(`- Focus on LLM reasoning improvements (better prompts, packing)`);
    console.log(`- Retrieval is finding documents but LLM isn't using them correctly`);
  }
}

main().catch(console.error);
