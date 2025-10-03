import { describe, it, expect } from "vitest";
import { buildBoolFilter, type FilterOptions } from "../../../src/domain/filters";

describe("buildBoolFilter", () => {
  const base: FilterOptions = {
    tenant_id: "t1",
    project_id: "p1"
  };

  it("includes required tenant and project term filters", () => {
    const q = buildBoolFilter(base);
    expect(q.bool.must).toEqual(
      expect.arrayContaining([
        { term: { tenant_id: "t1" } },
        { term: { project_id: "p1" } }
      ])
    );
  });

  it("adds optional context_id and task_id terms", () => {
    const q = buildBoolFilter({ ...base, context_id: "c1", task_id: "task-42" });
    expect(q.bool.must).toEqual(
      expect.arrayContaining([
        { term: { context_id: "c1" } },
        { term: { task_id: "task-42" } }
      ])
    );
  });

  it("adds scope terms to filter", () => {
    const q = buildBoolFilter({ ...base, scopes: ["this_task", "project"] });
    expect(q.bool.filter).toEqual(
      expect.arrayContaining([{ terms: { task_scope: ["this_task", "project"] } }])
    );
  });

  it("adds tag terms and exclude tags", () => {
    const q = buildBoolFilter({ ...base, tags: ["error", "design"], exclude_tags: ["secret"] });
    expect(q.bool.filter).toEqual(
      expect.arrayContaining([{ terms: { tags: ["error", "design"] } }])
    );
    expect(q.bool.must_not).toEqual(
      expect.arrayContaining([{ terms: { tags: ["secret"] } }])
    );
  });

  it("parses api_version >= constraints into a range filter", () => {
    const q = buildBoolFilter({ ...base, api_version: ">=3.3" });
    expect(q.bool.filter).toEqual(
      expect.arrayContaining([{ range: { api_version: { gte: "3.3" } } }])
    );
  });

  it("adds env term filter", () => {
    const q = buildBoolFilter({ ...base, env: "dev" });
    expect(q.bool.filter).toEqual(expect.arrayContaining([{ term: { env: "dev" } }]));
  });

  it("adds recency range filter when recent_days provided", () => {
    const q = buildBoolFilter({ ...base, recent_days: 7 });
    expect(q.bool.filter).toEqual(
      expect.arrayContaining([{ range: { ts: { gte: "now-7d/d" } } }])
    );
  });
});
