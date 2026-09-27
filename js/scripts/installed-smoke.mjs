// Smoke test for an installed kirk-kinetics tarball (run by CI's packaging job).
// Copy it into the folder where the tarball is installed and run it there:  node installed-smoke.mjs <repo>
// (Run from js/scripts it would resolve kirk-kinetics to the repository itself, through the package's self-reference.)
// Data (library folders, golden vectors) come from the repository; code comes from node_modules.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repo = process.argv[2];
const kirk = await import("kirk-kinetics");
const { nodeReader } = await import("kirk-kinetics/node");
const where = import.meta.resolve("kirk-kinetics");
if (!where.includes("node_modules")) throw new Error(`resolved kirk-kinetics outside node_modules: ${where}`);

const params = await kirk.loadParams(nodeReader(join(repo, "schema", "vectors", "synthetic-core")));
const pins = JSON.parse(readFileSync(join(repo, "schema", "engine-vectors", "source-level.json"), "utf-8")).pins;
if (pins.engineVersion !== kirk.ENGINE_VERSION) throw new Error(`engine ${kirk.ENGINE_VERSION}, vectors ${pins.engineVersion}`);
if (kirk.paramsDigest(params) !== pins.paramsDigest) throw new Error("params digest differs from the golden vectors");

const e = new kirk.Engine(params, {});
const cmd = { type: "rod.move", rod: "regulating", direction: "out" };
if (kirk.validateCommand(cmd).length) throw new Error("command rejected");
e.submit(cmd);
e.advance(1.0);
const issues = kirk.validateSnapshot(kirk.jsonForm(e.snapshot(true)));
if (issues.length) throw new Error(JSON.stringify(issues));
const libIssues = await kirk.validateLibrary(nodeReader(join(repo, "libraries", "triga-jsi")));
if (libIssues.length) throw new Error(JSON.stringify(libIssues));
// The main entry must stay browser-safe: only the "./node" entry may load node: modules.
const dist = new URL("./", where);
const nodeOnly = new Set(["node.js", "library/node-reader.js"]);
const pending = ["index.js"];
const seen = new Set();
while (pending.length) {
  const file = pending.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  if (nodeOnly.has(file)) throw new Error(`the main entry reaches the Node-only module ${file}`);
  const text = readFileSync(new URL(file, dist), "utf-8");
  for (const [, spec] of text.matchAll(/(?:from|import)\s*"([^"]+)"/g)) {
    if (spec.startsWith("node:")) throw new Error(`${file} imports ${spec}`);
    if (spec.startsWith(".")) pending.push(new URL(spec, new URL(file, dist)).href.slice(dist.href.length));
  }
}

console.log(`installed kirk-kinetics ${kirk.ENGINE_VERSION} from ${where}: OK`);
