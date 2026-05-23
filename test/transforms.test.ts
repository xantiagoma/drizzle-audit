import { test, expect, describe } from "vitest";
import { redact } from "../src/transforms/redact.ts";
import { mask } from "../src/transforms/mask.ts";
import { hash } from "../src/transforms/hash.ts";
import { omit } from "../src/transforms/omit.ts";
import type { AuditEntry } from "../src/types.ts";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "test-id",
    tableName: "users",
    action: "INSERT",
    rowId: "1",
    changes: null,
    oldData: null,
    newData: null,
    timestamp: new Date(),
    userId: null,
    metadata: null,
    ...overrides,
  };
}

describe("redact", () => {
  test("replaces field values with [REDACTED]", () => {
    const transform = redact("password", "token");
    const entry = makeEntry({
      newData: { name: "Alice", password: "secret123", token: "abc" },
    });
    const result = transform(entry);
    expect(result.newData!.password).toBe("[REDACTED]");
    expect(result.newData!.token).toBe("[REDACTED]");
    expect(result.newData!.name).toBe("Alice");
  });

  test("handles delta format (from/to)", () => {
    const transform = redact("password");
    const entry = makeEntry({
      changes: { password: { from: "old_secret", to: "new_secret" } },
    });
    const result = transform(entry);
    const change = result.changes!.password as { from: string; to: string };
    expect(change.from).toBe("[REDACTED]");
    expect(change.to).toBe("[REDACTED]");
  });

  test("preserves null values", () => {
    const transform = redact("password");
    const entry = makeEntry({
      newData: { name: "Alice", password: null },
    });
    const result = transform(entry);
    expect(result.newData!.password).toBeNull();
  });

  test("ignores fields not in data", () => {
    const transform = redact("password");
    const entry = makeEntry({
      newData: { name: "Alice" },
    });
    const result = transform(entry);
    expect(result.newData!.name).toBe("Alice");
    expect(result.newData!.password).toBeUndefined();
  });
});

describe("mask", () => {
  test("masks email addresses", () => {
    const transform = mask("email");
    const entry = makeEntry({
      newData: { email: "alice@example.com" },
    });
    const result = transform(entry);
    const masked = result.newData!.email as string;
    expect(masked).toContain("***");
    expect(masked).not.toBe("alice@example.com");
    expect(masked[0]).toBe("a"); // keeps first char
  });

  test("masks phone numbers showing last 4", () => {
    const transform = mask("phone");
    const entry = makeEntry({
      newData: { phone: "555-123-4567" },
    });
    const result = transform(entry);
    const masked = result.newData!.phone as string;
    expect(masked).toContain("****");
    expect(masked).toContain("4567");
  });

  test("masks short strings entirely", () => {
    const transform = mask("pin");
    const entry = makeEntry({
      newData: { pin: "1234" },
    });
    const result = transform(entry);
    expect(result.newData!.pin).toBe("****");
  });
});

describe("hash", () => {
  test("hashes field values", () => {
    const transform = hash("ssn");
    const entry = makeEntry({
      newData: { ssn: "123-45-6789" },
    });
    const result = transform(entry);
    const hashed = result.newData!.ssn as string;
    expect(hashed).toMatch(/^hash:/);
    expect(hashed).not.toBe("123-45-6789");
  });

  test("same input produces same hash", () => {
    const transform = hash("ssn");
    const entry1 = makeEntry({ newData: { ssn: "123-45-6789" } });
    const entry2 = makeEntry({ newData: { ssn: "123-45-6789" } });
    const result1 = transform(entry1);
    const result2 = transform(entry2);
    expect(result1.newData!.ssn).toBe(result2.newData!.ssn);
  });

  test("different input produces different hash", () => {
    const transform = hash("ssn");
    const entry1 = makeEntry({ newData: { ssn: "123-45-6789" } });
    const entry2 = makeEntry({ newData: { ssn: "987-65-4321" } });
    const result1 = transform(entry1);
    const result2 = transform(entry2);
    expect(result1.newData!.ssn).not.toBe(result2.newData!.ssn);
  });
});

describe("omit", () => {
  test("removes fields entirely", () => {
    const transform = omit("avatar_blob", "internal_notes");
    const entry = makeEntry({
      newData: { name: "Alice", avatar_blob: "huge_data", internal_notes: "secret" },
    });
    const result = transform(entry);
    expect(result.newData!.name).toBe("Alice");
    expect(result.newData!.avatar_blob).toBeUndefined();
    expect(result.newData!.internal_notes).toBeUndefined();
    expect("avatar_blob" in result.newData!).toBe(false);
  });

  test("handles null data", () => {
    const transform = omit("password");
    const entry = makeEntry({ newData: null });
    const result = transform(entry);
    expect(result.newData).toBeNull();
  });
});

describe("redact - edge cases", () => {
  test("handles delta with null from/to", () => {
    const transform = redact("token");
    const entry = makeEntry({
      changes: { token: { from: null, to: "new_val" } },
    });
    const result = transform(entry);
    const change = result.changes!.token as any;
    expect(change.from).toBeNull();
    expect(change.to).toBe("[REDACTED]");
  });
});

describe("mask - edge cases", () => {
  test("handles delta with null from/to", () => {
    const transform = mask("email");
    const entry = makeEntry({
      changes: { email: { from: null, to: "test@example.com" } },
    });
    const result = transform(entry);
    const change = result.changes!.email as any;
    expect(change.from).toBeNull();
    expect(change.to).toContain("***");
  });

  test("handles long non-email strings", () => {
    const transform = mask("address");
    const entry = makeEntry({
      newData: { address: "123 Main Street, City, State 12345" },
    });
    const result = transform(entry);
    const masked = result.newData!.address as string;
    expect(masked).toContain("****");
    expect(masked).toContain("2345");
  });
});

describe("hash - edge cases", () => {
  test("handles delta with null from/to", () => {
    const transform = hash("ssn");
    const entry = makeEntry({
      changes: { ssn: { from: null, to: "123-45-6789" } },
    });
    const result = transform(entry);
    const change = result.changes!.ssn as any;
    expect(change.from).toBeNull();
    expect(change.to).toMatch(/^hash:/);
  });

  test("handles null data gracefully", () => {
    const transform = hash("ssn");
    const entry = makeEntry({ newData: null, oldData: null, changes: null });
    const result = transform(entry);
    expect(result.newData).toBeNull();
    expect(result.oldData).toBeNull();
    expect(result.changes).toBeNull();
  });
});

describe("omit - edge cases", () => {
  test("handles delta format in changes", () => {
    const transform = omit("secret");
    const entry = makeEntry({
      changes: { secret: { from: "old", to: "new" }, name: "Alice" },
    });
    const result = transform(entry);
    expect("secret" in result.changes!).toBe(false);
    expect(result.changes!.name).toBe("Alice");
  });
});

describe("transform composition", () => {
  test("multiple transforms can be chained", () => {
    const transforms = [redact("password"), mask("email"), omit("avatar_blob")];

    let entry = makeEntry({
      newData: {
        name: "Alice",
        password: "secret",
        email: "alice@example.com",
        avatar_blob: "huge_data",
      },
    });

    for (const t of transforms) {
      entry = t(entry);
    }

    expect(entry.newData!.name).toBe("Alice");
    expect(entry.newData!.password).toBe("[REDACTED]");
    expect((entry.newData!.email as string)[0]).toBe("a");
    expect(entry.newData!.email as string).toContain("***");
    expect("avatar_blob" in entry.newData!).toBe(false);
  });
});
