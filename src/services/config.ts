import fs from "fs";
import yaml from "js-yaml";

// Lightweight YAML-backed config loader with lazy caches and typed getters.

export type AnyObject = Record<string, any>;

let retrievalCache: AnyObject | null = null;
let policiesCache: AnyObject | null = null;
let packingCache: AnyObject | null = null;

function safeLoadYaml(path: string): AnyObject {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const doc = yaml.load(raw);
    return (doc as AnyObject) || {};
  } catch {
    return {};
  }
}

// Public: raw config objects

export function getRetrievalConfig(): AnyObject {
  if (!retrievalCache) {
    retrievalCache = safeLoadYaml("config/retrieval.yaml");
  }
  return retrievalCache!;
}

export function getPoliciesConfig(): AnyObject {
  if (!policiesCache) {
    policiesCache = safeLoadYaml("config/memory_policies.yaml");
  }
  return policiesCache!;
}

export function getPackingConfig(): AnyObject {
  if (!packingCache) {
    packingCache = safeLoadYaml("config/packing.yaml");
  }
  return packingCache!;
}

// Path utilities

function getIn(obj: AnyObject, path: string): any {
  if (!obj) return undefined;
  const segs = path.split(".");
  let cur: any = obj;
  for (const s of segs) {
    if (cur == null) return undefined;
    cur = cur[s];
  }
  return cur;
}

function coerceNumber(v: any, dflt: number): number {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return dflt;
}

function coerceBoolean(v: any, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
    const n = Number(v);
    if (!Number.isNaN(n)) return n !== 0;
  }
  return dflt;
}

function coerceStringArray(v: any, dflt: string[]): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
  return dflt;
}

// Typed getters: Retrieval (config/retrieval.yaml)

export function retrievalNumber(path: string, dflt: number): number {
  const v = getIn(getRetrievalConfig(), path);
  return coerceNumber(v, dflt);
}

export function retrievalBoolean(path: string, dflt: boolean): boolean {
  const v = getIn(getRetrievalConfig(), path);
  return coerceBoolean(v, dflt);
}

export function retrievalArray(path: string, dflt: string[]): string[] {
  const v = getIn(getRetrievalConfig(), path);
  return coerceStringArray(v, dflt);
}

// Typed getters: Policies (config/memory_policies.yaml)

export function policyNumber(path: string, dflt: number): number {
  const v = getIn(getPoliciesConfig(), path);
  return coerceNumber(v, dflt);
}

export function policyBoolean(path: string, dflt: boolean): boolean {
  const v = getIn(getPoliciesConfig(), path);
  return coerceBoolean(v, dflt);
}

export function policyArray(path: string, dflt: string[]): string[] {
  const v = getIn(getPoliciesConfig(), path);
  return coerceStringArray(v, dflt);
}

// Optional: expose a way to clear caches (useful for tests)
export function __resetConfigCaches() {
  retrievalCache = null;
  policiesCache = null;
  packingCache = null;
}
