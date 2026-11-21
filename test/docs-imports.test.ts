import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Every `import { ... } from "drizzle-audit[/subpath]"` shown in the README or in a JSDoc example
// must name something that entry point really exports at runtime. Guards against docs drifting from
// the package's subpath layout (e.g. importing `drizzleTableStorage` from the root entry).

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function sourceFor(subpath: string): string {
  // package.json exports "./storage/drizzle" → dist/storage/drizzle.mjs → src/storage/drizzle.ts
  const target = pkg.exports[subpath]?.import?.default as string | undefined;
  if (!target) throw new Error(`"drizzle-audit${subpath.slice(1)}" is not a package export`);
  const base = target.replace(/^\.\/dist\//, "src/").replace(/\.mjs$/, "");
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    try {
      if (statSync(join(root, candidate)).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`no source file for export ${subpath} (${target})`);
}

function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });
}

interface DocImport {
  file: string;
  specifier: string;
  names: string[];
}

function collectImports(): DocImport[] {
  const files = ["README.md", ...walk("src").filter((f) => f.endsWith(".ts"))];
  const found: DocImport[] = [];
  const re = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](drizzle-audit(?:\/[\w/-]+)?)["']/g;
  for (const file of files) {
    // JSDoc lines start with ` * `; strip that so multi-line imports parse the same way.
    const text = readFileSync(join(root, file), "utf8").replace(/^\s*\*\s?/gm, "");
    for (const match of text.matchAll(re)) {
      if (match[1]) continue; // `import type { ... }` — erased at runtime
      const names = match[2]!
        .split(",")
        .map((s) => s.replace(/\/\/.*$/gm, "").trim())
        .filter((s) => s && !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0]!.trim());
      found.push({ file, specifier: match[3]!, names });
    }
  }
  return found;
}

const imports = collectImports();

describe("documented imports", () => {
  test("finds the documented imports", () => {
    expect(imports.length).toBeGreaterThan(20);
  });

  const bySpecifier = Map.groupBy(imports, (i) => i.specifier);
  for (const [specifier, uses] of bySpecifier) {
    test(`${specifier} exports what the docs import`, async () => {
      const subpath =
        specifier === "drizzle-audit" ? "." : `.${specifier.slice("drizzle-audit".length)}`;
      const mod = await import(join(root, sourceFor(subpath)));
      const missing = uses.flatMap((u) =>
        u.names
          .filter((n) => !(n in mod))
          .map((n) => `${n} (${relative(root, join(root, u.file))})`),
      );
      expect(missing).toEqual([]);
    });
  }
});
