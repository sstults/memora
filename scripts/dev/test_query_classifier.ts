// scripts/dev/test_query_classifier.ts
// Test script for query classification and dynamic boosting
//
// Usage: node --import ./scripts/register-ts-node.mjs scripts/dev/test_query_classifier.ts

import { classifyQuery, getBoostProfile } from '../../src/services/query-classifier.js';

// Test queries from each category
const testQueries = [
  // Temporal reasoning queries
  {
    query: "What was the first issue I had with my new car after its first service?",
    expectedType: "temporal-reasoning"
  },
  {
    query: "How many days had passed between the Sunday mass and the Ash Wednesday service?",
    expectedType: "temporal-reasoning"
  },
  {
    query: "Which event happened first, the road trip to the coast or the arrival of the new prime lens?",
    expectedType: "temporal-reasoning"
  },

  // Multi-session queries
  {
    query: "How many items of clothing do I need to pick up or return from a store?",
    expectedType: "multi-session"
  },
  {
    query: "How much total money have I spent on bike-related expenses since the start of the year?",
    expectedType: "multi-session"
  },
  {
    query: "How many different doctors did I visit?",
    expectedType: "multi-session"
  },

  // Knowledge-update queries
  {
    query: "What was my personal best time in the charity 5K run?",
    expectedType: "knowledge-update"
  },
  {
    query: "Where did Rachel move to after her recent relocation?",
    expectedType: "knowledge-update"
  },
  {
    query: "How many bikes do I currently own?",
    expectedType: "knowledge-update"
  },

  // Single-session user queries
  {
    query: "What degree did I graduate with?",
    expectedType: "single-session"
  },
  {
    query: "Where do I take yoga classes?",
    expectedType: "single-session"
  },
  {
    query: "What color did I repaint my bedroom walls?",
    expectedType: "single-session"
  },

  // Preference/recommendation queries
  {
    query: "Can you recommend some resources where I can learn more about video editing?",
    expectedType: "preference"
  },
  {
    query: "Can you suggest a hotel for my upcoming trip to Miami?",
    expectedType: "preference"
  },
  {
    query: "Any tips for keeping my kitchen clean?",
    expectedType: "preference"
  },

  // Entity-focused queries
  {
    query: "What did Emily say about the conference in New York?",
    expectedType: "entity-focused"
  },
  {
    query: "Where did I buy my Samsung Galaxy S22?",
    expectedType: "entity-focused"
  },

  // Numerical queries
  {
    query: "How many hours did I spend on my abstract ocean sculpture?",
    expectedType: "numerical"
  },
  {
    query: "What was the amount I was pre-approved for when I got my mortgage?",
    expectedType: "numerical"
  },

  // Action-based queries
  {
    query: "What play did I attend at the local community theater?",
    expectedType: "action-based"
  },
  {
    query: "Where did I volunteer last month?",
    expectedType: "action-based"
  },
];

console.log("=== Query Classification Test ===\n");

let correctCount = 0;
let totalCount = 0;

for (const test of testQueries) {
  const classification = classifyQuery(test.query);
  const profile = getBoostProfile(classification.primaryType);

  const isCorrect = classification.primaryType === test.expectedType;
  const mark = isCorrect ? "✓" : "✗";

  if (isCorrect) correctCount++;
  totalCount++;

  console.log(`${mark} Query: "${test.query}"`);
  console.log(`  Expected: ${test.expectedType}`);
  console.log(`  Predicted: ${classification.primaryType} (confidence: ${(classification.confidence * 100).toFixed(1)}%)`);

  if (classification.secondaryTypes.length > 0) {
    console.log(`  Secondary: ${classification.secondaryTypes.join(", ")}`);
  }

  // Show key features that influenced classification
  const activeFeatures = Object.entries(classification.features)
    .filter(([_, value]) => value)
    .map(([key, _]) => key.replace('has', ''));

  if (activeFeatures.length > 0) {
    console.log(`  Features: ${activeFeatures.join(", ")}`);
  }

  console.log(`  Boost profile: ${profile.name} - ${profile.description}`);

  // Show top 3 field boosts for this profile
  const topBoosts = Object.entries(profile.fieldBoosts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 3)
    .map(([field, boost]) => `${field}^${boost}`)
    .join(", ");

  console.log(`  Top boosts: ${topBoosts}`);
  console.log();
}

console.log(`=== Summary ===`);
console.log(`Accuracy: ${correctCount}/${totalCount} (${((correctCount / totalCount) * 100).toFixed(1)}%)`);
console.log();

// Show all query types and their characteristics
console.log("=== Boost Profile Summary ===\n");

const queryTypes = [
  'temporal-reasoning',
  'multi-session',
  'knowledge-update',
  'single-session',
  'preference',
  'entity-focused',
  'numerical',
  'action-based'
] as const;

for (const type of queryTypes) {
  const profile = getBoostProfile(type);
  console.log(`${type}:`);
  console.log(`  Description: ${profile.description}`);

  // Show top 5 field boosts
  const topFieldBoosts = Object.entries(profile.fieldBoosts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 5)
    .map(([field, boost]) => `${field}=${boost}`)
    .join(", ");

  console.log(`  Top field boosts: ${topFieldBoosts}`);

  // Show top 5 phrase boosts
  const topPhraseBoosts = Object.entries(profile.phraseBoosts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, 5)
    .map(([field, boost]) => `${field}=${boost}`)
    .join(", ");

  console.log(`  Top phrase boosts: ${topPhraseBoosts}`);
  console.log();
}
