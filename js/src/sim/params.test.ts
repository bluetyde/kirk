import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CheckpointError, Engine, IP } from "./engine";
import { ParamsError, canon, checkParams, paramsDigest, type ReactorParams } from "./params";
import { sha256HexSync } from "./sha256";

// Same case and value as tests/test_params.py, so both languages hash alike.
const DIGEST_CASE = { b: [1, 2.5, -0.0, 1e-300, true, null], a: "Å\n\"x\"", c: { z: [], y: {} }, "é": 3 };
const DIGEST_CASE_HEX = "85b44f7a31d2c68c407623a33be213a7563db02e7b9f035646408b27422da14a";

/** A made-up one-rod core, written by hand: no library folder, no validity or shape sections. */
function tinyCore(): ReactorParams {
  return {
    id: "tiny",
    kinetics: {
      beta: [0.0002, 0.0012, 0.0011, 0.0024, 0.0007, 0.0003],
      lambda: [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01],
      genTime: 5e-5,
      extSource: 1.0,
    },
    reference: { rods: { control: 0.0 }, Tfuel: 300.0, Tcoolant: 300.0, rho: -0.02 },
    rods: [
      {
        id: "control",
        speed: 0.1,
        pulseCapable: false,
        worth: { x: [0.0, 1.0], y: [0.0, 0.03] },
        scram: { t: [0.0, 0.5], x: [1.0, 0.0] },
      },
    ],
    feedback: {
      fuelTemp: { x: [300.0, 1300.0], y: [0.0, -0.01] },
      coolantTemp: { x: [270.0, 370.0], y: [0.0003, -0.0007] },
      xenon: { x: [0.0, 1e21], y: [0.0, -0.03] },
    },
    thermal: {
      fuelMass: 100.0,
      fuelCp: { x: [300.0, 1300.0], y: [300.0, 400.0] },
      coolantMass: 2e4,
      coolantCp: 4180.0,
      hA: 3000.0,
      UA: 5000.0,
      sinkTemp: 300.0,
      hxPump: "main",
      fuelFraction: 0.97,
    },
    poisons: {
      fluxPerWatt: 1e10,
      sigmaF: 0.1,
      gammaI: 0.064,
      gammaXe: 0.0025,
      lambdaI: 2.87e-5,
      lambdaXe: 2.09e-5,
      sigmaXe: 2.6e-18,
    },
    plant: {
      modes: ["run"],
      initialMode: "run",
      pumps: ["main"],
      instruments: [
        { id: "nm", signal: "truth.power", scale: "log", range: [1e-3, 1e7], lag: 0.0, noise: 0.0 },
      ],
      trips: [{ id: "high", input: "indicated.nm", predicate: { op: "gt", value: 1e6 }, latching: true }],
      interlocks: [],
    },
  };
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
  const cases: [(p: any) => void, string][] = [
    [(p) => p.kinetics.beta.pop(), "$.kinetics.beta"],
    [(p) => (p.kinetics.genTime = 0.0), "$.kinetics.genTime"],
    [(p) => (p.kinetics.genTIme = 1.0), "$.kinetics.genTIme"],
    [(p) => delete p.poisons, "$.poisons"],
    [(p) => (p.feedback.fuelTemp.x = [300.0, 300.0]), "$.feedback.fuelTemp.x"],
    [(p) => (p.feedback.xenon.outOfRange = "wrap"), "$.feedback.xenon.outOfRange"],
    [(p) => (p.rods[0].pulseCapable = true), "$.rods[0].fireTime"],
    [(p) => (p.rods[0].scram.x = [1.0, 0.5]), "$.rods[0].scram.x"],
    [(p) => (p.reference.rods.ghost = 0.0), "$.reference.rods.ghost"],
    [(p) => (p.thermal.hxPump = "spare"), "$.thermal.hxPump"],
    [(p) => (p.kinetics.extSource = NaN), "$.kinetics.extSource"],
    [(p) => (p.plant.instruments[0].signal = "truth.mode"), "$.plant.instruments[0].signal"],
    [(p) => (p.plant.trips[0].input = "indicated.ghost"), "$.plant.trips[0].input"],
    [(p) => (p.plant.trips[0].predicate = { op: "gt", value: "high" }), "$.plant.trips[0].predicate.value"],
    [
      (p) => p.plant.interlocks.push({ id: "x", when: { op: "gt", value: 1.0 }, blocks: ["rod.move"], reason: "r" }),
      "$.plant.interlocks[0].when",
    ],
  ];

  it("the tiny core passes", () => {
    checkParams(tinyCore());
  });

  for (const [change, path] of cases) {
    it(`reports ${path}`, () => {
      const p = tinyCore();
      change(p);
      let err: unknown = null;
      try {
        checkParams(p);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ParamsError);
      expect((err as ParamsError).path).toBe(path);
    });
  }

  it("the engine checks before running", () => {
    const p: any = tinyCore();
    p.kinetics.lambda = [1.0, 1.0, 1.0, 1.0, 1.0];
    expect(() => new Engine(p)).toThrow(ParamsError);
  });
});

describe("digest", () => {
  it("canonical text", () => {
    const out: string[] = [];
    canon({ b: [1, -0.0], a: "é" }, out);
    expect(out.join("")).toBe('{"a":"\\u00e9","b":[f3ff0000000000000,f8000000000000000]}');
  });

  it("matches Python on the cross-language case", () => {
    expect(paramsDigest(DIGEST_CASE)).toBe(DIGEST_CASE_HEX);
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
