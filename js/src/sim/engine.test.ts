import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadParams } from "../library/adapter.js";
import { nodeReader } from "../library/node-reader.js";
import { validateLibrary } from "../library/validate.js";
import {
  CheckpointError,
  Engine,
  IEH,
  IEP,
  II,
  IP,
  ITC,
  ITF,
  IX,
  InitError,
  roundHalfEven,
} from "./engine.js";
import { Model } from "./params.js";
import {
  comparable,
  inhourOmega,
  kineticsOnlyLib,
  loadSyntheticCore,
  pulseLib,
  scriptedRun,
  syntheticCorePath,
} from "./testing.js";
import { nearCriticalRods } from "./vectors.js";

describe("TestInitialization", () => {
  it("source equilibrium matches formula and holds", async () => {
    const L = await loadSyntheticCore();
    const M = new Model(L);
    const e = new Engine(L, {});
    const rho = e.reactivity(0.0, e.y).total;
    expect(Math.abs(e.y[IP]! - (-M.extSource * M.genTime) / rho)).toBeLessThanOrEqual(1e-15);
    const p0 = e.y[IP]!;
    e.advance(20.0);
    expect(Math.abs(e.y[IP]! / p0 - 1.0)).toBeLessThan(1e-8);
  });

  it("source equilibrium rejected at nonnegative reactivity", async () => {
    const L = await loadSyntheticCore();
    let err: any;
    try {
      new Engine(L, { rods: { safety: 1.0, regulating: 1.0, transient: 1.0 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InitError);
    expect(err.code).toBe("E_INIT_NO_EQUILIBRIUM");
  });

  it("critical equilibrium rejected with a source", async () => {
    const L = await loadSyntheticCore();
    let err: any;
    try {
      new Engine(L, { power: { mode: "critical-equilibrium", value: 100.0 } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InitError);
    expect(err.code).toBe("E_INIT_NO_EQUILIBRIUM");
  });

  it("critical steady state without source", async () => {
    const L = await kineticsOnlyLib();
    const e = new Engine(L, { power: { mode: "critical-equilibrium", value: 1000.0 } });
    e.advance(10.0);
    expect(Math.abs(e.y[IP]! / 1000.0 - 1.0)).toBeLessThan(1e-10);
  });

  it("invalid specs", async () => {
    const L = await loadSyntheticCore();
    const specs = [
      { rods: { ghost: 0.0 } },
      { rods: { safety: 1.5 } },
      { mode: "turbo" },
      { power: { mode: "given", value: -1.0 } },
      { poisons: { mode: "equilibrium" } },
    ];
    for (const spec of specs) {
      let err: any;
      try {
        new Engine(L, spec);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InitError);
      expect(err.code).toBe("E_INIT_INVALID");
    }
  });
});

describe("TestKineticsAnalytic", () => {
  it("prompt jump", async () => {
    const L = await kineticsOnlyLib();
    const M = new Model(L);
    const e = new Engine(L, { power: { mode: "critical-equilibrium", value: 1.0 } });
    const rho = 0.001;
    e.submit({ type: "fault.reactivity", deltaRho: rho });
    e.advance(0.05);
    const expected = M.betaTotal / (M.betaTotal - rho);
    expect(Math.abs(e.y[IP]! / expected - 1.0)).toBeLessThan(3e-3);
  });

  it("stable period matches inhour", async () => {
    const L = await kineticsOnlyLib();
    const e = new Engine(
      L,
      { power: { mode: "critical-equilibrium", value: 1e-3 } },
      1,
      { outerDt: 1.0 },
    );
    const rho = 0.001;
    e.submit({ type: "fault.reactivity", deltaRho: rho });
    e.advance(280.0);
    const p1 = e.y[IP]!;
    e.advance(20.0);
    const omega = Math.log(e.y[IP]! / p1) / 20.0;
    expect(Math.abs(omega / inhourOmega(L, rho) - 1.0)).toBeLessThan(5e-3);
  });

  it("nordheim-fuchs pulse", async () => {
    const [L, K] = await pulseLib(false);
    const M = new Model(L);
    const rhoP = 0.003;
    const e = new Engine(
      L,
      { power: { mode: "critical-equilibrium", value: 1.0 } },
      1,
      { outerDt: 1e-3 },
    );
    e.submit({ type: "fault.reactivity", deltaRho: M.betaTotal + rhoP });
    const times: number[] = [];
    const powers: number[] = [];
    while (e.t < 0.6) {
      e.step();
      times.push(e.t);
      powers.push(e.y[IP]!);
    }
    const pMax = (rhoP * rhoP) / (2 * K * M.genTime);
    expect(Math.abs(e.peakPower / pMax - 1.0)).toBeLessThan(1e-3);

    const half = e.peakPower / 2;
    const crossings: number[] = [];
    for (let i = 0; i < times.length - 1; i++) {
      const t0 = times[i]!;
      const p0 = powers[i]!;
      const t1 = times[i + 1]!;
      const p1 = powers[i + 1]!;
      if ((p0 - half) * (p1 - half) < 0) {
        crossings.push(t0 + ((half - p0) / (p1 - p0)) * (t1 - t0));
      }
    }
    expect(crossings.length).toBe(2);
    expect(
      Math.abs((crossings[1]! - crossings[0]!) / ((3.52 * M.genTime) / rhoP) - 1.0),
    ).toBeLessThan(0.03);

    let kEnd = -1;
    for (let i = 0; i < powers.length; i++) {
      if (times[i]! > e.peakTime && powers[i]! < e.peakPower / 100) {
        kEnd = i;
        break;
      }
    }
    expect(kEnd).toBeGreaterThan(-1);

    const e2 = new Engine(
      L,
      { power: { mode: "critical-equilibrium", value: 1.0 } },
      1,
      { outerDt: 1e-3 },
    );
    e2.submit({ type: "fault.reactivity", deltaRho: M.betaTotal + rhoP });
    e2.advance(times[kEnd]!);
    expect(Math.abs(e2.y[IEP]! / ((2 * rhoP) / K) - 1.0)).toBeLessThan(0.03);
  });

  it("delayed return raises the peak", async () => {
    const [L, K] = await pulseLib(true);
    const M = new Model(L);
    const e = new Engine(
      L,
      { power: { mode: "critical-equilibrium", value: 1.0 } },
      1,
      { outerDt: 1e-3 },
    );
    e.submit({ type: "fault.reactivity", deltaRho: M.betaTotal + 0.003 });
    e.advance(0.4);
    const ratio = e.peakPower / ((0.003 * 0.003) / (2 * K * M.genTime));
    expect(ratio).toBeGreaterThan(1.01);
    expect(ratio).toBeLessThan(1.06);
  });
});

describe("TestPoisonsAndEnergy", () => {
  it("equilibrium poisons have zero derivative", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, {
      power: { mode: "given", value: 1e5 },
      poisons: { mode: "equilibrium" },
    });
    const d = e.rhs(0.0, e.y);
    expect((Math.abs(d[II]!) / e.y[II]!) * 3600).toBeLessThan(1e-9);
    expect((Math.abs(d[IX]!) / e.y[IX]!) * 3600).toBeLessThan(1e-9);
  });

  it("xenon peak after shutdown", async () => {
    const L = await loadSyntheticCore();
    const M = new Model(L);
    const e = new Engine(
      L,
      { power: { mode: "given", value: 1e5 }, poisons: { mode: "equilibrium" } },
      1,
      { outerDt: 60.0, rtol: 1e-4 },
    );
    const I0 = e.y[II]!;
    const X0 = e.y[IX]!;
    const li = M.lambdaI;
    const lx = M.lambdaX;
    const xs: [number, number][] = [];
    for (let i = 0; i < 20 * 60; i++) {
      e.step();
      xs.push([e.t, e.y[IX]!]);
    }
    let k = 1;
    let maxVal = xs[1]![1];
    for (let i = 2; i < xs.length - 1; i++) {
      if (xs[i]![1] > maxVal) {
        maxVal = xs[i]![1];
        k = i;
      }
    }
    const [t0, a] = xs[k - 1]!;
    const [t1, b] = xs[k]!;
    const [, c] = xs[k + 1]!;
    const tPeakSim = t1 + (0.5 * (t1 - t0) * (a - c)) / (a - 2 * b + c);

    const X = (t: number) =>
      X0 * Math.exp(-lx * t) +
      ((li * I0) / (lx - li)) * (Math.exp(-li * t) - Math.exp(-lx * t));

    let lo = 0.0;
    let hi = 40 * 3600.0;
    for (let i = 0; i < 200; i++) {
      const mid = 0.5 * (lo + hi);
      if (X(mid + 1.0) > X(mid - 1.0)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    expect(Math.abs(tPeakSim / (0.5 * (lo + hi)) - 1.0)).toBeLessThan(0.01);
  });

  it("energy balance", async () => {
    const L = await loadSyntheticCore();
    const M = new Model(L);
    const e = new Engine(
      L,
      { rods: nearCriticalRods(L, 0.0), power: { mode: "given", value: 1e5 } },
      1,
      { outerDt: 0.5 },
    );
    const tf0 = e.y[ITF]!;
    const tc0 = e.y[ITC]!;
    e.advance(200.0);
    const stored =
      M.fuelMass * M.fuelCp.integral(tf0, e.y[ITF]!) +
      M.coolMass * M.coolCp * (e.y[ITC]! - tc0);
    expect(e.y[IEP]!).toBeGreaterThan(1e5);
    expect(Math.abs((stored + e.y[IEH]!) / e.y[IEP]! - 1.0)).toBeLessThan(1e-4);
  });
});

describe("TestRulesAndEvents", () => {
  it("interlocks and command results", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, {});
    const s1 = e.submit({ type: "rod.fire", rod: "transient" });
    const s2 = e.submit({ type: "rod.fire", rod: "safety" });
    const s3 = e.submit({ type: "rod.move", rod: "ghost", direction: "out" });
    const s4 = e.submit({ type: "warp" });
    e.step();
    const res: Record<number, any> = {};
    for (const ev of e.events) {
      if (ev.type === "command") {
        res[ev.seq] = ev;
      }
    }
    expect(res[s1].reason).toBe("REJ_INTERLOCK:fire-needs-pulse-mode");
    expect(res[s2].reason).toBe("REJ_NOT_PULSE_CAPABLE");
    expect(res[s3].reason).toBe("REJ_UNKNOWN_ROD");
    expect(res[s4].reason).toBe("REJ_UNKNOWN_COMMAND");
    expect([res[s1].t, res[s2].t]).toEqual([0.0, 0.0]);
  });

  it("pulse by commands and feedback shutdown", async () => {
    const L = await loadSyntheticCore();
    const M = new Model(L);
    const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) });
    e.submit({ type: "mode.set", mode: "pulse" });
    e.step();
    const seq = e.submit({ type: "rod.fire", rod: "transient" });
    e.advance(1.0);
    const fired = e.events.find((ev: any) => ev.seq === seq);
    expect(fired.status).toBe("accepted");
    expect(e.peakPower).toBeGreaterThan(1e7);
    expect(e.y[IP]!).toBeLessThan(e.peakPower / 100);
    expect(e.y[ITF]! - M.refTfuel).toBeGreaterThan(50.0);
  });

  it("scram inserts all rods on the profile", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) });
    e.submit({ type: "scram", reason: "test" });
    e.advance(0.3);
    expect(e.rodPosition("safety", e.t)).toBeCloseTo(0.55, 9);
    e.advance(0.4);
    const posMap: Record<string, number> = {};
    for (const r of Object.keys(e.motions)) {
      posMap[r] = e.rodPosition(r, e.t);
    }
    expect(posMap).toEqual({ safety: 0.0, regulating: 0.0, transient: 0.0 });
    expect(e.latched).toContain("manual");
    const seq = e.submit({ type: "rod.move", rod: "safety", direction: "out" });
    e.step();
    const ev = e.events.find((x: any) => x.seq === seq);
    expect(ev.reason).toBe("REJ_TRIPPED");
  });

  it("truth trip is located inside a step independent of outer dt", async () => {
    const L = await loadSyntheticCore();
    const tripTimes: number[] = [];
    for (const dt of [0.01, 0.007]) {
      const e = new Engine(
        L,
        { rods: nearCriticalRods(L, -0.0005) },
        1,
        { outerDt: dt },
      );
      e.submit({ type: "rod.move", rod: "transient", direction: "out" });
      while (e.latched.length === 0 && e.t < 60) {
        e.step();
      }
      const ev = e.events.find((x: any) => x.type === "trip");
      expect(ev.id).toBe("period-short");
      const steps = ev.t / dt;
      expect(Math.abs(steps - Math.round(steps))).toBeGreaterThan(1e-3);
      tripTimes.push(ev.t);
    }
    expect(Math.abs(tripTimes[0]! - tripTimes[1]!)).toBeLessThan(1e-3);
  });

  it("dead instrument reads none and cannot trip", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, {});
    e.submit({ type: "fault.instrument", instrument: "linear", kind: "dead" });
    e.step();
    e.step();
    expect(e.snapshot().indicated.linear).toBeNull();
  });

  it("validity", async () => {
    const L = await loadSyntheticCore();
    expect(new Engine(L, {}).validity()).toEqual({
      status: "unvalidated",
      reasons: ["R_LIBRARY_SYNTHETIC"],
    });
    const v = new Engine(L, { Tfuel: 1300.0 }).validity();
    expect(v.status).toBe("outOfDomain");
    expect(v.reasons).toContain("R_DOMAIN_TFUEL");
  });

  it("shape is normalized and nonnegative", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, {
      rods: { safety: 1.0, regulating: 0.37, transient: 0.0 },
      Tfuel: 650.0,
    });
    const sh = e.shape();
    const sum = sh.reduce((acc, v) => acc + v, 0.0);
    expect(Math.abs(sum - 1.0)).toBeLessThan(1e-5);
    expect(Math.min(...sh)).toBeGreaterThanOrEqual(0.0);
  });
});

describe("TestDeterminismAndReplay", () => {
  it("same inputs give identical results", async () => {
    const L = await loadSyntheticCore();
    const a = scriptedRun(L, [500]);
    const b = scriptedRun(L, [500]);
    expect(comparable(a.checkpoint())).toEqual(comparable(b.checkpoint()));
  });

  it("splitting advance calls changes nothing", async () => {
    const L = await loadSyntheticCore();
    const a = scriptedRun(L, [500]);
    const b = scriptedRun(L, new Array(500).fill(1));
    expect(comparable(a.checkpoint())).toEqual(comparable(b.checkpoint()));
  });

  it("checkpoint restore matches uninterrupted run", async () => {
    const L = await loadSyntheticCore();
    const full = scriptedRun(L, [500]);
    const part = scriptedRun(L, [213]);
    const cp = JSON.parse(JSON.stringify(part.checkpoint()));
    const resumed = Engine.restore(L, cp);
    const script: Record<number, any[]> = {
      300: [{ type: "fault.instrument", instrument: "log", kind: "stuck" }],
    };
    while (resumed.stepIndex < 500) {
      const cmds = script[resumed.stepIndex];
      if (cmds) {
        for (const cmd of cmds) {
          resumed.submit(cmd, "script");
        }
      }
      resumed.step();
    }
    expect(comparable(resumed.checkpoint())).toEqual(comparable(full.checkpoint()));
  });

  it("session replay matches", async () => {
    const L = await loadSyntheticCore();
    const full = scriptedRun(L, [500]);
    const replayed = Engine.replay(L, JSON.parse(JSON.stringify(full.session())), 500);
    expect(comparable(replayed.checkpoint())).toEqual(comparable(full.checkpoint()));
  });

  it("pins are enforced", async () => {
    const L = await loadSyntheticCore();
    const cp = scriptedRun(L, [10]).checkpoint();
    const kLib = await kineticsOnlyLib();
    expect(() => Engine.restore(kLib, cp)).toThrow(CheckpointError);
    cp.pins.engineVersion = "9.9.9";
    expect(() => Engine.restore(L, cp)).toThrow(CheckpointError);
  });
});

// Added by the dispatcher (Claude) after verification: the A6-1 brief asked for round-half-even in advance()
// but gave no test for it, so a Math.round port passed every check. Expected values are Python's round().
describe("advance() rounds half steps to even, like Python's round()", () => {
  it("roundHalfEven matches Python", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2]);
    expect(roundHalfEven(0.045 / 0.01)).toBe(4); // 4.5 exactly; Math.round gives 5
  });

  it("advance() takes Python's number of steps at exact half steps", async () => {
    const L = await loadSyntheticCore();
    for (const [seconds, steps] of [[0.005, 0], [0.015, 2], [0.025, 2], [0.035, 4], [0.045, 4]] as const) {
      const e = new Engine(L, {});
      e.advance(seconds);
      expect(e.stepIndex, `advance(${seconds})`).toBe(steps);
    }
  });
});

describe("TestM1ReviewRegressions", () => {
  it("test_1_drive_commands_cannot_cancel_a_scram", async () => {
    for (const delay of [0, 5]) { // queued with the scram, and during insertion
      const L = await loadSyntheticCore();
      const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) });
      e.submit({ type: "scram" });
      for (let i = 0; i < delay; i++) {
        e.step();
      }
      const seq = e.submit({ type: "rod.move", rod: "safety", direction: "in" });
      e.advance(0.6);
      const ev = e.events.find((x: any) => x.seq === seq);
      expect(ev?.reason).toBe("REJ_SCRAM_IN_PROGRESS");
      expect(e.rodPosition("safety", e.t)).toBe(0.0);
    }
  });

  it("test_2_trip_window_crossed_inside_one_step_is_found", async () => {
    const times: number[] = [];
    for (const dt of [0.01, 0.001]) {
      const L = await loadSyntheticCore();
      L.plant.trips = [
        ...L.plant.trips,
        {
          id: "window",
          input: "truth.rod.transient",
          predicate: { op: "between", value: [0.00008, 0.0001] },
          latching: true,
        },
      ];
      const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) }, 1, { outerDt: dt });
      e.submit({ type: "rod.move", rod: "transient", direction: "out" }); // 0.02/s: inside the window at 4-5 ms
      e.advance(0.02);
      const ev = e.events.filter((x: any) => x.type === "trip" && x.id === "window");
      expect(ev.length).toBe(1);
      times.push(ev[0]!.t);
    }
    for (const t of times) {
      expect(Math.abs(t - 0.004)).toBeLessThan(1e-6);
    }
  });

  it("test_3_replay_of_a_halted_run_returns", async () => {
    const L = await loadSyntheticCore();
    L.feedback.fuelTemp.outOfRange = "reject";
    const e = new Engine(L, { Tfuel: 1300.0 });
    expect(e.halted).toBeTruthy();
    let stepCount = 0;
    const origStep = Engine.prototype.step;
    try {
      Engine.prototype.step = function (this: Engine) {
        stepCount++;
        if (stepCount > 1000) {
          throw new Error("iteration guard: step() called > 1000 times on halted engine replay");
        }
        return origStep.apply(this);
      };
      const r = Engine.replay(L, e.session(), 1); // used to loop forever
      expect(r.halted).toBe(e.halted);
      expect(r.stepIndex).toBe(0);
    } finally {
      Engine.prototype.step = origStep;
    }
  });

  it("test_4_heat_capacity_reject_policy_is_enforced", async () => {
    const L = await loadSyntheticCore();
    L.thermal.fuelCp = { x: [293.15, 300.0], y: [300.0, 300.0], outOfRange: "reject" };
    const e = new Engine(L, { Tfuel: 350.0 });
    expect(e.halted).toBe("R_TABLE_REJECT_fuelCp");
  });

  it("test_5_replay_keeps_commands_pending_at_the_final_boundary", async () => {
    const L = await loadSyntheticCore();
    const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) });
    e.step();
    e.submit({ type: "pump.set", pump: L.plant.pumps[0]!, on: false });
    const r = Engine.replay(L, JSON.parse(JSON.stringify(e.session())), e.stepIndex);
    expect([r.pending.length, r.nextSeq]).toEqual([e.pending.length, e.nextSeq]);
    e.step();
    r.step();
    expect(comparable(r.checkpoint())).toEqual(comparable(e.checkpoint()));
  });

  it("test_7_integral_float_array_fields_load", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "m1-test7-"));
    try {
      const dst = join(tmp, "core");
      cpSync(syntheticCorePath, dst, { recursive: true });
      const m = JSON.parse(readFileSync(join(dst, "manifest.json"), "utf-8"));
      for (const d of Object.values<any>(m.arrays)) {
        d.offset = `${d.offset}.0`;
        d.byteLength = `${d.byteLength}.0`;
        d.shape = d.shape.map((n: number) => `${n}.0`);
      }
      let text = JSON.stringify(m, null, 1);
      text = text.replace(/"(\d+\.0)"/g, "$1");
      writeFileSync(join(dst, "manifest.json"), text, "utf-8");
      const reader = nodeReader(dst);
      expect(await validateLibrary(reader)).toEqual([]);
      const loaded = await loadParams(reader);
      const baseLib = await loadSyntheticCore();
      expect(loaded.shape!.base).toEqual(baseLib.shape!.base);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
