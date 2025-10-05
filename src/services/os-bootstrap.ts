// src/services/os-bootstrap.ts
// OpenSearch bootstrap: health gating, idempotent template/index setup, vector dim validation.
//
// Behavior:
// - Waits for cluster health (yellow|green) with timeout.
// - Applies index templates and ensures indices exist, idempotently.
// - Validates knn_vector dimensions in mappings match MEMORA_EMBED_DIM (default 1024).
//   Optionally auto-fixes mismatches if MEMORA_OS_AUTOFIX_VECTOR_DIM=true.
//
// Env:
//   MEMORA_BOOTSTRAP_OS=1                        -> enable bootstrap at startup (wired from src/index.ts)
//   MEMORA_OS_MIN_HEALTH=yellow|green            -> minimum health to wait for (default: yellow)
//   MEMORA_OS_HEALTH_TIMEOUT_MS=30000            -> health wait timeout in ms (default: 30s)
//   MEMORA_EMBED_DIM=1024                        -> expected embedding vector dimension
//   MEMORA_OS_AUTOFIX_VECTOR_DIM=true|false      -> if true, adjusts loaded mappings to expected dim (default: false)
//   MEMORA_SEMANTIC_INDEX=mem-semantic           -> semantic index name
//   MEMORA_FACTS_INDEX=mem-facts                 -> facts index name
//   MEMORA_EPI_PREFIX=mem-episodic-              -> episodic daily index prefix
//   MEMORA_BOOTSTRAP_CREATE_TODAY=true|false     -> optionally create today's episodic index (default: false)
//   CONFIG_INDEX_TEMPLATES_DIR=config/index-templates -> override templates dir (default path)
//
// Notes on templates:
// - config/index-templates/mem-episodic.json is an index template (with index_patterns/template).
// - config/index-templates/mem-semantic.json and mem-facts.json are index creation bodies.

import fs from "fs";
import path from "path";
import { assertHealthy, ensureIndex, putIndexTemplate } from "./os-client.js";
import { ensurePipelineAndAttachmentFromEnv, ensureSearchPipelineFromEnv } from "./os-ml.js";

export interface BootstrapOptions {
  applyTemplates?: boolean;
  ensureBaseIndices?: boolean;
  validateVectorDims?: boolean;
  autoFixVectorDims?: boolean;
  createTodayEpisodic?: boolean;
  templatesDir?: string;
}

const DEFAULT_TEMPLATES_DIR = process.env.CONFIG_INDEX_TEMPLATES_DIR || "config/index-templates";
const SEMANTIC_INDEX = process.env.MEMORA_SEMANTIC_INDEX || "mem-semantic";
const FACTS_INDEX = process.env.MEMORA_FACTS_INDEX || "mem-facts";
const EPI_PREFIX = process.env.MEMORA_EPI_PREFIX || "mem-episodic-";

const EXPECTED_DIM = Number(process.env.MEMORA_EMBED_DIM || 1024);
const AUTOFIX_DIM = (process.env.MEMORA_OS_AUTOFIX_VECTOR_DIM || "false").toLowerCase() === "true";

function readJson(filePath: string): any {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * Recursively visit an object and apply fn on any knn_vector mapping object:
 * { type: "knn_vector", dimension: number, ... }
 */
function visitKnnVectorMappings(obj: any, fn: (node: any) => void) {
  if (!obj || typeof obj !== "object") return;
  if (obj.type === "knn_vector" && typeof obj.dimension === "number") {
    fn(obj);
  }
  for (const k of Object.keys(obj)) {
    const v = (obj as any)[k];
    if (v && typeof v === "object") {
      visitKnnVectorMappings(v, fn);
    }
  }
}

/** Extract a list of all knn_vector dimensions found in a mapping/index body. */
export function findKnnVectorDimensions(body: any): number[] {
  const dims: number[] = [];
  visitKnnVectorMappings(body, (node) => {
    if (typeof node.dimension === "number") {
      dims.push(node.dimension);
    }
  });
  return dims;
}

/** Adjust all knn_vector dimension fields to the expected dimension (in-place). */
export function adjustAllKnnVectorDimensions(body: any, expectedDim: number): void {
  visitKnnVectorMappings(body, (node) => {
    node.dimension = expectedDim;
  });
}

/**
 * Validate that all knn_vector mappings across provided bodies match expectedDim.
 * If autoFix is true, mismatches are corrected in-place and no error is thrown.
 * If autoFix is false and mismatches exist, throws a descriptive error.
 */
export function validateOrFixVectorDims(bodies: Array<{ name: string; body: any }>, expectedDim: number, autoFix: boolean) {
  const mismatches: Array<{ name: string; found: number[] }> = [];

  for (const { name, body } of bodies) {
    const dims = findKnnVectorDimensions(body);
    const bad = dims.filter((d) => d !== expectedDim);
    if (bad.length > 0) {
      if (autoFix) {
        adjustAllKnnVectorDimensions(body, expectedDim);
      } else {
        mismatches.push({ name, found: dims });
      }
    }
  }

  if (mismatches.length > 0) {
    const details = mismatches
      .map((m) => `${m.name}: [${m.found.join(", ")}] (expected ${expectedDim})`)
      .join("; ");
    throw new Error(`Vector dimension mismatch in mappings: ${details}. Set MEMORA_EMBED_DIM to match templates or enable MEMORA_OS_AUTOFIX_VECTOR_DIM=true to auto-adjust.`);
  }
}

/** Perform OpenSearch bootstrap as described above. */
export async function bootstrapOpenSearch(opts: BootstrapOptions = {}): Promise<void> {
  const {
    applyTemplates = true,
    ensureBaseIndices = true,
    validateVectorDims = true,
    autoFixVectorDims = AUTOFIX_DIM,
    createTodayEpisodic = (process.env.MEMORA_BOOTSTRAP_CREATE_TODAY || "false").toLowerCase() === "true",
    templatesDir = DEFAULT_TEMPLATES_DIR
  } = opts;

  // 1) Health gating
  await assertHealthy();

  // 2) Load known files
  const episodicTemplatePath = path.join(templatesDir, "mem-episodic.json");
  const semanticIndexBodyPath = path.join(templatesDir, "mem-semantic.json");
  const factsIndexBodyPath = path.join(templatesDir, "mem-facts.json");

  const haveEpisodicTemplate = fs.existsSync(episodicTemplatePath);
  const haveSemantic = fs.existsSync(semanticIndexBodyPath);
  const haveFacts = fs.existsSync(factsIndexBodyPath);

  // 3) Validate vector dims (pre-apply)
  const toValidate: Array<{ name: string; body: any }> = [];
  if (haveSemantic) {
    const semanticBody = readJson(semanticIndexBodyPath);
    toValidate.push({ name: path.basename(semanticIndexBodyPath), body: semanticBody });
  }
  if (haveFacts) {
    const factsBody = readJson(factsIndexBodyPath);
    // facts currently has no vectors but safe to include; findKnnVectorDimensions will be empty
    toValidate.push({ name: path.basename(factsIndexBodyPath), body: factsBody });
  }
  if (validateVectorDims && toValidate.length > 0) {
    validateOrFixVectorDims(toValidate, EXPECTED_DIM, autoFixVectorDims);
  }

  // Re-read possibly adjusted bodies (or use adjusted refs)
  const semanticBody = haveSemantic ? toValidate.find(x => x.name === "mem-semantic.json")?.body ?? readJson(semanticIndexBodyPath) : null;
  const factsBody = haveFacts ? toValidate.find(x => x.name === "mem-facts.json")?.body ?? readJson(factsIndexBodyPath) : null;

  // 4) Apply the episodic index template (idempotent)
  if (applyTemplates && haveEpisodicTemplate) {
    const episodicTemplate = readJson(episodicTemplatePath);
    await putIndexTemplate("mem-episodic", episodicTemplate);
  }

  // 5) Ensure base indices exist (idempotent)
  if (ensureBaseIndices) {
    if (semanticBody) {
      await ensureIndex(SEMANTIC_INDEX, semanticBody);
    }
    if (factsBody) {
      await ensureIndex(FACTS_INDEX, factsBody);
    }
    if (createTodayEpisodic) {
      const episodicToday = `${EPI_PREFIX}${new Date().toISOString().slice(0, 10)}`;
      await ensureIndex(episodicToday);
    }
  }

  // 6) Provision ML ingest pipeline and optional default_pipeline attach (no-op unless configured)
  await ensurePipelineAndAttachmentFromEnv();

  // 7) Provision search pipeline and optionally attach index.search.default_pipeline (no-op unless configured)
  await ensureSearchPipelineFromEnv();
}
