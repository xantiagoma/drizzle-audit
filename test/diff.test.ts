import { test, expect, describe } from "vitest";
import { computeDiff, buildChanges } from "../src/diff.ts";

describe("computeDiff", () => {
  test("returns empty array when both are null", () => {
    expect(computeDiff(null, null)).toEqual([]);
  });

  test("returns all fields as added when oldData is null", () => {
    const result = computeDiff(null, { name: "Alice", age: 30 });
    expect(result).toEqual([
      { field: "name", from: undefined, to: "Alice" },
      { field: "age", from: undefined, to: 30 },
    ]);
  });

  test("returns all fields as removed when newData is null", () => {
    const result = computeDiff({ name: "Alice", age: 30 }, null);
    expect(result).toEqual([
      { field: "name", from: "Alice", to: undefined },
      { field: "age", from: 30, to: undefined },
    ]);
  });

  test("returns only changed fields", () => {
    const result = computeDiff(
      { name: "Alice", age: 30, email: "a@x.com" },
      { name: "Bob", age: 30, email: "a@x.com" },
    );
    expect(result).toEqual([{ field: "name", from: "Alice", to: "Bob" }]);
  });

  test("detects added fields", () => {
    const result = computeDiff({ name: "Alice" }, { name: "Alice", age: 30 });
    expect(result).toEqual([{ field: "age", from: undefined, to: 30 }]);
  });

  test("detects removed fields", () => {
    const result = computeDiff({ name: "Alice", age: 30 }, { name: "Alice" });
    expect(result).toEqual([{ field: "age", from: 30, to: undefined }]);
  });

  test("handles nested objects", () => {
    const result = computeDiff(
      { config: { theme: "dark", lang: "en" } },
      { config: { theme: "light", lang: "en" } },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("config");
  });

  test("handles arrays with different length", () => {
    const result = computeDiff({ tags: ["a", "b"] }, { tags: ["a", "b", "c"] });
    expect(result).toHaveLength(1);
    expect(result[0]!.field).toBe("tags");
  });

  test("handles equal arrays", () => {
    const result = computeDiff({ tags: ["a", "b"] }, { tags: ["a", "b"] });
    expect(result).toHaveLength(0);
  });

  test("handles arrays with different elements", () => {
    const result = computeDiff({ tags: ["a", "b"] }, { tags: ["a", "c"] });
    expect(result).toHaveLength(1);
  });

  test("handles mixed array vs non-array", () => {
    const result = computeDiff({ val: [1, 2] }, { val: "not array" });
    expect(result).toHaveLength(1);
  });

  test("handles different types", () => {
    const result = computeDiff({ val: 42 }, { val: "42" });
    expect(result).toHaveLength(1);
  });

  test("respects ignoreFields", () => {
    const result = computeDiff(
      { name: "Alice", updatedAt: "2024-01-01" },
      { name: "Bob", updatedAt: "2024-06-01" },
      { ignoreFields: ["updatedAt"] },
    );
    expect(result).toEqual([{ field: "name", from: "Alice", to: "Bob" }]);
  });

  test("returns empty when no changes", () => {
    const result = computeDiff({ name: "Alice", age: 30 }, { name: "Alice", age: 30 });
    expect(result).toEqual([]);
  });

  test("handles null vs undefined correctly", () => {
    const result = computeDiff({ name: null }, { name: "Alice" });
    expect(result).toEqual([{ field: "name", from: null, to: "Alice" }]);
  });
});

describe("buildChanges", () => {
  test("INSERT returns all new fields", () => {
    const result = buildChanges("INSERT", null, { id: 1, name: "Alice" });
    expect(result).toEqual({ id: 1, name: "Alice" });
  });

  test("DELETE returns all old fields", () => {
    const result = buildChanges("DELETE", { id: 1, name: "Alice" }, null);
    expect(result).toEqual({ id: 1, name: "Alice" });
  });

  test("UPDATE returns only changed fields with from/to", () => {
    const result = buildChanges(
      "UPDATE",
      { id: 1, name: "Alice", email: "a@x.com" },
      { id: 1, name: "Bob", email: "a@x.com" },
    );
    expect(result).toEqual({ name: { from: "Alice", to: "Bob" } });
  });

  test("UPDATE returns null when nothing changed", () => {
    const result = buildChanges("UPDATE", { id: 1, name: "Alice" }, { id: 1, name: "Alice" });
    expect(result).toBeNull();
  });

  test("returns null when both are null", () => {
    expect(buildChanges("UPDATE", null, null)).toBeNull();
  });
});
