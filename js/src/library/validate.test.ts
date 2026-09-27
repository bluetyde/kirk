import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeReader } from "./node-reader";
import { increasing, interp, safeRelpath, validateLibrary } from "./validate";

const vectors = fileURLToPath(new URL("../../../schema/vectors/", import.meta.url));
const trigaJsiPath = fileURLToPath(new URL("../../../libraries/triga-jsi", import.meta.url));

describe("validate helpers", () => {
  it("interp", () => {
    expect(interp([0, 1], [0, 10], 0.5)).toBe(5);
    expect(interp([0, 1], [0, 10], 1)).toBe(10);
    expect(interp([0, 1], [0, 10], 1.5)).toBeNull();
  });

  it("safeRelpath", () => {
    for (const ok of ["arrays/base.f32", "a.f32"]) {
      expect(safeRelpath(ok)).toBe(true);
    }
    for (const bad of ["../a", "/abs", "C:/x", "a\\b", "arrays/../../x", "./a", ""]) {
      expect(safeRelpath(bad)).toBe(false);
    }
  });

  it("increasing", () => {
    expect(increasing([1, 2, 3])).toBe(true);
    expect(increasing([1, 1, 2])).toBe(false);
    expect(increasing([3, 2, 1])).toBe(false);
    expect(increasing([])).toBe(true);
    expect(increasing([42])).toBe(true);
  });
});

describe("library fixtures", () => {
  it("synthetic core is valid", async () => {
    const issues = await validateLibrary(nodeReader(join(vectors, "synthetic-core")));
    expect(issues).toEqual([]);
  });

  it("triga-jsi is valid", async () => {
    const issues = await validateLibrary(nodeReader(trigaJsiPath));
    expect(issues).toEqual([]);
  });

  it("every invalid fixture fails with exactly its codes", async () => {
    const invalidDir = join(vectors, "invalid");
    const cases = readdirSync(invalidDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    expect(cases.length).toBe(32);

    for (const caseName of cases) {
      const caseFolder = join(invalidDir, caseName);
      const expectedJson = JSON.parse(
        readFileSync(join(caseFolder, "expected.json"), "utf-8"),
      ) as { codes: string[] };
      const expectedCodes = new Set(expectedJson.codes);

      const issues = await validateLibrary(nodeReader(caseFolder));
      const gotCodes = new Set(issues.map((i) => i.code));

      expect(gotCodes).toEqual(expectedCodes);
    }
  });
});
