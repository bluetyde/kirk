import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { nodeReader } from "./node-reader.js";
import { validateLibrary } from "./validate.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vectors = join(repoRoot, "schema", "vectors");
const syntheticCore = join(vectors, "synthetic-core");
const trigaJsi = join(repoRoot, "libraries", "triga-jsi");

const SCRIPT = `import json, sys
from kirk.libformat.validate import validate_library
print(json.dumps({d: [[i.code, i.path] for i in validate_library(d)] for d in sys.argv[1:]}))
`;

function sortPairs(pairs: [string, string][]): [string, string][] {
  return [...pairs].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
}

describe("parity oracle", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("produces identical issue codes and paths as Python on all fixture folders", async () => {
    const invalidDir = join(vectors, "invalid");
    const invalidCases = readdirSync(invalidDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(invalidDir, d.name))
      .sort();
    expect(invalidCases.length).toBe(32);

    const origText = readFileSync(join(syntheticCore, "manifest.json"), "utf-8");

    // 1. leading UTF-8 BOM (EF BB BF) before the original text
    const dir1 = mkdtempSync(join(tmpdir(), "parity-case-1-"));
    tempDirs.push(dir1);
    cpSync(join(syntheticCore, "arrays"), join(dir1, "arrays"), { recursive: true });
    writeFileSync(
      join(dir1, "manifest.json"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(origText, "utf-8"),
      ]),
    );

    // 2. one invalid UTF-8 byte (0xFF) inserted inside a string value
    const dir2 = mkdtempSync(join(tmpdir(), "parity-case-2-"));
    tempDirs.push(dir2);
    cpSync(join(syntheticCore, "arrays"), join(dir2, "arrays"), { recursive: true });
    const idx2 = origText.indexOf('"synthetic-core"');
    const p1 = Buffer.from(origText.slice(0, idx2 + 2), "utf-8");
    const p2 = Buffer.from(origText.slice(idx2 + 2), "utf-8");
    writeFileSync(
      join(dir2, "manifest.json"),
      Buffer.concat([p1, Buffer.from([0xff]), p2]),
    );

    // 3. "x": NaN, inserted after the opening {
    const dir3 = mkdtempSync(join(tmpdir(), "parity-case-3-"));
    tempDirs.push(dir3);
    cpSync(join(syntheticCore, "arrays"), join(dir3, "arrays"), { recursive: true });
    writeFileSync(
      join(dir3, "manifest.json"),
      origText.replace("{", '{\n  "x": NaN, '),
      "utf-8",
    );

    // 4. the manifest text replaced by []
    const dir4 = mkdtempSync(join(tmpdir(), "parity-case-4-"));
    tempDirs.push(dir4);
    cpSync(join(syntheticCore, "arrays"), join(dir4, "arrays"), { recursive: true });
    writeFileSync(join(dir4, "manifest.json"), "[]", "utf-8");

    // 5. no manifest.json at all
    const dir5 = mkdtempSync(join(tmpdir(), "parity-case-5-"));
    tempDirs.push(dir5);
    cpSync(join(syntheticCore, "arrays"), join(dir5, "arrays"), { recursive: true });

    // 6. every occurrence of the first rod's id replaced by "constructor"
    const parsedManifest = JSON.parse(origText) as {
      reactivity: { rods: Array<{ id: string }> };
    };
    const firstRodId = parsedManifest.reactivity.rods[0]!.id;
    const dir6 = mkdtempSync(join(tmpdir(), "parity-case-6-"));
    tempDirs.push(dir6);
    cpSync(join(syntheticCore, "arrays"), join(dir6, "arrays"), { recursive: true });
    writeFileSync(
      join(dir6, "manifest.json"),
      origText.replaceAll(`"${firstRodId}"`, '"constructor"'),
      "utf-8",
    );

    // 7. a "__proto__" key added to shapes.rodDeltas whose value is a copy of an existing delta entry
    const dir7 = mkdtempSync(join(tmpdir(), "parity-case-7-"));
    tempDirs.push(dir7);
    cpSync(join(syntheticCore, "arrays"), join(dir7, "arrays"), { recursive: true });
    const protoEntry = `\n      "__proto__": {\n        "x": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],\n        "array": "rod_safety"\n      },`;
    writeFileSync(
      join(dir7, "manifest.json"),
      origText.replace('"rodDeltas": {', '"rodDeltas": {' + protoEntry),
      "utf-8",
    );

    // 8. the top-level "id" value with a newline appended inside the string
    const dir8 = mkdtempSync(join(tmpdir(), "parity-case-8-"));
    tempDirs.push(dir8);
    cpSync(join(syntheticCore, "arrays"), join(dir8, "arrays"), { recursive: true });
    writeFileSync(
      join(dir8, "manifest.json"),
      origText.replace(
        '"id": "synthetic-core"',
        '"id": "synthetic-core\\n"',
      ),
      "utf-8",
    );

    // 9. "schemaVersion" set to true
    const dir9 = mkdtempSync(join(tmpdir(), "parity-case-9-"));
    tempDirs.push(dir9);
    cpSync(join(syntheticCore, "arrays"), join(dir9, "arrays"), { recursive: true });
    writeFileSync(
      join(dir9, "manifest.json"),
      origText.replace('"schemaVersion": "0.1.0"', '"schemaVersion": true'),
      "utf-8",
    );

    const generatedCases = [dir1, dir2, dir3, dir4, dir5, dir6, dir7, dir8, dir9];

    const allFolders = [
      ...invalidCases,
      syntheticCore,
      trigaJsi,
      ...generatedCases,
    ];

    const pythonBin = process.env.VR_PYTHON ?? "python";
    const pyProc = spawnSync(pythonBin, ["-B", "-c", SCRIPT, ...allFolders], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    if (pyProc.error) {
      throw pyProc.error;
    }
    if (pyProc.status !== 0) {
      throw new Error(`Python failed: ${pyProc.stderr}`);
    }

    const pyResults = JSON.parse(pyProc.stdout) as Record<string, [string, string][]>;

    // Assert every generated case except 6 gives at least one issue on Python side
    for (let i = 0; i < generatedCases.length; i++) {
      const gDir = generatedCases[i]!;
      const pyIssues = pyResults[gDir] ?? [];
      if (i === 5) {
        expect(pyIssues.length).toBe(0);
      } else {
        expect(pyIssues.length).toBeGreaterThan(0);
      }
    }

    for (const folder of allFolders) {
      const tsIssues = await validateLibrary(nodeReader(folder));
      const tsPairs: [string, string][] = tsIssues.map((i) => [i.code, i.path]);
      const pyPairs = pyResults[folder] ?? [];

      expect(sortPairs(tsPairs)).toEqual(sortPairs(pyPairs));
    }
  });
});
