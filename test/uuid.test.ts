import { test, expect, describe } from "vitest";
import { generateAuditId, getIdGenerator } from "../src/id.ts";

describe("ID generation", () => {
  test("default generates valid UUID v7 format", () => {
    const id = generateAuditId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateAuditId());
    }
    expect(ids.size).toBe(1000);
  });

  test("IDs are roughly sortable by time", () => {
    const id1 = generateAuditId();
    const start = Date.now();
    while (Date.now() === start) {
      /* busy wait 1ms */
    }
    const id2 = generateAuditId();
    expect(id1 < id2).toBe(true);
  });
});

describe("getIdGenerator", () => {
  test("uuidv7 preset returns a function", () => {
    const gen = getIdGenerator("uuidv7");
    expect(gen).toBeTypeOf("function");
    const id = gen!();
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  test("uuidv4 preset returns a function", () => {
    const gen = getIdGenerator("uuidv4");
    expect(gen).toBeTypeOf("function");
    const id = gen!();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/);
  });

  test("serial preset returns null", () => {
    expect(getIdGenerator("serial")).toBeNull();
  });

  test("custom generator is used", () => {
    let counter = 0;
    const gen = getIdGenerator({ generate: () => `custom_${++counter}` });
    expect(gen).toBeTypeOf("function");
    expect(gen!()).toBe("custom_1");
    expect(gen!()).toBe("custom_2");
  });

  test("default is uuidv7", () => {
    const gen = getIdGenerator();
    const id = gen!();
    // v7 has "7" as version nibble
    expect(id[14]).toBe("7");
  });
});
