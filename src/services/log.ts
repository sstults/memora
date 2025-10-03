/**
 * Lightweight namespaced debug logger.
 * Usage:
 *   import { debug } from "../services/log";
 *   const log = debug("memora:memory");
 *   log("stage", { hits: 12, tookMs: 34 });
 *
 * Enable with environment variable:
 *   DEBUG=memora:*        // all memora namespaces
 *   DEBUG=memora:memory   // only memory route
 *   DEBUG=*               // everything (not recommended)
 *   DEBUG=memora:memory,memora:rerank // multiple
 */
export type Logger = (...args: any[]) => void;

function parsePatterns(s: string | undefined): string[] {
  return (s || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function matches(ns: string, pattern: string): boolean {
  if (pattern === "*" || pattern === ns) return true;
  if (pattern.endsWith("*")) {
    const base = pattern.slice(0, -1);
    return ns.startsWith(base);
  }
  return false;
}

export function debug(namespace: string): Logger {
  const patterns = parsePatterns(process.env.DEBUG);
  const enabled = patterns.length > 0 && patterns.some((p) => matches(namespace, p));
  if (!enabled) {
    // No-op logger when not enabled to keep hot paths fast
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  }
  return (...args: any[]) => {
    const ts = new Date().toISOString();
    // Use stderr to avoid mixing with regular stdout output
    // Keep JSON-like objects intact; rely on util.inspect defaults
    // eslint-disable-next-line no-console
    console.error(`[${ts}] ${namespace}`, ...args);
  };
}
