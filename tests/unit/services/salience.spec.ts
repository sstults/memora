import { describe, it, expect } from "vitest";
import {
  scoreSalience,
  atomicSplit,
  summarizeIfLong,
  redact
} from "../../../src/services/salience";

describe("salience.scoreSalience", () => {
  it("returns higher score when boosted keywords are present", () => {
    const base = scoreSalience("This is a short note about something mundane.");
    const boosted = scoreSalience("We hit an error while calling the API. Stack trace follows.");
    expect(boosted).toBeGreaterThan(base);
  });

  it("adds a small boost when tags overlap text", () => {
    const withoutTags = scoreSalience("Design discussion about module boundaries.");
    const withTags = scoreSalience("Design discussion about module boundaries.", { tags: ["design"] });
    expect(withTags).toBeGreaterThanOrEqual(withoutTags);
  });
});

describe("salience.atomicSplit", () => {
  it("preserves fenced code blocks as single atoms and splits prose by paragraphs", () => {
    const text = [
      "# Header",
      "Paragraph one with some content.",
      "",
      "Paragraph two.",
      "```",
      "const x = 1;",
      "console.log(x);",
      "```",
      "Tail paragraph."
    ].join("\n");

    const atoms = atomicSplit(text);
    // Should contain code fence block intact
    const code = atoms.find(a => a.startsWith("```") && a.endsWith("```"));
    expect(code).toBeTruthy();
    // Should split into multiple atoms including header and paragraphs
    expect(atoms.length).toBeGreaterThanOrEqual(4);
  });
});

describe("salience.summarizeIfLong", () => {
  it("compresses long text under token limit and preserves anchors", () => {
    const long = [
      "We observed an exception in src/index.ts when calling the endpoint.",
      "The stack trace suggests a null pointer in packSnippets().",
      "Further details are included below:",
      " ".repeat(2000) // ensure over the token threshold
    ].join(" ");

    const out = summarizeIfLong(long, 100);
    // Should be under or equal the token limit by heuristic
    const approxTokens = Math.ceil(out.length / 4);
    expect(approxTokens).toBeLessThanOrEqual(100);
    // Anchors line preserved with file path
    expect(out).toMatch(/\[anchors\]/);
    expect(out).toContain("src/index.ts");
  });
});

describe("salience.redact", () => {
  it("scrubs secrets using configured regex patterns", () => {
    const txt = "api_key: ABC-123 password=foobar secret: s3cr3t";
    const out = redact(txt);
    expect(out).not.toContain("ABC-123");
    expect(out).not.toContain("foobar");
    expect(out).not.toContain("s3cr3t");
    // Replacements should be applied
    expect(out).toContain("[REDACTED]");
  });
});
