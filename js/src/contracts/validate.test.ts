import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsonForm, validateCommand, validateSnapshot } from "./validate";

const contractVectors = fileURLToPath(
  new URL("../../../schema/contract-vectors/", import.meta.url),
);

describe("contracts validate", () => {
  it("every command invalid fixture fails with expectedCodes (8 files)", () => {
    const cmdDir = join(contractVectors, "invalid", "commands");
    const files = readdirSync(cmdDir).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBe(8);

    for (const f of files) {
      const data = JSON.parse(readFileSync(join(cmdDir, f), "utf-8")) as {
        document: unknown;
        expectedCodes: string[];
      };
      const issues = validateCommand(data.document);
      const gotCodes = new Set(issues.map((i) => i.code));
      expect(gotCodes).toEqual(new Set(data.expectedCodes));
    }
  });

  it("every snapshot invalid fixture fails with expectedCodes (9 files)", () => {
    const snapDir = join(contractVectors, "invalid", "snapshots");
    const files = readdirSync(snapDir).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBe(9);

    for (const f of files) {
      const data = JSON.parse(readFileSync(join(snapDir, f), "utf-8")) as {
        document: unknown;
        expectedCodes: string[];
      };
      const issues = validateSnapshot(data.document);
      const gotCodes = new Set(issues.map((i) => i.code));
      expect(gotCodes).toEqual(new Set(data.expectedCodes));
    }
  });

  it("jsonForm turns Infinity/NaN into null at any depth and deep copies", () => {
    const orig: { a: number; b: [number, { c: number; d: number }] } = {
      a: Number.POSITIVE_INFINITY,
      b: [Number.NaN, { c: Number.NEGATIVE_INFINITY, d: 42 }],
    };
    const cleaned = jsonForm(orig);
    expect(cleaned).toEqual({
      a: null,
      b: [null, { c: null, d: 42 }],
    });
    // Verify deep copy
    cleaned.b[1].d = 99;
    expect(orig.b[1].d).toBe(42);
  });

  it("validateSnapshot on an object with truth.period = Infinity gives exactly one E_NONFINITE at $.truth.period", () => {
    const snapFile = join(
      contractVectors,
      "invalid",
      "snapshots",
      "extra-top-level-key.json",
    );
    const data = JSON.parse(readFileSync(snapFile, "utf-8")) as {
      document: any;
    };
    const snap = data.document;
    delete snap.extra;
    snap.truth.period = Number.POSITIVE_INFINITY;

    const issues = validateSnapshot(snap);
    expect(issues.length).toBe(1);
    expect(issues[0]!.code).toBe("E_NONFINITE");
    expect(issues[0]!.path).toBe("$.truth.period");
  });

  it("ghost-rod command has zero issues", () => {
    const cmd = { type: "rod.move", rod: "ghost", direction: "out" };
    expect(validateCommand(cmd)).toEqual([]);
  });
});
