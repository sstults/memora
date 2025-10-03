import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { debug } from "../../../src/services/log";

describe("debug logger", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    process.env = originalEnv;
  });

  it("is a no-op when DEBUG is not set", () => {
    delete process.env.DEBUG;
    const log = debug("memora:memory");
    log("stage", { hits: 1 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs when exact namespace is enabled", () => {
    process.env.DEBUG = "memora:memory";
    const log = debug("memora:memory");
    log("hello", { a: 1 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const callArgs = errorSpy.mock.calls[0];
    expect(String(callArgs[0])).toMatch(/^\[\d{4}-\d{2}-\d{2}T.*memora:memory$/); // timestamp and namespace combined
  });

  it("respects wildcard *", () => {
    process.env.DEBUG = "*";
    debug("memora:rerank")("msg");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("respects prefix pattern memora:*", () => {
    process.env.DEBUG = "memora:*";
    debug("memora:rerank")("msg");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("supports multiple comma-separated patterns", () => {
    process.env.DEBUG = "other,memora:memory";
    debug("memora:memory")("ok");
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not log for non-matching namespace", () => {
    process.env.DEBUG = "memora:memory";
    debug("memora:rerank")("should not log");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
