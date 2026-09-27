import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CheckpointError, Engine, IP } from "./engine.js";
import { ParamsError, canon, checkParams, paramsDigest, type ReactorParams } from "./params.js";
import { sha256HexSync } from "./sha256.js";

// Shared with tests/test_params.py: the base core, check cases, digests and a pinned run both languages must agree on.
const CHECKS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../schema/params-vectors/checks.json", import.meta.url)), "utf-8"),
);

/** A made-up one-rod core, written by hand: no library folder, no validity or shape sections. */
function tinyCore(): ReactorParams {
  return structuredClone(CHECKS.base);
}

function withSections(p: ReactorParams): ReactorParams {
  return { ...p, ...structuredClone(CHECKS.sections) };
}

function applyEdits(p: any, edits: any[]): void {
  for (const ed of edits) {
    const path = [...ed.path];
    const last = path.pop();
    let node = p;
    for (const k of path) node = node[k];
    if (Object.hasOwn(ed, "value")) {
      node[last] = structuredClone(ed.value);
    } else if (ed.delete) {
      if (Array.isArray(node)) node.splice(last, 1);
      else delete node[last];
    } else if (Object.hasOwn(ed, "append")) {
      node[last].push(structuredClone(ed.append));
    } else {
      node[last] = Number(ed.nonfinite); // "nan" -> NaN
    }
  }
}

describe("plain params", () => {
  it("a hand-built core runs", () => {
    const e = new Engine(tinyCore());
    const p0 = e.y[IP]!;
    expect(Math.abs(p0 - (1.0 * 5e-5) / 0.02)).toBeLessThanOrEqual(1e-15); // P = -S * Lambda / rho
    e.advance(5.0);
    expect(Math.abs(e.y[IP]! / p0 - 1.0)).toBeLessThan(1e-8);
    e.submit({ type: "rod.move", rod: "control", direction: "out" });
    e.advance(5.0);
    expect(e.y[IP]!).toBeGreaterThan(2 * p0);
    expect(e.validity()).toEqual({ status: "unvalidated", reasons: ["R_PARAMS_UNVALIDATED"] });
    expect(() => e.shape()).toThrow();
  });

  it("the engine keeps its own copy", () => {
    const p = tinyCore();
    const e = new Engine(p);
    const digest = e.digest;
    p.kinetics.genTime = 1.0;
    e.advance(0.1);
    expect(e.digest).toBe(digest);
    expect(e.model.genTime).toBe(5e-5);
  });
});

describe("checks", () => {
  it("valid cores pass", () => {
    checkParams(tinyCore());
    checkParams(withSections(tinyCore()));
  });

  it("shared cases report the same path as Python", () => {
    expect(CHECKS.cases.length).toBeGreaterThanOrEqual(50);
    for (const c of CHECKS.cases) {
      const p = c.withSections ? withSections(tinyCore()) : tinyCore();
      applyEdits(p, c.edits);
      let err: unknown = null;
      try {
        checkParams(p);
      } catch (e) {
        err = e;
      }
      expect(err, c.name).toBeInstanceOf(ParamsError);
      expect((err as ParamsError).path, c.name).toBe(c.expect);
    }
  });

  it("the engine checks before running", () => {
    const p: any = tinyCore();
    p.kinetics.lambda = [1.0, 1.0, 1.0, 1.0, 1.0];
    expect(() => new Engine(p)).toThrow(ParamsError);
  });
});

describe("shared run", () => {
  it("matches the values Python pinned (golden-vector tolerance, rel 1e-9)", () => {
    const run = CHECKS.run;
    const e = new Engine(withSections(tinyCore()), run.init, run.seed, run.config);
    for (let k = 0; k < run.steps; k++) {
      for (const item of run.script) {
        if (item.step === k) e.submit(item.cmd);
      }
      e.step();
    }
    const s = e.snapshot(true);
    const want = run.expect;
    const got: Record<string, number> = {
      power: s.truth.power,
      fuelTemp: s.truth.fuelTemp,
      peakPower: e.peakPower,
      indicated: s.indicated.nm,
    };
    for (const [key, value] of Object.entries(got)) {
      expect(Math.abs(value - want[key]), key).toBeLessThan(1e-9 * Math.abs(want[key]));
    }
    expect(s.truth.shape.length).toBe(want.shape.length);
    s.truth.shape.forEach((x: number, i: number) => {
      expect(Math.abs(x - want.shape[i])).toBeLessThan(1e-9 * Math.abs(want.shape[i]));
    });
    expect(s.validity).toEqual(want.validity);
    expect(s.trips.latched).toEqual(want.latched);
  });
});

describe("digest", () => {
  it("canonical text", () => {
    const out: string[] = [];
    canon({ b: [1, -0.0], a: "é" }, out);
    expect(out.join("")).toBe('{"a":"\\u00e9","b":[f3ff0000000000000,f8000000000000000]}');
  });

  it("matches the digests Python pinned", () => {
    const d = CHECKS.digests;
    expect(paramsDigest(tinyCore())).toBe(d.base);
    expect(paramsDigest(withSections(tinyCore()))).toBe(d.baseWithSections);
    expect(paramsDigest(d.mixed.value)).toBe(d.mixed.digest);
  });

  it("follows content, not key order", () => {
    const p = tinyCore();
    const q = Object.fromEntries(Object.entries(p).reverse());
    expect(paramsDigest(q)).toBe(paramsDigest(p));
    const r = tinyCore();
    r.thermal.UA = 5000.000000001;
    expect(paramsDigest(r)).not.toBe(paramsDigest(p));
    expect(paramsDigest({ x: 1, y: undefined })).toBe(paramsDigest({ x: 1.0 }));
  });

  it("restore and replay reject edited params", () => {
    const e = new Engine(tinyCore());
    e.advance(0.1);
    const cp = JSON.parse(JSON.stringify(e.checkpoint()));
    Engine.restore(tinyCore(), cp);
    const edited = tinyCore();
    edited.thermal.UA = 5001.0;
    expect(() => Engine.restore(edited, cp)).toThrow(CheckpointError);
    expect(() => Engine.replay(edited, e.session(), 1)).toThrow(CheckpointError);
  });

  it("sync SHA-256 matches node:crypto at every padding boundary", () => {
    const data = new Uint8Array(300);
    for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 7) & 0xff;
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 300]) {
      const chunk = data.subarray(0, n);
      expect(sha256HexSync(chunk), `length ${n}`).toBe(createHash("sha256").update(chunk).digest("hex"));
    }
  });
});
