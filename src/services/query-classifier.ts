// src/services/query-classifier.ts
// Query classification for dynamic boosting in lexical search.
//
// Classifies queries into types to enable adaptive field boosting:
// - temporal-reasoning: Queries about timing, sequences, durations
// - multi-session: Queries requiring aggregation across multiple conversations
// - single-session: Queries about specific events or facts from one conversation
// - knowledge-update: Queries seeking the latest/current state of information
// - preference: Queries asking for recommendations based on user history
// - entity-focused: Queries centered on specific people, places, or things
// - numerical: Queries involving counting, calculations, or numerical comparisons
// - action-based: Queries about activities, tasks, or events

export type QueryType =
  | 'temporal-reasoning'
  | 'multi-session'
  | 'single-session'
  | 'knowledge-update'
  | 'preference'
  | 'entity-focused'
  | 'numerical'
  | 'action-based';

export interface QueryClassification {
  primaryType: QueryType;
  secondaryTypes: QueryType[];
  confidence: number;
  features: {
    hasTemporal: boolean;
    hasAggregation: boolean;
    hasComparison: boolean;
    hasRecencySignal: boolean;
    hasEntityFocus: boolean;
    hasNumerical: boolean;
    hasActionVerbs: boolean;
    hasRecommendationRequest: boolean;
  };
}

// Temporal indicators (when, before, after, days, dates, sequences)
const TEMPORAL_PATTERNS = [
  /\b(first|last|before|after|ago|since|until|between|during|when|while)\b/i,
  /\b(yesterday|today|tomorrow|week|month|year|day|days|weeks|months|years)\b/i,
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /\b(how (many|long)|which.*first|what.*date|what time)\b/i,
  /\d{4}[-/]\d{2}[-/]\d{2}/,  // ISO dates
  /\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/,  // Common date formats
];

// Aggregation indicators (count, total, all, combined)
const AGGREGATION_PATTERNS = [
  /\b(how many|count|total|sum|all|combined|altogether|in total)\b/i,
  /\b(all the|every|each)\b/i,
];

// Comparison indicators (more, less, better, first vs second)
const COMPARISON_PATTERNS = [
  /\b(more|less|better|worse|faster|slower|bigger|smaller|higher|lower)\b/i,
  /\b(compare|comparison|versus|vs\.?|difference between)\b/i,
  /\b(which (one|is)|or)\b/i,
];

// Recency/update indicators (latest, current, recent, now, most recent)
const RECENCY_PATTERNS = [
  /\b(latest|current|recent|now|most recent|up to date|up-to-date|nowadays)\b/i,
  /\b(what is|where is|who is|how is)\b.*\b(now|currently|these days)\b/i,
];

// Entity focus indicators (specific names, places, products - capitalized words)
const ENTITY_PATTERNS = [
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/,  // Capitalized phrases
  /\b(named|called)\b/i,
];

// Numerical indicators (numbers, quantities, measurements)
const NUMERICAL_PATTERNS = [
  /\b\d+(\.\d+)?\b/,  // Any number
  /\b(how many|how much|number|quantity|amount|price|cost)\b/i,
];

// Action verbs (did, went, bought, attended, visited)
const ACTION_VERBS = [
  /\b(did|do|does|went|go|bought|buy|attended|attend|visited|visit|saw|see|met|meet|started|start|finished|finish|completed|complete|watched|watch|read|listened|listen|played|play|worked|work|created|create|made|make|took|take|gave|give)\b/i,
];

// Recommendation/preference indicators
const RECOMMENDATION_PATTERNS = [
  /\b(recommend|suggestion|suggest|advice|should I|what.*for me|help me (find|choose|decide))\b/i,
  /\b(prefer|like|love|enjoy|favorite|interested in)\b/i,
];

/**
 * Classify a query string into one or more query types.
 * Returns primary type, secondary types, and feature flags.
 */
export function classifyQuery(queryText: string): QueryClassification {
  // Extract features
  const features = {
    hasTemporal: TEMPORAL_PATTERNS.some(p => p.test(queryText)),
    hasAggregation: AGGREGATION_PATTERNS.some(p => p.test(queryText)),
    hasComparison: COMPARISON_PATTERNS.some(p => p.test(queryText)),
    hasRecencySignal: RECENCY_PATTERNS.some(p => p.test(queryText)),
    hasEntityFocus: ENTITY_PATTERNS.some(p => p.test(queryText)),
    hasNumerical: NUMERICAL_PATTERNS.some(p => p.test(queryText)),
    hasActionVerbs: ACTION_VERBS.some(p => p.test(queryText)),
    hasRecommendationRequest: RECOMMENDATION_PATTERNS.some(p => p.test(queryText)),
  };

  // Score each query type based on features
  const scores: Record<QueryType, number> = {
    'temporal-reasoning': 0,
    'multi-session': 0,
    'single-session': 0,
    'knowledge-update': 0,
    'preference': 0,
    'entity-focused': 0,
    'numerical': 0,
    'action-based': 0,
  };

  // Temporal reasoning: Strong temporal + comparison or sequences
  if (features.hasTemporal) {
    scores['temporal-reasoning'] += 3;
    if (features.hasComparison || /\b(first|last|before|after|between)\b/i.test(queryText)) {
      scores['temporal-reasoning'] += 2;
    }
    if (/\b(how many (days|weeks|months|years)|how long)\b/i.test(queryText)) {
      scores['temporal-reasoning'] += 2;
    }
  }

  // Multi-session: Aggregation across time or multiple instances
  if (features.hasAggregation) {
    scores['multi-session'] += 3;
    if (features.hasTemporal) {
      scores['multi-session'] += 2;  // "how many days combined", "all the times"
    }
  }

  // Knowledge update: Recency signals + state queries
  if (features.hasRecencySignal) {
    scores['knowledge-update'] += 3;
    if (/\b(what is|where is|who is|how is|how many.*currently)\b/i.test(queryText)) {
      scores['knowledge-update'] += 2;
    }
  }

  // Preference/recommendation: Explicit recommendation requests
  if (features.hasRecommendationRequest) {
    scores['preference'] += 5;  // Strong signal
  }

  // Entity-focused: Specific names + actions
  if (features.hasEntityFocus) {
    scores['entity-focused'] += 2;
    if (features.hasActionVerbs) {
      scores['entity-focused'] += 1;
    }
  }

  // Numerical: Numbers + counting/quantification
  if (features.hasNumerical) {
    scores['numerical'] += 2;
    if (/\b(how many|how much|count|total|sum)\b/i.test(queryText)) {
      scores['numerical'] += 2;
    }
  }

  // Action-based: Action verbs without strong temporal/aggregation
  if (features.hasActionVerbs) {
    scores['action-based'] += 2;
    if (/\b(what did|where did|who did|when did)\b/i.test(queryText)) {
      scores['action-based'] += 1;
    }
  }

  // Single-session: Default for specific fact queries without aggregation
  if (!features.hasAggregation && !features.hasRecencySignal && !features.hasRecommendationRequest) {
    scores['single-session'] += 2;
    if (features.hasActionVerbs || features.hasEntityFocus) {
      scores['single-session'] += 1;
    }
  }

  // Sort by score to get primary and secondary types
  const sortedTypes = (Object.keys(scores) as QueryType[])
    .sort((a, b) => scores[b] - scores[a]);

  const primaryType = sortedTypes[0];
  const primaryScore = scores[primaryType];

  // Secondary types have score >= 50% of primary score
  const secondaryTypes = sortedTypes
    .slice(1)
    .filter(type => scores[type] >= primaryScore * 0.5 && scores[type] > 0);

  // Confidence based on score gap between primary and second
  const secondScore = scores[sortedTypes[1]] || 0;
  const scoreGap = primaryScore - secondScore;
  const confidence = primaryScore > 0 ? Math.min(0.95, 0.5 + (scoreGap / 10)) : 0.3;

  return {
    primaryType,
    secondaryTypes,
    confidence,
    features,
  };
}

/**
 * Get boost profile for a query type.
 * Returns field boost multipliers and phrase boost multipliers.
 */
export interface BoostProfile {
  name: string;
  description: string;
  fieldBoosts: {
    content?: number;
    content_shingles?: number;
    tags?: number;
    artifacts?: number;
    content_raw?: number;
    extracted_entities?: number;
    extracted_dates?: number;
    extracted_numbers?: number;
    normalized_dates?: number;
    temporal_units?: number;
    disambiguated_entities?: number;
    acronyms?: number;
  };
  phraseBoosts: {
    entity_content?: number;
    entity_extracted?: number;
    date_content?: number;
    date_extracted?: number;
    date_normalized?: number;
    number_content?: number;
    number_extracted?: number;
    temporal_unit?: number;
    disambiguated_entity?: number;
    acronym?: number;
  };
}

/**
 * Get boost profile for a given query type.
 */
export function getBoostProfile(queryType: QueryType): BoostProfile {
  switch (queryType) {
    case 'temporal-reasoning':
      return {
        name: 'temporal-reasoning',
        description: 'Heavily boost dates, temporal units, and numbers for time-based queries',
        fieldBoosts: {
          content: 2.5,  // Reduce content boost (was 3.0)
          content_shingles: 1.2,
          tags: 2.0,
          artifacts: 1.0,
          content_raw: 0.5,
          extracted_entities: 2.0,  // Reduce entity boost (was 2.5)
          extracted_dates: 5.0,  // BOOST dates heavily (was 2.5)
          extracted_numbers: 4.0,  // BOOST numbers heavily (was 2.0)
          normalized_dates: 5.5,  // BOOST normalized dates (new)
          temporal_units: 5.0,  // BOOST temporal units (new)
          disambiguated_entities: 2.5,
          acronyms: 2.0,
        },
        phraseBoosts: {
          entity_content: 2.5,  // Reduce (was 3.0)
          entity_extracted: 3.5,  // Reduce (was 4.0)
          date_content: 4.0,  // BOOST (was 2.5)
          date_extracted: 6.0,  // BOOST (was 4.0)
          date_normalized: 7.0,  // BOOST (was 5.0)
          number_content: 3.5,  // BOOST (was 2.0)
          number_extracted: 5.0,  // BOOST (was 3.5)
          temporal_unit: 6.0,  // BOOST (was 4.5)
          disambiguated_entity: 5.0,
          acronym: 2.5,
        },
      };

    case 'multi-session':
      return {
        name: 'multi-session',
        description: 'Boost entities and numbers for aggregation queries across conversations',
        fieldBoosts: {
          content: 2.5,
          content_shingles: 1.5,  // Boost shingles for phrase matching
          tags: 2.5,
          artifacts: 1.0,
          content_raw: 0.5,
          extracted_entities: 3.5,  // BOOST entities (was 2.5)
          extracted_dates: 3.0,  // Moderate date boost
          extracted_numbers: 4.5,  // BOOST numbers heavily (was 2.0)
          normalized_dates: 3.0,
          temporal_units: 3.5,
          disambiguated_entities: 4.0,  // BOOST disambiguated
          acronyms: 2.5,
        },
        phraseBoosts: {
          entity_content: 3.5,  // BOOST (was 3.0)
          entity_extracted: 5.0,  // BOOST (was 4.0)
          date_content: 2.5,
          date_extracted: 4.0,
          date_normalized: 4.5,
          number_content: 3.0,  // BOOST (was 2.0)
          number_extracted: 5.5,  // BOOST (was 3.5)
          temporal_unit: 4.0,
          disambiguated_entity: 6.0,  // BOOST (was 5.0)
          acronym: 3.0,  // BOOST (was 2.5)
        },
      };

    case 'knowledge-update':
      return {
        name: 'knowledge-update',
        description: 'Boost entities and recent content for latest-state queries',
        fieldBoosts: {
          content: 3.5,  // BOOST content (was 3.0) - latest mentions matter
          content_shingles: 1.5,
          tags: 2.0,
          artifacts: 1.0,
          content_raw: 0.8,  // BOOST raw (was 0.5)
          extracted_entities: 4.0,  // BOOST entities heavily (was 2.5)
          extracted_dates: 2.0,  // Reduce date importance
          extracted_numbers: 2.5,
          normalized_dates: 2.0,
          temporal_units: 1.5,
          disambiguated_entities: 4.5,  // BOOST disambiguated (was 2.5)
          acronyms: 3.0,  // BOOST acronyms (was 2.0)
        },
        phraseBoosts: {
          entity_content: 4.0,  // BOOST (was 3.0)
          entity_extracted: 5.5,  // BOOST (was 4.0)
          date_content: 2.0,
          date_extracted: 3.0,
          date_normalized: 3.5,
          number_content: 2.5,
          number_extracted: 3.5,
          temporal_unit: 3.0,
          disambiguated_entity: 6.5,  // BOOST (was 5.0)
          acronym: 3.5,  // BOOST (was 2.5)
        },
      };

    case 'entity-focused':
      return {
        name: 'entity-focused',
        description: 'Heavily boost entity fields for queries about specific people, places, things',
        fieldBoosts: {
          content: 2.5,  // Reduce (was 3.0)
          content_shingles: 1.5,
          tags: 2.0,
          artifacts: 1.5,
          content_raw: 1.0,  // BOOST raw for exact matches
          extracted_entities: 5.0,  // BOOST heavily (was 2.5)
          extracted_dates: 2.0,
          extracted_numbers: 2.0,
          normalized_dates: 2.0,
          temporal_units: 1.5,
          disambiguated_entities: 5.5,  // BOOST heavily (was 2.5)
          acronyms: 4.0,  // BOOST acronyms (was 2.0)
        },
        phraseBoosts: {
          entity_content: 4.5,  // BOOST (was 3.0)
          entity_extracted: 7.0,  // BOOST heavily (was 4.0)
          date_content: 2.0,
          date_extracted: 3.5,
          date_normalized: 4.0,
          number_content: 2.0,
          number_extracted: 3.0,
          temporal_unit: 3.5,
          disambiguated_entity: 8.0,  // BOOST heavily (was 5.0)
          acronym: 5.0,  // BOOST (was 2.5)
        },
      };

    case 'numerical':
      return {
        name: 'numerical',
        description: 'Boost numbers and content for counting/calculation queries',
        fieldBoosts: {
          content: 3.0,
          content_shingles: 1.2,
          tags: 2.0,
          artifacts: 1.0,
          content_raw: 0.8,
          extracted_entities: 2.5,
          extracted_dates: 2.5,
          extracted_numbers: 5.5,  // BOOST heavily (was 2.0)
          normalized_dates: 2.5,
          temporal_units: 3.0,
          disambiguated_entities: 3.0,
          acronyms: 2.0,
        },
        phraseBoosts: {
          entity_content: 3.0,
          entity_extracted: 4.0,
          date_content: 2.5,
          date_extracted: 4.0,
          date_normalized: 4.5,
          number_content: 4.0,  // BOOST (was 2.0)
          number_extracted: 7.0,  // BOOST heavily (was 3.5)
          temporal_unit: 4.5,
          disambiguated_entity: 5.0,
          acronym: 2.5,
        },
      };

    case 'action-based':
      return {
        name: 'action-based',
        description: 'Balanced boost for queries about activities, events, tasks',
        fieldBoosts: {
          content: 3.5,  // BOOST content (was 3.0) - action context matters
          content_shingles: 1.5,
          tags: 2.5,
          artifacts: 1.5,
          content_raw: 0.5,
          extracted_entities: 3.0,  // Moderate boost (was 2.5)
          extracted_dates: 2.5,
          extracted_numbers: 2.0,
          normalized_dates: 2.5,
          temporal_units: 2.5,
          disambiguated_entities: 3.5,  // BOOST (was 2.5)
          acronyms: 2.0,
        },
        phraseBoosts: {
          entity_content: 3.5,  // BOOST (was 3.0)
          entity_extracted: 4.5,  // BOOST (was 4.0)
          date_content: 2.5,
          date_extracted: 4.0,
          date_normalized: 4.5,
          number_content: 2.0,
          number_extracted: 3.5,
          temporal_unit: 4.0,
          disambiguated_entity: 5.5,  // BOOST (was 5.0)
          acronym: 2.5,
        },
      };

    case 'preference':
      return {
        name: 'preference',
        description: 'Boost content and entities for recommendation queries',
        fieldBoosts: {
          content: 4.0,  // BOOST content heavily (was 3.0) - user preferences in content
          content_shingles: 1.8,  // BOOST for phrase matching
          tags: 3.0,  // BOOST tags (was 2.0) - preferences often tagged
          artifacts: 1.5,
          content_raw: 1.0,
          extracted_entities: 3.5,  // BOOST entities (was 2.5)
          extracted_dates: 1.5,  // Reduce dates
          extracted_numbers: 2.0,
          normalized_dates: 1.5,
          temporal_units: 1.5,
          disambiguated_entities: 4.0,  // BOOST (was 2.5)
          acronyms: 2.5,
        },
        phraseBoosts: {
          entity_content: 3.5,  // BOOST (was 3.0)
          entity_extracted: 4.5,  // BOOST (was 4.0)
          date_content: 1.5,
          date_extracted: 2.5,
          date_normalized: 3.0,
          number_content: 2.0,
          number_extracted: 3.0,
          temporal_unit: 3.0,
          disambiguated_entity: 5.5,  // BOOST (was 5.0)
          acronym: 3.0,  // BOOST (was 2.5)
        },
      };

    case 'single-session':
    default:
      // Default/baseline profile - similar to current implementation
      return {
        name: 'single-session',
        description: 'Balanced boost profile for specific fact queries',
        fieldBoosts: {
          content: 3.0,
          content_shingles: 1.2,
          tags: 2.0,
          artifacts: 1.0,
          content_raw: 0.5,
          extracted_entities: 2.5,
          extracted_dates: 2.5,
          extracted_numbers: 2.0,
          normalized_dates: 2.5,
          temporal_units: 2.5,
          disambiguated_entities: 2.5,
          acronyms: 2.0,
        },
        phraseBoosts: {
          entity_content: 3.0,
          entity_extracted: 4.0,
          date_content: 2.5,
          date_extracted: 4.0,
          date_normalized: 5.0,
          number_content: 2.0,
          number_extracted: 3.5,
          temporal_unit: 4.5,
          disambiguated_entity: 5.0,
          acronym: 2.5,
        },
      };
  }
}
