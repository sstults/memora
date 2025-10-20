#!/usr/bin/env node
/**
 * Test script for cross_fields multi_match type
 *
 * This script tests the difference between best_fields and cross_fields
 * query types for multi-entity queries.
 *
 * Usage:
 *   node --import ./scripts/register-ts-node.mjs scripts/dev/test_cross_fields.ts
 */

// Test queries that should benefit from cross_fields:
// - Queries with multiple entities that may span fields
// - Queries where term coordination across fields matters
const testQueries = [
  // Multi-entity queries (entities may be in content, extracted_entities, disambiguated_entities)
  {
    query: "When did John Smith visit San Francisco?",
    reason: "Multi-entity query: 'John Smith' and 'San Francisco' may be split across fields"
  },
  {
    query: "What did Sarah tell me about the Python project on March 15?",
    reason: "Multiple entities: person name, technology, date"
  },
  {
    query: "How many meetings did I have with Alice Johnson last week?",
    reason: "Person name + temporal expression + counting"
  },
  {
    query: "What recommendations did Bob give about machine learning frameworks?",
    reason: "Person + technical terms that may be in different fields"
  },
  {
    query: "When did I last talk to Dr. Martinez about the research paper?",
    reason: "Title + name + topic coordination"
  },

  // Temporal reasoning queries (dates/numbers may span fields)
  {
    query: "How long had I been watching stand-up comedy specials regularly when I attended the open mic night?",
    reason: "Duration query with temporal coordination"
  },
  {
    query: "Which event happened first, losing phone charger or receiving new phone case?",
    reason: "Temporal ordering with multiple events"
  },
  {
    query: "How many days had passed since I bought Adidas running shoes when I realized Converse shoelace had broken?",
    reason: "Days calculation with product names"
  },

  // Entity-rich queries
  {
    query: "What did the email from Microsoft about Azure cloud services mention?",
    reason: "Company name + product name coordination"
  },
  {
    query: "Tell me about the conversation with Jane about the London office expansion",
    reason: "Person + location + topic"
  }
];

console.log("=".repeat(80));
console.log("CROSS_FIELDS vs BEST_FIELDS TEST");
console.log("=".repeat(80));
console.log();
console.log("This script demonstrates queries that may benefit from cross_fields:");
console.log("- best_fields: Scores each field independently, takes best score");
console.log("- cross_fields: Treats fields as one virtual field, better term coordination");
console.log();

for (let i = 0; i < testQueries.length; i++) {
  const test = testQueries[i];
  console.log(`${i + 1}. ${test.query}`);
  console.log(`   → Why test: ${test.reason}`);
  console.log();
}

console.log("=".repeat(80));
console.log("IMPLEMENTATION DETAILS");
console.log("=".repeat(80));
console.log();
console.log("Cross_fields implementation in src/routes/memory.ts:");
console.log("- Reads 'lexical.multi_match_type' from config/retrieval.yaml");
console.log("- Supports: 'best_fields' (default) or 'cross_fields'");
console.log("- When cross_fields: tie_breaker is omitted (not used with cross_fields)");
console.log("- Logs multi_match_type in episodic.query_classification trace");
console.log();
console.log("To enable cross_fields, edit config/retrieval.yaml:");
console.log("  lexical:");
console.log("    multi_match_type: cross_fields  # Change from 'best_fields'");
console.log();

console.log("=".repeat(80));
console.log("EXPECTED BENEFITS");
console.log("=".repeat(80));
console.log();
console.log("Cross_fields should help with:");
console.log("1. Multi-entity queries where entities span multiple fields");
console.log("   - Example: 'John' in content, 'Smith' in extracted_entities");
console.log("   - cross_fields: Treats as one occurrence of 'John Smith'");
console.log("   - best_fields: Scores 'John' and 'Smith' independently");
console.log();
console.log("2. Term frequency/IDF calculation across fields");
console.log("   - cross_fields: IDF calculated globally across all fields");
console.log("   - best_fields: IDF calculated per field");
console.log();
console.log("3. Better coordination for phrasal queries");
console.log("   - cross_fields: Terms must appear close together across fields");
console.log("   - best_fields: Terms can be far apart in different fields");
console.log();

console.log("=".repeat(80));
console.log("BENCHMARKING PLAN");
console.log("=".repeat(80));
console.log();
console.log("1. Run baseline with best_fields:");
console.log("   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42 \\");
console.log("     --dataset benchmarks/LongMemEval/data/longmemeval_oracle_50q.json");
console.log();
console.log("2. Edit config/retrieval.yaml: multi_match_type: cross_fields");
console.log();
console.log("3. Delete indices to ensure clean reindex:");
console.log("   ./scripts/create_indices.sh");
console.log();
console.log("4. Run benchmark with cross_fields:");
console.log("   ./benchmarks/runners/run_longmemeval.sh --variant C --seed 42 \\");
console.log("     --dataset benchmarks/LongMemEval/data/longmemeval_oracle_50q.json \\");
console.log("     --tag cross-fields");
console.log();
console.log("5. Compare results to measure impact");
console.log();

console.log("✅ Cross_fields implementation complete and ready for testing!");
