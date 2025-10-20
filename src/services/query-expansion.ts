// src/services/query-expansion.ts
// Query expansion service for improving lexical recall.
// Focuses on temporal term expansion and synonym matching.

export interface ExpandedQuery {
  original: string;
  expanded: string;
  expansions: string[];
  hadTemporalExpansion: boolean;
}

// Temporal synonym mappings for common relative time references
const TEMPORAL_SYNONYMS: Record<string, string[]> = {
  // Relative day references
  "yesterday": ["1 day ago", "previous day", "day before"],
  "today": ["this day", "current day"],
  "tomorrow": ["next day", "following day", "1 day from now"],

  // Week references
  "last week": ["7 days ago", "previous week", "week ago"],
  "this week": ["current week", "present week"],
  "next week": ["following week", "7 days from now", "week from now"],
  "a week ago": ["7 days ago", "previous week"],
  "week ago": ["7 days ago", "previous week"],

  // Month references
  "last month": ["30 days ago", "previous month", "month ago"],
  "this month": ["current month", "present month"],
  "next month": ["following month", "30 days from now", "month from now"],
  "a month ago": ["30 days ago", "previous month"],
  "month ago": ["30 days ago", "previous month"],

  // Year references
  "last year": ["365 days ago", "previous year", "year ago"],
  "this year": ["current year", "present year"],
  "next year": ["following year", "365 days from now", "year from now"],

  // Duration terms
  "fortnight": ["14 days", "2 weeks", "two weeks"],
  "biweekly": ["14 days", "2 weeks", "two weeks"],
  "quarterly": ["3 months", "90 days", "three months"],

  // Common abbreviations
  "jan": ["january"],
  "feb": ["february"],
  "mar": ["march"],
  "apr": ["april"],
  "jun": ["june"],
  "jul": ["july"],
  "aug": ["august"],
  "sep": ["september", "sept"],
  "sept": ["september"],
  "oct": ["october"],
  "nov": ["november"],
  "dec": ["december"],

  // Ordinal number expansions
  "1st": ["first", "1"],
  "2nd": ["second", "2"],
  "3rd": ["third", "3"],
  "4th": ["fourth", "4"],
  "5th": ["fifth", "5"],
  "6th": ["sixth", "6"],
  "7th": ["seventh", "7"],
  "8th": ["eighth", "8"],
  "9th": ["ninth", "9"],
  "10th": ["tenth", "10"],

  // Time period shortcuts
  "daily": ["every day", "each day", "per day"],
  "weekly": ["every week", "each week", "per week"],
  "monthly": ["every month", "each month", "per month"],
  "yearly": ["every year", "each year", "per year", "annually"],
  "annually": ["every year", "each year", "per year", "yearly"]
};

// Pattern-based expansions for duration calculations
const DURATION_PATTERNS = [
  // "X days ago" ↔ "X day ago"
  { pattern: /(\d+)\s+days?\s+ago/gi, expand: (match: RegExpMatchArray) => {
    const num = match[1];
    return [`${num} day ago`, `${num} days ago`, `${num} days before`, `${num} day before`];
  }},

  // "X weeks ago" ↔ calculate days
  { pattern: /(\d+)\s+weeks?\s+ago/gi, expand: (match: RegExpMatchArray) => {
    const weeks = parseInt(match[1]);
    const days = weeks * 7;
    return [`${weeks} week ago`, `${weeks} weeks ago`, `${days} days ago`];
  }},

  // "X months ago" ↔ approximate days
  { pattern: /(\d+)\s+months?\s+ago/gi, expand: (match: RegExpMatchArray) => {
    const months = parseInt(match[1]);
    const days = months * 30;
    return [`${months} month ago`, `${months} months ago`, `${days} days ago`, `about ${days} days ago`];
  }},

  // "in X days" ↔ "X days from now"
  { pattern: /in\s+(\d+)\s+days?/gi, expand: (match: RegExpMatchArray) => {
    const num = match[1];
    return [`${num} days from now`, `${num} day from now`, `in ${num} day`, `in ${num} days`];
  }},

  // "in X weeks" ↔ calculate days
  { pattern: /in\s+(\d+)\s+weeks?/gi, expand: (match: RegExpMatchArray) => {
    const weeks = parseInt(match[1]);
    const days = weeks * 7;
    return [`${weeks} weeks from now`, `${weeks} week from now`, `in ${days} days`, `${days} days from now`];
  }},

  // "between X and Y" temporal references
  { pattern: /between\s+(.+?)\s+and\s+(.+)/gi, expand: (match: RegExpMatchArray) => {
    return [`from ${match[1]} to ${match[2]}`, `${match[1]} to ${match[2]}`];
  }}
];

/**
 * Expand query with temporal synonyms and duration calculations.
 * This improves recall for queries with relative time references.
 */
export function expandQuery(query: string): ExpandedQuery {
  const expansions: Set<string> = new Set();
  let expanded = query;
  let hadTemporalExpansion = false;

  // Step 1: Apply dictionary-based temporal synonym expansion
  const lowerQuery = query.toLowerCase();
  for (const [term, synonyms] of Object.entries(TEMPORAL_SYNONYMS)) {
    // Use word boundaries to avoid partial matches
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, "gi");
    if (regex.test(lowerQuery)) {
      hadTemporalExpansion = true;
      for (const synonym of synonyms) {
        expansions.add(synonym);
        // Also add to expanded query string
        expanded += ` ${synonym}`;
      }
    }
  }

  // Step 2: Apply pattern-based duration expansions
  for (const { pattern, expand } of DURATION_PATTERNS) {
    const matches = Array.from(query.matchAll(pattern));
    for (const match of matches) {
      hadTemporalExpansion = true;
      const variants = expand(match);
      for (const variant of variants) {
        expansions.add(variant);
        expanded += ` ${variant}`;
      }
    }
  }

  return {
    original: query,
    expanded: expanded.trim(),
    expansions: Array.from(expansions),
    hadTemporalExpansion
  };
}

/**
 * Detect if a query contains temporal references.
 * Used to decide whether to apply temporal-specific boosting.
 */
export function isTemporalQuery(query: string): boolean {
  const temporal = query.toLowerCase();

  // Check for explicit temporal keywords
  const temporalKeywords = [
    "day", "days", "week", "weeks", "month", "months", "year", "years",
    "yesterday", "today", "tomorrow", "ago", "from now",
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
    "how many days", "how long", "time between", "days between", "duration"
  ];

  return temporalKeywords.some(keyword => temporal.includes(keyword));
}

/**
 * Extract temporal entities specifically for boosting.
 * More focused than general entity extraction.
 */
export function extractTemporalEntities(query: string): {
  dates: string[];
  durations: string[];
  relativeRefs: string[];
} {
  const dates: Set<string> = new Set();
  const durations: Set<string> = new Set();
  const relativeRefs: Set<string> = new Set();

  // Extract explicit dates (Month Day, YYYY-MM-DD, etc.)
  const datePatterns = [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/gi,
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g
  ];

  for (const pattern of datePatterns) {
    const matches = query.matchAll(pattern);
    for (const match of matches) {
      dates.add(match[0].toLowerCase());
    }
  }

  // Extract durations (X days, Y weeks, etc.)
  const durationPattern = /\b\d+\s*(?:day|days|week|weeks|month|months|year|years|hour|hours)\b/gi;
  const durationMatches = query.matchAll(durationPattern);
  for (const match of durationMatches) {
    durations.add(match[0].toLowerCase());
  }

  // Extract relative references (yesterday, last week, etc.)
  const relativePattern = /\b(?:yesterday|today|tomorrow|last\s+(?:week|month|year)|next\s+(?:week|month|year)|this\s+(?:week|month|year))\b/gi;
  const relativeMatches = query.matchAll(relativePattern);
  for (const match of relativeMatches) {
    relativeRefs.add(match[0].toLowerCase());
  }

  return {
    dates: Array.from(dates),
    durations: Array.from(durations),
    relativeRefs: Array.from(relativeRefs)
  };
}

/**
 * Helper to escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
