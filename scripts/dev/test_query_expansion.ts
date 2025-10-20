// scripts/dev/test_query_expansion.ts
// Quick test to verify query expansion is working

import { expandQuery, isTemporalQuery, extractTemporalEntities } from "../../src/services/query-expansion.js";

console.log("=== Query Expansion Tests ===\n");

const testQueries = [
  "How many days between January 5 and January 15?",
  "What happened last week?",
  "Schedule meeting for tomorrow",
  "Report from 3 weeks ago",
  "Events in the last month",
  "What did I do yesterday?",
  "Plan for next week",
  "Status update from a fortnight ago",
  "Meeting scheduled in 5 days",
  "Review quarterly results"
];

for (const query of testQueries) {
  console.log(`Query: "${query}"`);

  const isTemporal = isTemporalQuery(query);
  console.log(`  Is Temporal: ${isTemporal}`);

  const expanded = expandQuery(query);
  if (expanded.hadTemporalExpansion) {
    console.log(`  Original: ${expanded.original}`);
    console.log(`  Expanded: ${expanded.expanded}`);
    console.log(`  Expansions: ${expanded.expansions.join(", ")}`);
  } else {
    console.log(`  No temporal expansion needed`);
  }

  const entities = extractTemporalEntities(query);
  if (entities.dates.length > 0 || entities.durations.length > 0 || entities.relativeRefs.length > 0) {
    console.log(`  Temporal Entities:`);
    if (entities.dates.length > 0) {
      console.log(`    Dates: ${entities.dates.join(", ")}`);
    }
    if (entities.durations.length > 0) {
      console.log(`    Durations: ${entities.durations.join(", ")}`);
    }
    if (entities.relativeRefs.length > 0) {
      console.log(`    Relative Refs: ${entities.relativeRefs.join(", ")}`);
    }
  }

  console.log();
}

console.log("=== LongMemEval Sample Queries ===\n");

// Sample queries from LongMemEval that are temporal in nature
const longMemEvalSamples = [
  "How many days passed between the first and last coffee experiment mentioned?",
  "What happened 7 days after the initial setup?",
  "How many weeks between project start and first milestone?",
  "What was discussed in the meeting last month?",
  "How many days from January 15 to January 20?"
];

for (const query of longMemEvalSamples) {
  console.log(`Query: "${query}"`);

  const expanded = expandQuery(query);
  console.log(`  Had Expansion: ${expanded.hadTemporalExpansion}`);
  if (expanded.hadTemporalExpansion) {
    console.log(`  Expansions: ${expanded.expansions.slice(0, 5).join(", ")}${expanded.expansions.length > 5 ? "..." : ""}`);
  }

  console.log();
}
