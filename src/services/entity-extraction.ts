// src/services/entity-extraction.ts
// Simple rule-based entity extraction for improving lexical search recall.
//
// Extracts:
// - Dates: month names, day references, ISO dates
// - Numbers: standalone numbers and numbers with units (days, weeks, months, years)
// - Entities: Capitalized phrases (proper nouns like names, places, products)

export interface ExtractedEntities {
  dates: string[];
  numbers: string[];
  entities: string[];
}

// Common words to exclude from entity extraction (lowercase)
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not",
  "only", "own", "same", "so", "than", "too", "very", "can", "will", "just",
  "should", "now", "i", "you", "he", "she", "it", "we", "they", "my", "your",
  "his", "her", "its", "our", "their", "this", "that", "these", "those",
  "what", "which", "who", "whom", "whose", "if", "because", "as", "until",
  "while", "am", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "having", "do", "does", "did", "doing", "would", "could"
]);

/**
 * Extract dates, numbers, and proper noun entities from text.
 * Uses simple heuristics optimized for the types of questions in LongMemEval.
 */
export function extractEntities(text: string): ExtractedEntities {
  const dates: Set<string> = new Set();
  const numbers: Set<string> = new Set();
  const entities: Set<string> = new Set();

  // Extract dates: month names, temporal keywords, ordinal dates
  const datePatterns = [
    // Month + day: "January 24th", "Feb 10", "March 1st"
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi,
    // ISO dates: 2024-01-15
    /\b\d{4}-\d{2}-\d{2}\b/g,
    // Day of week
    /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/gi,
    // Temporal references
    /\b(yesterday|today|tomorrow|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year))\b/gi,
  ];

  for (const pattern of datePatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      dates.add(match[0].toLowerCase());
    }
  }

  // Extract numbers with context (especially temporal durations)
  const numberPatterns = [
    // Numbers with time units: "7 days", "3 months", "2 weeks"
    /\b\d+\s*(?:day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes)\b/gi,
    // Ordinal numbers: "first", "second", "1st", "2nd"
    /\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi,
    // Standalone numbers (but not years to avoid noise)
    /\b(?<![:\d])\d{1,3}(?!\d)\b(?!\s*(?:st|nd|rd|th))/g,
  ];

  for (const pattern of numberPatterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const num = match[0].toLowerCase();
      // Skip very common single digits that are likely noise unless they have units
      if (/^\d$/.test(num) && !text.slice(Math.max(0, match.index! - 5), match.index! + num.length + 10).match(/\d\s*(?:day|week|month|year|hour|minute)/i)) {
        continue;
      }
      numbers.add(num);
    }
  }

  // Extract proper nouns: sequences of capitalized words
  // This catches names, places, products, organizations
  const sentences = text.split(/[.!?]\s+/);

  for (const sentence of sentences) {
    // Find sequences of capitalized words (but not at sentence start)
    const words = sentence.split(/\s+/);
    let capitalizedSequence: string[] = [];

    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[,;:!?()[\]{}'"]/g, "").trim();

      if (!word) continue;

      // Check if word is capitalized (first letter uppercase)
      const isCapitalized = /^[A-Z]/.test(word);
      const isAllCaps = word === word.toUpperCase() && word.length > 1;
      const isLowerStop = STOP_WORDS.has(word.toLowerCase());

      if (isCapitalized && !isAllCaps && word.length > 1) {
        // Skip if it's a stop word or common word at sentence start
        if (i === 0 && isLowerStop) {
          continue;
        }

        capitalizedSequence.push(word);
      } else {
        // End of sequence
        if (capitalizedSequence.length > 0) {
          const entity = capitalizedSequence.join(" ");
          // Filter out single common words and stopwords
          if (capitalizedSequence.length > 1 || (!STOP_WORDS.has(entity.toLowerCase()) && entity.length > 2)) {
            entities.add(entity);
          }
          capitalizedSequence = [];
        }
      }
    }

    // Catch sequence at end of sentence
    if (capitalizedSequence.length > 0) {
      const entity = capitalizedSequence.join(" ");
      if (capitalizedSequence.length > 1 || (!STOP_WORDS.has(entity.toLowerCase()) && entity.length > 2)) {
        entities.add(entity);
      }
    }
  }

  // Also extract quoted strings as potential entities (product names, titles, etc.)
  const quotedPattern = /["']([A-Z][^"']{2,50})["']/g;
  const quotedMatches = text.matchAll(quotedPattern);
  for (const match of quotedMatches) {
    entities.add(match[1]);
  }

  return {
    dates: Array.from(dates),
    numbers: Array.from(numbers),
    entities: Array.from(entities),
  };
}
