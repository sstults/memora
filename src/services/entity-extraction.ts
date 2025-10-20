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
  normalized_dates?: string[];     // ISO date strings from relative dates
  temporal_units?: string[];       // Normalized durations (e.g., "7 days", "2 weeks")
  disambiguated_entities?: string[]; // Entities with context (e.g., "April [month]", "April [name]")
  acronyms?: Map<string, string>;  // acronym -> expansion mapping
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

// Month names for disambiguation
const MONTH_NAMES = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"
]);

/**
 * Normalize relative date expressions to absolute ISO dates.
 * Uses current date as reference point.
 */
function normalizeRelativeDates(text: string, referenceDate: Date = new Date()): string[] {
  const normalized: string[] = [];

  // Create a copy to avoid mutating the reference
  const ref = new Date(referenceDate);

  // Helper to format date as ISO string (YYYY-MM-DD)
  const toISODate = (date: Date): string => {
    return date.toISOString().split('T')[0];
  };

  // Yesterday
  if (/\byesterday\b/i.test(text)) {
    const yesterday = new Date(ref);
    yesterday.setDate(yesterday.getDate() - 1);
    normalized.push(toISODate(yesterday));
  }

  // Today
  if (/\btoday\b/i.test(text)) {
    normalized.push(toISODate(ref));
  }

  // Tomorrow
  if (/\btomorrow\b/i.test(text)) {
    const tomorrow = new Date(ref);
    tomorrow.setDate(tomorrow.getDate() + 1);
    normalized.push(toISODate(tomorrow));
  }

  // Last week (7 days ago)
  if (/\blast\s+week\b/i.test(text)) {
    const lastWeek = new Date(ref);
    lastWeek.setDate(lastWeek.getDate() - 7);
    normalized.push(toISODate(lastWeek));
  }

  // Next week (7 days from now)
  if (/\bnext\s+week\b/i.test(text)) {
    const nextWeek = new Date(ref);
    nextWeek.setDate(nextWeek.getDate() + 7);
    normalized.push(toISODate(nextWeek));
  }

  // Last month
  if (/\blast\s+month\b/i.test(text)) {
    const lastMonth = new Date(ref);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    normalized.push(toISODate(lastMonth));
  }

  // Next month
  if (/\bnext\s+month\b/i.test(text)) {
    const nextMonth = new Date(ref);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    normalized.push(toISODate(nextMonth));
  }

  // Last year
  if (/\blast\s+year\b/i.test(text)) {
    const lastYear = new Date(ref);
    lastYear.setFullYear(lastYear.getFullYear() - 1);
    normalized.push(toISODate(lastYear));
  }

  // Next year
  if (/\bnext\s+year\b/i.test(text)) {
    const nextYear = new Date(ref);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    normalized.push(toISODate(nextYear));
  }

  // N days ago/from now
  const daysAgoPattern = /(\d+)\s+days?\s+ago/gi;
  for (const match of text.matchAll(daysAgoPattern)) {
    const days = parseInt(match[1]);
    const date = new Date(ref);
    date.setDate(date.getDate() - days);
    normalized.push(toISODate(date));
  }

  const daysFromNowPattern = /(\d+)\s+days?\s+(?:from\s+now|later)/gi;
  for (const match of text.matchAll(daysFromNowPattern)) {
    const days = parseInt(match[1]);
    const date = new Date(ref);
    date.setDate(date.getDate() + days);
    normalized.push(toISODate(date));
  }

  // N weeks ago/from now
  const weeksAgoPattern = /(\d+)\s+weeks?\s+ago/gi;
  for (const match of text.matchAll(weeksAgoPattern)) {
    const weeks = parseInt(match[1]);
    const date = new Date(ref);
    date.setDate(date.getDate() - (weeks * 7));
    normalized.push(toISODate(date));
  }

  const weeksFromNowPattern = /(\d+)\s+weeks?\s+(?:from\s+now|later)/gi;
  for (const match of text.matchAll(weeksFromNowPattern)) {
    const weeks = parseInt(match[1]);
    const date = new Date(ref);
    date.setDate(date.getDate() + (weeks * 7));
    normalized.push(toISODate(date));
  }

  // N months ago/from now
  const monthsAgoPattern = /(\d+)\s+months?\s+ago/gi;
  for (const match of text.matchAll(monthsAgoPattern)) {
    const months = parseInt(match[1]);
    const date = new Date(ref);
    date.setMonth(date.getMonth() - months);
    normalized.push(toISODate(date));
  }

  const monthsFromNowPattern = /(\d+)\s+months?\s+(?:from\s+now|later)/gi;
  for (const match of text.matchAll(monthsFromNowPattern)) {
    const months = parseInt(match[1]);
    const date = new Date(ref);
    date.setMonth(date.getMonth() + months);
    normalized.push(toISODate(date));
  }

  return normalized;
}

/**
 * Extract and normalize temporal duration units.
 * Converts various expressions to standardized forms.
 */
function extractTemporalUnits(text: string): string[] {
  const units: Set<string> = new Set();

  // Extract duration patterns: "7 days", "3 weeks", "2 months", "a fortnight"
  const durationPattern = /(?:(\d+)|a|an)\s*(day|days|week|weeks|fortnight|fortnights|month|months|year|years|hour|hours|minute|minutes)/gi;

  for (const match of text.matchAll(durationPattern)) {
    const num = match[1] ? parseInt(match[1]) : 1; // "a" or "an" means 1
    const unit = match[2].toLowerCase();

    // Normalize to singular or plural form
    let normalizedUnit = unit;
    if (unit === "fortnight" || unit === "fortnights") {
      // Convert fortnight to days
      units.add(`${num * 14} days`);
      continue;
    }

    // Standardize to plural for consistency
    if (num === 1) {
      normalizedUnit = unit.replace(/s$/, ""); // singular
    } else {
      if (!unit.endsWith("s")) {
        normalizedUnit = unit + "s"; // plural
      }
    }

    units.add(`${num} ${normalizedUnit}`);

    // Also add day equivalents for weeks/months/years for better matching
    if (unit.startsWith("week")) {
      units.add(`${num * 7} days`);
    } else if (unit.startsWith("month")) {
      units.add(`${num * 30} days`); // approximate
    } else if (unit.startsWith("year")) {
      units.add(`${num * 365} days`); // approximate
    }
  }

  return Array.from(units);
}

/**
 * Disambiguate entities that could have multiple meanings.
 * For example, "April" could be a month or a person's name.
 */
function disambiguateEntities(entities: string[], context: string): string[] {
  const disambiguated: string[] = [];

  for (const entity of entities) {
    const lowerEntity = entity.toLowerCase();

    // Check if it's a month name used in a temporal context
    if (MONTH_NAMES.has(lowerEntity)) {
      // Look for temporal indicators nearby
      const monthPattern = new RegExp(`\\b${entity}\\b.{0,20}\\b(?:\\d{1,2}(?:st|nd|rd|th)?|\\d{4}|last|next|this)`, "i");
      const reversePattern = new RegExp(`\\b(?:last|next|this|in)\\s+${entity}\\b`, "i");

      if (monthPattern.test(context) || reversePattern.test(context)) {
        disambiguated.push(`${entity} [month]`);
      } else {
        disambiguated.push(`${entity} [name]`);
      }
    } else {
      // No disambiguation needed
      disambiguated.push(entity);
    }
  }

  return disambiguated;
}

/**
 * Extract acronyms and their expansions from text.
 * Looks for patterns like "BM25 (Best Match 25)" or "Best Match 25 (BM25)".
 */
function extractAcronyms(text: string): Map<string, string> {
  const acronyms = new Map<string, string>();

  // Pattern 1: Expansion followed by acronym in parentheses
  // "Best Match 25 (BM25)"
  const pattern1 = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*\(([A-Z]{2,}(?:\d+)?)\)/g;
  for (const match of text.matchAll(pattern1)) {
    const expansion = match[1];
    const acronym = match[2];
    acronyms.set(acronym, expansion);
    acronyms.set(expansion, acronym); // bidirectional
  }

  // Pattern 2: Acronym followed by expansion in parentheses
  // "BM25 (Best Match 25)"
  const pattern2 = /\b([A-Z]{2,}(?:\d+)?)\s*\(([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\)/g;
  for (const match of text.matchAll(pattern2)) {
    const acronym = match[1];
    const expansion = match[2];
    acronyms.set(acronym, expansion);
    acronyms.set(expansion, acronym); // bidirectional
  }

  // Pattern 3: Common acronyms without explicit expansion (domain knowledge)
  const commonAcronyms: Record<string, string> = {
    "AI": "Artificial Intelligence",
    "ML": "Machine Learning",
    "NLP": "Natural Language Processing",
    "API": "Application Programming Interface",
    "SQL": "Structured Query Language",
    "HTML": "HyperText Markup Language",
    "CSS": "Cascading Style Sheets",
    "JSON": "JavaScript Object Notation",
    "XML": "Extensible Markup Language",
    "HTTP": "HyperText Transfer Protocol",
    "HTTPS": "HyperText Transfer Protocol Secure",
    "URL": "Uniform Resource Locator",
    "URI": "Uniform Resource Identifier",
    "REST": "Representational State Transfer",
    "CRUD": "Create Read Update Delete",
    "JWT": "JSON Web Token",
    "OAuth": "Open Authorization",
    "RAM": "Random Access Memory",
    "CPU": "Central Processing Unit",
    "GPU": "Graphics Processing Unit",
    "SSD": "Solid State Drive",
    "HDD": "Hard Disk Drive",
    "USB": "Universal Serial Bus",
    "PDF": "Portable Document Format",
    "BM25": "Best Match 25"
  };

  for (const [acronym, expansion] of Object.entries(commonAcronyms)) {
    const acronymRegex = new RegExp(`\\b${acronym}\\b`, "i");
    if (acronymRegex.test(text)) {
      acronyms.set(acronym, expansion);
    }
  }

  return acronyms;
}

/**
 * Extract dates, numbers, and proper noun entities from text.
 * Uses simple heuristics optimized for the types of questions in LongMemEval.
 *
 * @param text - The text to extract entities from
 * @param referenceDate - Optional reference date for normalizing relative dates (defaults to current date)
 */
export function extractEntities(text: string, referenceDate?: Date): ExtractedEntities {
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
        // Skip if it's a stop word at sentence start
        if (i === 0 && isLowerStop) {
          continue;
        }

        // For sentence-initial words, be conservative: only include if part of a multi-word sequence
        if (i === 0) {
          // Start a potential sequence but don't commit yet
          capitalizedSequence.push(word);
        } else {
          capitalizedSequence.push(word);
        }
      } else {
        // End of sequence
        if (capitalizedSequence.length > 0) {
          const entity = capitalizedSequence.join(" ");
          // Filter out:
          // 1. Single words at sentence start (likely just capitalization, not proper nouns)
          // 2. Single stopwords anywhere
          // 3. Very short words
          const isSentenceStart = capitalizedSequence.length === 1 && words.indexOf(capitalizedSequence[0]) === 0;
          if (!isSentenceStart && (capitalizedSequence.length > 1 || (!STOP_WORDS.has(entity.toLowerCase()) && entity.length > 2))) {
            entities.add(entity);
          }
          capitalizedSequence = [];
        }
      }
    }

    // Catch sequence at end of sentence
    if (capitalizedSequence.length > 0) {
      const entity = capitalizedSequence.join(" ");
      const isSentenceStart = capitalizedSequence.length === 1 && words.indexOf(capitalizedSequence[0]) === 0;
      if (!isSentenceStart && (capitalizedSequence.length > 1 || (!STOP_WORDS.has(entity.toLowerCase()) && entity.length > 2))) {
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

  // Apply enhanced entity extraction
  const normalizedDates = normalizeRelativeDates(text, referenceDate);
  const temporalUnits = extractTemporalUnits(text);
  const entitiesArray = Array.from(entities);
  const disambiguated = disambiguateEntities(entitiesArray, text);
  const acronyms = extractAcronyms(text);

  return {
    dates: Array.from(dates),
    numbers: Array.from(numbers),
    entities: entitiesArray,
    normalized_dates: normalizedDates.length > 0 ? normalizedDates : undefined,
    temporal_units: temporalUnits.length > 0 ? temporalUnits : undefined,
    disambiguated_entities: disambiguated.length > 0 ? disambiguated : undefined,
    acronyms: acronyms.size > 0 ? acronyms : undefined,
  };
}
