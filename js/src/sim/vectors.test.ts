import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonForm, validateSnapshot } from "../contracts/validate.js";
import { compareDocs } from "./compare.js";
import { ENGINE_VERSION } from "./engine.js";
import { paramsDigest } from "./params.js";
import { engineVectorsDir, loadSyntheticCore } from "./testing.js";
import { runScenario } from "./vectors.js";

describe("Engine golden vectors (the main oracle)", () => {
  it("reproduces every golden vector within declared tolerances and validates snapshots", async () => {
    const lib = await loadSyntheticCore();
    const files = readdirSync(engineVectorsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files.length).toBe(6);

    for (const file of files) {
      const content = readFileSync(join(engineVectorsDir, file), "utf-8");
      const committed = JSON.parse(content);

      const sc = {
        name: committed.name,
        description: committed.description,
        init: committed.init,
        seed: committed.seed,
        config: committed.config,
        steps: committed.steps,
        sampleEvery: committed.sampleEvery,
        script: committed.script,
      };

      const produced = runScenario(lib, sc, (e) => {
        const issues = validateSnapshot(jsonForm(e.snapshot()));
        expect(issues).toEqual([]);
        if (e.stepIndex === sc.steps) {
          const endIssues = validateSnapshot(jsonForm(e.snapshot(true)));
          expect(endIssues).toEqual([]);
        }
      });

      const problems = compareDocs(committed, produced, committed.tolerances);
      expect(problems, `Vector ${file} had differences: ${problems.slice(0, 10).join("; ")}`).toEqual(
        [],
      );
    }
  });

  it("comparison catches real differences", () => {
    const doc = JSON.parse(readFileSync(join(engineVectorsDir, "scram.json"), "utf-8"));
    const tol = doc.tolerances;

    // Mutate 1: power shifted
    const other1 = structuredClone(doc);
    other1.samples[3].power *= 1 + 1e-6;
    expect(compareDocs(doc, other1, tol).length).toBeGreaterThan(0);

    // Mutate 2: fuelTemp shifted
    const other2 = structuredClone(doc);
    other2.samples[3].fuelTemp += 1e-6;
    expect(compareDocs(doc, other2, tol).length).toBeGreaterThan(0);

    // Mutate 3: reason changed
    const other3 = structuredClone(doc);
    other3.events[other3.events.length - 1].reason = "REJ_SOMETHING_ELSE";
    expect(compareDocs(doc, other3, tol).length).toBeGreaterThan(0);

    // Mutate 4: event removed
    const other4 = structuredClone(doc);
    other4.events.pop();
    expect(compareDocs(doc, other4, tol).length).toBeGreaterThan(0);
  });

  it("vectors are valid JSON without non-finite floats", () => {
    const files = readdirSync(engineVectorsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files.length).toBe(6);

    for (const file of files) {
      const content = readFileSync(join(engineVectorsDir, file), "utf-8");
      // JSON.parse rejects NaN and Infinity automatically in JS
      const doc = JSON.parse(content);
      expect(typeof doc).toBe("object");
    }
  });

  it("expected behaviour is present across scenarios", () => {
    const load = (name: string) =>
      JSON.parse(readFileSync(join(engineVectorsDir, `${name}.json`), "utf-8"));

    // pulse: max sampled power > 1e7 W and the last sample < max/100
    const pulse = load("pulse");
    const powers = pulse.samples.map((s: any) => s.power);
    const maxP = Math.max(...powers);
    expect(maxP).toBeGreaterThan(1e7);
    expect(pulse.samples[pulse.samples.length - 1].power).toBeLessThan(maxP / 100);

    // scram: the command at step 260 has reason REJ_TRIPPED and all rods are 0 in the last sample
    const scram = load("scram");
    const cmd260 = scram.events.find(
      (ev: any) => ev.type === "command" && Math.abs((ev.t ?? 0.0) - 2.6) < 1e-9,
    );
    expect(cmd260.reason).toBe("REJ_TRIPPED");
    expect(scram.samples[scram.samples.length - 1].rods).toEqual({
      safety: 0.0,
      regulating: 0.0,
      transient: 0.0,
    });

    // rejections: four reasons
    const rejections = load("rejections");
    const cmdEvents = rejections.events.filter((ev: any) => ev.type === "command");
    expect(cmdEvents.slice(0, 4).map((ev: any) => ev.reason)).toEqual([
      "REJ_INTERLOCK:fire-needs-pulse-mode",
      "REJ_NOT_PULSE_CAPABLE",
      "REJ_UNKNOWN_ROD",
      "REJ_UNKNOWN_COMMAND",
    ]);
    expect(rejections.samples[rejections.samples.length - 1].indicated.linear).toBeNull();

    // period-trip: a trip event with id period-short exists and its time is not a multiple of outerDt
    const periodTrip = load("period-trip");
    const tripEv = periodTrip.events.find(
      (ev: any) => ev.type === "trip" && ev.id === "period-short",
    );
    expect(tripEv).toBeDefined();
    const dt = periodTrip.config.outerDt;
    const steps = tripEv.t / dt;
    expect(Math.abs(steps - Math.round(steps))).toBeGreaterThan(1e-3);

    // source-level: first and last sampled power agree within 1e-8 relative
    const sourceLevel = load("source-level");
    const pFirst = sourceLevel.samples[0].power;
    const pLast = sourceLevel.samples[sourceLevel.samples.length - 1].power;
    expect(Math.abs(pLast / pFirst - 1.0)).toBeLessThan(1e-8);
  });

  it("pins match current engine and library", async () => {
    const lib = await loadSyntheticCore();
    const files = readdirSync(engineVectorsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(files.length).toBe(6);

    for (const file of files) {
      const doc = JSON.parse(readFileSync(join(engineVectorsDir, file), "utf-8"));
      expect(doc.pins.engineVersion).toBe(ENGINE_VERSION);
      expect(doc.pins.paramsDigest).toBe(paramsDigest(lib));
    }
  });
});
