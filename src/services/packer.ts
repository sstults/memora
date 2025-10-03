// src/services/packer.ts
// Prompt packing and compression for Memora MCP.
// Reads config/packing.yaml (load once in a real config service).

import fs from "fs";
import yaml from "js-yaml";

interface PackingConfig {
  order: string[];
  limits: {
    max_tokens: number;
    max_snippets: number;
    budgets: Record<string, number>;
  };
  compression: {
    retrieved: {
      enabled: boolean;
      min_tokens: number;
      preserve_anchors: boolean;
    };
    recent_turns: {
      enabled: boolean;
      max_turns: number;
    };
  };
}

let config: PackingConfig | null = null;
function getConfig(): PackingConfig {
  if (config) return config;
  const raw = fs.readFileSync("config/packing.yaml", "utf8");
  config = yaml.load(raw) as PackingConfig;
  return config;
}

export interface Section {
  name: string;
  content: string;
  tokens?: number; // approximate
}

/**
 * Pack ordered sections into a prompt string, respecting budgets and compression rules.
 */
export function packPrompt(sections: Section[]): string {
  const cfg = getConfig();
  const out: string[] = [];
  let usedTokens = 0;

  for (const name of cfg.order) {
    const sec = sections.find(s => s.name === name);
    if (!sec) continue;

    const budget = cfg.limits.budgets[name] ?? 1024;

    // Start with raw content
    let content = sec.content;

    // Apply section-specific compression rules proactively (independent of section budget)
    if (name === "retrieved" && cfg.compression.retrieved.enabled) {
      content = compressRetrieved(content, cfg.compression.retrieved);
    } else if (name === "recent_turns" && cfg.compression.recent_turns.enabled) {
      content = trimRecentTurns(content, cfg.compression.recent_turns.max_turns);
    }

    // Recompute tokens after proactive compression
    let tokens = sec.tokens ?? estimateTokens(content);

    // If still over section budget, apply generic truncation
    if (tokens > budget) {
      content = truncateByTokens(content, budget);
      tokens = budget;
    }

    // Enforce global budget
    if (usedTokens + tokens > cfg.limits.max_tokens) {
      break;
    }

    out.push(sectionHeader(name), content.trim());
    usedTokens += tokens;
  }

  return out.join("\n\n");
}

// ----------------------------
// Compression helpers
// ----------------------------

function compressRetrieved(text: string, opts: { min_tokens: number; preserve_anchors: boolean }): string {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  // Keep anchors like file paths, IDs, error codes
  if (opts.preserve_anchors) {
    return lines
      .map(l => {
        if (/[A-Za-z0-9_.-]+\.[A-Za-z]{1,4}/.test(l) || /[A-Z]{2,}-\d+/.test(l)) {
          return l; // keep anchors
        }
        // Summarize long lines
        if (estimateTokens(l) > opts.min_tokens) {
          return l.slice(0, 200) + "…";
        }
        return l;
      })
      .join("\n");
  }

  // Otherwise, just truncate
  return truncateByTokens(text, opts.min_tokens);
}

function trimRecentTurns(text: string, maxTurns: number): string {
  const turns = text.split(/\n?---TURN---\n?/).filter(Boolean);
  return turns.slice(-maxTurns).join("\n---TURN---\n");
}

function truncateByTokens(text: string, maxTokens: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxTokens) return text;
  return words.slice(0, maxTokens).join(" ") + " …";
}

// ----------------------------
// Utility
// ----------------------------

function sectionHeader(name: string): string {
  switch (name) {
    case "system": return "## System";
    case "task_frame": return "## Task";
    case "tool_state": return "## Tools";
    case "retrieved": return "## Retrieved Memory";
    case "recent_turns": return "## Recent Turns";
    default: return `## ${name}`;
  }
}

// Naive token estimator (~4 chars/token heuristic)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
