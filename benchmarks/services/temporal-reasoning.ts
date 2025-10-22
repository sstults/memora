/**
 * Structured Temporal Reasoning Service
 *
 * Extracts temporal data from context and performs programmatic
 * date/time calculations to improve temporal reasoning accuracy.
 */

interface TemporalEvent {
  description: string;
  date?: string;  // ISO date string or partial (e.g., "2024-01-15", "January 15")
  timestamp?: string;  // ISO timestamp if available
  relativeOrder?: number;  // Sequence order if dates not available
}

interface TemporalExtraction {
  events: TemporalEvent[];
  success: boolean;
  error?: string;
}

interface TemporalReasoning {
  chronologicalOrder: string[];  // Event descriptions in chronological order
  firstEvent?: string;
  lastEvent?: string;
  daysBetween?: Record<string, number>;  // Pairs of events and days between them
  calculations: string[];  // Human-readable calculations performed
}

/**
 * Parse various date formats into a comparable format
 */
function parseFlexibleDate(dateStr: string): Date | null {
  if (!dateStr) return null;

  // Try ISO format first
  let d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  // Try common formats
  const formats = [
    // "January 15, 2024" or "January 15"
    /^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/,
    // "1/15/2024" or "1/15"
    /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|  \d{2}))?$/,
    // "2024-01-15"
    /^(\d{4})-(\d{1,2})-(\d{1,2})$/
  ];

  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];

  for (const regex of formats) {
    const match = dateStr.match(regex);
    if (match) {
      try {
        if (regex.source.includes('[A-Za-z]')) {
          // Month name format
          const monthName = match[1].toLowerCase();
          const day = parseInt(match[2]);
          const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
          const monthIndex = monthNames.indexOf(monthName);
          if (monthIndex >= 0) {
            return new Date(year, monthIndex, day);
          }
        } else if (regex.source.startsWith('\\^\\(\\\\d')) {
          // Numeric format (M/D/Y)
          const month = parseInt(match[1]);
          const day = parseInt(match[2]);
          const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
          return new Date(year, month - 1, day);
        }
      } catch (e) {
        continue;
      }
    }
  }

  return null;
}

/**
 * Calculate days between two dates
 */
function daysBetween(date1: Date, date2: Date): number {
  const ms = Math.abs(date2.getTime() - date1.getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Extract temporal events from context using LLM
 */
export async function extractTemporalEvents(
  openai: any,
  context: string,
  question: string
): Promise<TemporalExtraction> {
  const systemPrompt = `You are a precise temporal data extractor. Extract events with dates/times from the given context.

For each event mentioned in the context that has a date or time:
1. Provide a brief description
2. Extract the exact date/time if available
3. If only relative order is clear, note that

Return your response as a JSON array of events in this format:
[
  {
    "description": "brief event description",
    "date": "ISO date or month/day format",
    "relativeOrder": 1
  },
  ...
]

Be precise with dates. If a date is mentioned multiple times, use the most specific one.
If no dates are found, return an empty array [].`;

  const userPrompt = `Context:
${context}

Question being asked (for context): ${question}

Extract all events with their dates:`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const content = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const events = parsed.events || [];

    return {
      events,
      success: true
    };
  } catch (error) {
    return {
      events: [],
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Perform temporal reasoning on extracted events
 */
export function reasonAboutTime(extraction: TemporalExtraction): TemporalReasoning {
  const { events } = extraction;
  const calculations: string[] = [];

  // Parse dates
  const eventsWithDates = events
    .map(e => ({
      ...e,
      parsedDate: e.date ? parseFlexibleDate(e.date) : null
    }))
    .filter(e => e.parsedDate !== null);

  // Sort chronologically
  const sortedEvents = [...eventsWithDates].sort((a, b) => {
    if (a.parsedDate && b.parsedDate) {
      return a.parsedDate.getTime() - b.parsedDate.getTime();
    }
    return (a.relativeOrder ?? 0) - (b.relativeOrder ?? 0);
  });

  const chronologicalOrder = sortedEvents.map(e => e.description);
  const firstEvent = sortedEvents[0]?.description;
  const lastEvent = sortedEvents[sortedEvents.length - 1]?.description;

  // Calculate days between consecutive events
  const daysBetweenMap: Record<string, number> = {};
  for (let i = 0; i < sortedEvents.length - 1; i++) {
    const curr = sortedEvents[i];
    const next = sortedEvents[i + 1];
    if (curr.parsedDate && next.parsedDate) {
      const days = daysBetween(curr.parsedDate, next.parsedDate);
      const key = `${curr.description} → ${next.description}`;
      daysBetweenMap[key] = days;
      calculations.push(`${days} days between "${curr.description}" and "${next.description}"`);
    }
  }

  // Add first/last calculations
  if (sortedEvents.length >= 2) {
    const firstDate = sortedEvents[0].parsedDate;
    const lastDate = sortedEvents[sortedEvents.length - 1].parsedDate;
    if (firstDate && lastDate) {
      const totalDays = daysBetween(firstDate, lastDate);
      calculations.push(`Total span: ${totalDays} days from first to last event`);
    }
  }

  return {
    chronologicalOrder,
    firstEvent,
    lastEvent,
    daysBetween: daysBetweenMap,
    calculations
  };
}

/**
 * Generate structured reasoning context for LLM
 */
export function generateStructuredContext(
  reasoning: TemporalReasoning,
  originalContext: string
): string {
  let structured = `TEMPORAL ANALYSIS:\n\n`;

  if (reasoning.chronologicalOrder.length > 0) {
    structured += `Chronological Order:\n`;
    reasoning.chronologicalOrder.forEach((event, idx) => {
      structured += `${idx + 1}. ${event}\n`;
    });
    structured += `\n`;
  }

  if (reasoning.calculations.length > 0) {
    structured += `Calculated Facts:\n`;
    reasoning.calculations.forEach(calc => {
      structured += `- ${calc}\n`;
    });
    structured += `\n`;
  }

  structured += `---\n\nORIGINAL CONTEXT:\n${originalContext}`;

  return structured;
}

/**
 * Main entry point: Enhance context with structured temporal reasoning
 */
export async function enhanceWithTemporalReasoning(
  openai: any,
  context: string,
  question: string,
  enabled: boolean = true
): Promise<{ enhancedContext: string; reasoning?: TemporalReasoning; extraction?: TemporalExtraction }> {
  if (!enabled) {
    return { enhancedContext: context };
  }

  // Extract temporal events
  const extraction = await extractTemporalEvents(openai, context, question);

  if (!extraction.success || extraction.events.length === 0) {
    // No temporal data found, return original context
    return { enhancedContext: context };
  }

  // Perform temporal reasoning
  const reasoning = reasonAboutTime(extraction);

  // Generate enhanced context with structured reasoning
  const enhancedContext = generateStructuredContext(reasoning, context);

  return {
    enhancedContext,
    reasoning,
    extraction
  };
}
