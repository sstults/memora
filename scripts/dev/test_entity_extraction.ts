#!/usr/bin/env node
// Test entity extraction with sample LongMemEval-style questions

import { extractEntities } from "../../src/services/entity-extraction.js";

const testQuestions = [
  "What was the first issue I had with my new car after its first service?",
  "Which event did I attend first, the 'Effective Time Management' workshop or the 'Data Analysis using Python' webinar?",
  "How many days before the team meeting I was preparing for did I attend the workshop on 'Effective Communication in the Workplace'?",
  "Which device did I got first, the Samsung Galaxy S22 or the Dell XPS 13?",
  "You attended the workshop on 'Effective Communication in the Workplace' on January 10th",
  "You were preparing for the team meeting on January 17th",
  "The Hindu festival of Holi was on February 26th",
  "You flew most with American Airlines in March and April",
  "You took the solo trip to Thailand first",
  "How many months ago did I book the Airbnb in San Francisco?"
];

console.log("=== Entity Extraction Tests ===\n");

for (const question of testQuestions) {
  console.log(`Q: ${question}`);
  const entities = extractEntities(question);

  if (entities.dates.length > 0) {
    console.log(`  📅 Dates: ${entities.dates.join(", ")}`);
  }
  if (entities.numbers.length > 0) {
    console.log(`  🔢 Numbers: ${entities.numbers.join(", ")}`);
  }
  if (entities.entities.length > 0) {
    console.log(`  🏷️  Entities: ${entities.entities.join(", ")}`);
  }
  console.log("");
}
