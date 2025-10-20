#!/usr/bin/env node
// Test enhanced entity extraction with sample LongMemEval-style questions

import { extractEntities } from "../../src/services/entity-extraction.js";

const testQuestions = [
  "What was the first issue I had with my new car after its first service?",
  "Which event did I attend first, the 'Effective Time Management' workshop or the 'Data Analysis using Python' webinar?",
  "How many days before the team meeting I was preparing for did I attend the workshop on 'Effective Communication in the Workplace'?",
  "What advice did Emily give me about dealing with difficult colleagues?",
  "What task did I complete 3 weeks ago?",
  "What happened yesterday at the office?",
  "What did I plan for next month?",
  "Tell me about the meeting with April last week.",
  "What is BM25 used for in search?",
  "I met with Sarah 7 days ago, what did we discuss?",
  "What event is scheduled for a fortnight from now?",
  "Remind me what happened in April 2024.",
];

// Use a fixed reference date for deterministic testing
const referenceDate = new Date("2025-10-19T12:00:00Z");

console.log("=== Enhanced Entity Extraction Tests ===");
console.log(`Reference date: ${referenceDate.toISOString().split('T')[0]}\n`);

for (const question of testQuestions) {
  console.log(`Q: ${question}`);
  const entities = extractEntities(question, referenceDate);

  if (entities.dates.length > 0) {
    console.log(`  📅 Dates: ${entities.dates.join(", ")}`);
  }
  if (entities.normalized_dates && entities.normalized_dates.length > 0) {
    console.log(`  🗓️  Normalized Dates: ${entities.normalized_dates.join(", ")}`);
  }
  if (entities.numbers.length > 0) {
    console.log(`  🔢 Numbers: ${entities.numbers.join(", ")}`);
  }
  if (entities.temporal_units && entities.temporal_units.length > 0) {
    console.log(`  ⏱️  Temporal Units: ${entities.temporal_units.join(", ")}`);
  }
  if (entities.entities.length > 0) {
    console.log(`  🏷️  Entities: ${entities.entities.join(", ")}`);
  }
  if (entities.disambiguated_entities && entities.disambiguated_entities.length > 0) {
    console.log(`  🔍 Disambiguated: ${entities.disambiguated_entities.join(", ")}`);
  }
  if (entities.acronyms && entities.acronyms.size > 0) {
    console.log(`  📖 Acronyms: ${Array.from(entities.acronyms.entries()).map(([k, v]) => `${k} ↔ ${v}`).join(", ")}`);
  }

  console.log("");
}

// Additional test: temporal normalization accuracy
console.log("=== Temporal Normalization Accuracy Tests ===\n");

const temporalTests = [
  { text: "yesterday", expectedDate: "2025-10-18" },
  { text: "today", expectedDate: "2025-10-19" },
  { text: "tomorrow", expectedDate: "2025-10-20" },
  { text: "last week", expectedDate: "2025-10-12" },
  { text: "3 days ago", expectedDate: "2025-10-16" },
  { text: "7 days ago", expectedDate: "2025-10-12" },
  { text: "2 weeks ago", expectedDate: "2025-10-05" },
];

for (const test of temporalTests) {
  const result = extractEntities(test.text, referenceDate);
  const normalized = result.normalized_dates?.[0] || "NONE";
  const status = normalized === test.expectedDate ? "✅" : "❌";
  console.log(`${status} "${test.text}" → Expected: ${test.expectedDate}, Got: ${normalized}`);
}

console.log("\n=== Temporal Unit Extraction Tests ===\n");

const unitTests = [
  { text: "3 weeks ago", expected: ["3 weeks", "21 days"] },
  { text: "a fortnight", expected: ["14 days"] },
  { text: "7 days", expected: ["7 days"] },
  { text: "2 months later", expected: ["2 months", "60 days"] },
];

for (const test of unitTests) {
  const result = extractEntities(test.text, referenceDate);
  const units = result.temporal_units || [];
  const hasAll = test.expected.every(exp => units.includes(exp));
  const status = hasAll ? "✅" : "❌";
  console.log(`${status} "${test.text}" → Expected: [${test.expected.join(", ")}], Got: [${units.join(", ")}]`);
}

console.log("\n=== Entity Disambiguation Tests ===\n");

const disambigTests = [
  { text: "I met April yesterday", expected: "April [name]" },
  { text: "The deadline is in April 2024", expected: "April [month]" },
  { text: "May I ask a question?", expected: "May [name]" }, // At sentence start, no date indicators
  { text: "The report is due in May", expected: "May [month]" },
];

for (const test of disambigTests) {
  const result = extractEntities(test.text, referenceDate);
  const disambig = result.disambiguated_entities || [];
  const found = disambig.find(e => e.includes(test.expected.split(" ")[0]));
  const status = found === test.expected ? "✅" : "❌";
  console.log(`${status} "${test.text}" → Expected: "${test.expected}", Got: "${found || "NONE"}"`);
}

console.log("\n=== Test Complete ===");
