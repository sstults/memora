// tests/unit/services/os-bootstrap.spec.ts
import { describe, it, expect } from "vitest";
import {
  findKnnVectorDimensions,
  validateOrFixVectorDims,
  adjustAllKnnVectorDimensions
} from "../../../src/services/os-bootstrap";

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe("os-bootstrap vector dimension helpers", () => {
  const baseSemanticBody = {
    settings: {
      "index.knn": true
    },
    mappings: {
      properties: {
        title: { type: "text" },
        text: { type: "text" },
        embedding: {
          type: "knn_vector",
          dimension: 1024,
          method: {
            name: "hnsw",
            space_type: "cosinesimil",
            engine: "faiss",
            parameters: { ef_construction: 512, m: 32 }
          }
        },
        nested: {
          properties: {
            vec2: {
              type: "knn_vector",
              dimension: 1024
            }
          }
        }
      }
    }
  };

  it("findKnnVectorDimensions collects all knn_vector dims recursively", () => {
    const dims = findKnnVectorDimensions(baseSemanticBody);
    expect(Array.isArray(dims)).toBe(true);
    // 2 knn_vector fields at 1024
    expect(dims).toEqual([1024, 1024]);
  });

  it("findKnnVectorDimensions returns empty when none present", () => {
    const body = { mappings: { properties: { title: { type: "text" } } } };
    const dims = findKnnVectorDimensions(body);
    expect(dims).toEqual([]);
  });

  it("validateOrFixVectorDims throws on mismatch when autoFix=false", () => {
    const bad = deepClone(baseSemanticBody);
    // introduce a mismatched dimension
    (bad as any).mappings.properties.embedding.dimension = 256;

    expect(() =>
      validateOrFixVectorDims([{ name: "mem-semantic.json", body: bad }], 1024, false)
    ).toThrow(/Vector dimension mismatch/i);
  });

  it("validateOrFixVectorDims auto-fixes when autoFix=true", () => {
    const bad = deepClone(baseSemanticBody);
    (bad as any).mappings.properties.embedding.dimension = 256;

    // Should not throw
    validateOrFixVectorDims([{ name: "mem-semantic.json", body: bad }], 1024, true);

    // Confirm fixed
    const dims = findKnnVectorDimensions(bad);
    expect(dims.every((d) => d === 1024)).toBe(true);
  });

  it("adjustAllKnnVectorDimensions sets all dims to expected", () => {
    const body = deepClone(baseSemanticBody);
    (body as any).mappings.properties.nested.properties.vec2.dimension = 384;
    adjustAllKnnVectorDimensions(body, 1536);
    const dims = findKnnVectorDimensions(body);
    expect(dims).toEqual([1536, 1536]);
  });
});
