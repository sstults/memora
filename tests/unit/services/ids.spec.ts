import { describe, it, expect } from "vitest";
import {
  makeEventId,
  makeMemIdFromText,
  makeFactId,
  shortId,
  safeNowIso,
  dailyIndex,
  contentHash,
  stableJson,
  parseDocId
} from "../../../src/services/ids";


describe("ids utilities", () => {


  it("makeEventId produces evt_ prefix and base32 length", () => {
    const id = makeEventId();
    expect(id).toMatch(/^evt_[a-z2-7]{16}$/);
  });

  it("makeMemIdFromText is deterministic and prefixed", () => {
    const a1 = makeMemIdFromText("hello world");
    const a2 = makeMemIdFromText("hello world");
    const b = makeMemIdFromText("different");

    expect(a1).toEqual(a2);
    expect(a1).toMatch(/^mem_[0-9a-f]{24}$/);
    expect(b).not.toEqual(a1);
  });

  it("makeFactId is deterministic over triple", () => {
    const f1 = makeFactId("s", "p", "o");
    const f2 = makeFactId("s", "p", "o");
    const f3 = makeFactId("s", "p", "o2");
    expect(f1).toEqual(f2);
    expect(f1).toMatch(/^fact_[0-9a-f]{24}$/);
    expect(f3).not.toEqual(f1);
  });

  it("shortId respects prefix and has expected length", () => {
    const id = shortId("x_");
    expect(id.startsWith("x_")).toBe(true);
    // prefix + 10 base32 chars
    expect(id.length).toBe("x_".length + 10);
    expect(id.slice(2)).toMatch(/^[a-z2-7]{10}$/);
  });

  it("safeNowIso returns a valid ISO date string", () => {
    const iso = safeNowIso();
    expect(!Number.isNaN(Date.parse(iso))).toBe(true);
  });

  it("dailyIndex composes date-index with provided date", () => {
    const d = new Date("2025-01-02T12:34:56.000Z");
    const idx = dailyIndex("mem-episodic-", d);
    expect(idx).toBe("mem-episodic-2025-01-02");
  });

  it("stableJson sorts object keys deterministically", () => {
    const s1 = stableJson({ b: 1, a: 2 });
    const s2 = stableJson({ a: 2, b: 1 });
    expect(s1).toEqual(s2);
    expect(s1).toBe('{"a":2,"b":1}');
  });

  it("contentHash is stable for same logical object regardless of key order", () => {
    const h1 = contentHash({ x: 1, y: { b: 2, a: 3 } });
    const h2 = contentHash({ y: { a: 3, b: 2 }, x: 1 });
    expect(h1).toEqual(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parseDocId identifies kinds and raw values", () => {
    expect(parseDocId("mem_abcdef").kind).toBe("mem");
    expect(parseDocId("evt_abc").kind).toBe("evt");
    expect(parseDocId("fact_abc").kind).toBe("fact");
    expect(parseDocId("other").kind).toBe("other");
    expect(parseDocId("mem_abcdef").raw).toBe("abcdef");
  });
});
