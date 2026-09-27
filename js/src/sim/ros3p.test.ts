import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Engine,
  IP,
  ITF,
  IX,
  InitError,
  ros3pCoeffs,
} from "./engine";
import { Model } from "./params";
import {
  comparable,
  engineVectorsDir,
  inhourOmega,
  kineticsOnlyLib,
  loadSyntheticCore,
  pulseLib,
  scriptedRun,
  scriptedRunRos3p,
} from "./testing";
import { runScenario } from "./vectors";

async function fixedStepIntegration(methodName: "ros2" | "ros3p", h: number): Promise<number> {
  const L = await kineticsOnlyLib();
  const e = new Engine(
    L,
    { power: { mode: "critical-equilibrium", value: 1.0 } },
    1,
    { method: methodName },
  );
  e.extraRho = 0.002;
  let y = [...e.y];
  let t = 0.0;
  const nSteps = Math.round(0.2 / h);
  const stepper = methodName === "ros2" ? e._ros2.bind(e) : e._ros3p.bind(e);
  for (let i = 0; i < nSteps; i++) {
    const f0 = e.rhs(t, y);
    const [J, ft] = e._jacobian(t, y, f0);
    [y] = stepper(t, y, h, J, f0, ft);
    t += h;
  }
  return y[IP]!;
}

async function runTimeDependentAccuracy(): Promise<number> {
  const L = await kineticsOnlyLib();
  const M = new Model(L);
  L.reference.calibration = -(M.refRho + M.rodById.regulating!.worth.at(0.4));
  const e = new Engine(
    L,
    {
      rods: { safety: 0.0, regulating: 0.4, transient: 0.0 },
      power: { mode: "critical-equilibrium", value: 1.0 },
    },
    1,
    { method: "ros3p" },
  );
  e.motions.regulating = { kind: "move", t0: 0.0, x0: 0.4, v: 0.5 };
  let t = 0.0;
  let y = [...e.y];
  const h = 0.0025;
  const nSteps = Math.round(0.2 / h);
  for (let i = 0; i < nSteps; i++) {
    const f0 = e.rhs(t, y);
    const [J, ft] = e._jacobian(t, y, f0);
    [y] = e._ros3p(t, y, h, J, f0, ft);
    t += h;
  }
  return Math.abs(y[IP]! / 1.61402354941325 - 1.0);
}

describe("TestROS3P", () => {
  it("unknown method rejected", async () => {
    const L = await loadSyntheticCore();
    let err: any;
    try {
      new Engine(L, {}, 1, { method: "rk4" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InitError);
    expect(err.code).toBe("E_INIT_INVALID");
  });

  it("observed order", async () => {
    // Study order for ROS3P
    const p02_ros3p = await fixedStepIntegration("ros3p", 0.02);
    const p01_ros3p = await fixedStepIntegration("ros3p", 0.01);
    const p005_ros3p = await fixedStepIntegration("ros3p", 0.005);
    const p0025_ros3p = await fixedStepIntegration("ros3p", 0.0025);

    const p1_ros3p = Math.log2(
      Math.abs(p02_ros3p - p01_ros3p) / Math.abs(p01_ros3p - p005_ros3p),
    );
    const p2_ros3p = Math.log2(
      Math.abs(p01_ros3p - p005_ros3p) / Math.abs(p005_ros3p - p0025_ros3p),
    );

    expect(p1_ros3p).toBeGreaterThanOrEqual(2.7);
    expect(p1_ros3p).toBeLessThanOrEqual(3.3);
    expect(p2_ros3p).toBeGreaterThanOrEqual(2.7);
    expect(p2_ros3p).toBeLessThanOrEqual(3.3);

    // Study order for ROS2
    const p02_ros2 = await fixedStepIntegration("ros2", 0.02);
    const p01_ros2 = await fixedStepIntegration("ros2", 0.01);
    const p005_ros2 = await fixedStepIntegration("ros2", 0.005);
    const p0025_ros2 = await fixedStepIntegration("ros2", 0.0025);

    const p1_ros2 = Math.log2(
      Math.abs(p02_ros2 - p01_ros2) / Math.abs(p01_ros2 - p005_ros2),
    );
    const p2_ros2 = Math.log2(
      Math.abs(p01_ros2 - p005_ros2) / Math.abs(p005_ros2 - p0025_ros2),
    );

    expect(p1_ros2).toBeGreaterThanOrEqual(1.7);
    expect(p1_ros2).toBeLessThanOrEqual(2.3);
    expect(p2_ros2).toBeGreaterThanOrEqual(1.7);
    expect(p2_ros2).toBeLessThanOrEqual(2.3);
  });

  it("wrong coefficient breaks order", async () => {
    const origC32 = ros3pCoeffs.c32;
    try {
      ros3pCoeffs.c32 = origC32 * 1.01;
      const p01 = await fixedStepIntegration("ros3p", 0.01);
      const p005 = await fixedStepIntegration("ros3p", 0.005);
      const p0025 = await fixedStepIntegration("ros3p", 0.0025);
      const p = Math.log2(Math.abs(p01 - p005) / Math.abs(p005 - p0025));
      expect(p).toBeLessThan(2.0);
    } finally {
      ros3pCoeffs.c32 = origC32;
    }
  });

  it("analytic checks with ros3p", async () => {
    // 1. source equilibrium matches formula and holds
    const L = await loadSyntheticCore();
    const M = new Model(L);
    const e = new Engine(L, {}, 1, { method: "ros3p" });
    const rho = e.reactivity(0.0, e.y).total;
    expect(Math.abs(e.y[IP]! - (-M.extSource * M.genTime) / rho)).toBeLessThanOrEqual(1e-15);
    const p0 = e.y[IP]!;
    e.advance(20.0);
    expect(Math.abs(e.y[IP]! / p0 - 1.0)).toBeLessThan(1e-8);

    // 2. prompt jump
    const kLib = await kineticsOnlyLib();
    const kM = new Model(kLib);
    const eJump = new Engine(
      kLib,
      { power: { mode: "critical-equilibrium", value: 1.0 } },
      1,
      { method: "ros3p" },
    );
    const rhoJump = 0.001;
    eJump.submit({ type: "fault.reactivity", deltaRho: rhoJump });
    eJump.advance(0.05);
    const expected = kM.betaTotal / (kM.betaTotal - rhoJump);
    expect(Math.abs(eJump.y[IP]! / expected - 1.0)).toBeLessThan(3e-3);

    // 3. stable period matches inhour
    const ePeriod = new Engine(
      kLib,
      { power: { mode: "critical-equilibrium", value: 1e-3 } },
      1,
      { method: "ros3p", outerDt: 1.0 },
    );
    ePeriod.submit({ type: "fault.reactivity", deltaRho: rhoJump });
    ePeriod.advance(280.0);
    const p1 = ePeriod.y[IP]!;
    ePeriod.advance(20.0);
    const omega = Math.log(ePeriod.y[IP]! / p1) / 20.0;
    expect(Math.abs(omega / inhourOmega(kLib, rhoJump) - 1.0)).toBeLessThan(5e-3);

    // 4. Nordheim-Fuchs peak check
    const [pL, K] = await pulseLib(false);
    const pM = new Model(pL);
    const rhoP = 0.003;
    const ePulse = new Engine(
      pL,
      { power: { mode: "critical-equilibrium", value: 1.0 } },
      1,
      { method: "ros3p", outerDt: 1e-3 },
    );
    ePulse.submit({ type: "fault.reactivity", deltaRho: pM.betaTotal + rhoP });
    while (ePulse.t < 0.6) {
      ePulse.step();
    }
    const pMax = (rhoP * rhoP) / (2 * K * pM.genTime);
    expect(Math.abs(ePulse.peakPower / pMax - 1.0)).toBeLessThan(1e-3);
  });

  it("ros3p takes fewer steps", async () => {
    const L = await loadSyntheticCore();
    const init = { power: { mode: "given", value: 1e5 }, poisons: { mode: "equilibrium" } };
    const eRos2 = new Engine(L, init, 1, { outerDt: 60.0 });
    const eRos3p = new Engine(L, init, 1, { method: "ros3p", outerDt: 60.0 });
    eRos2.advance(3600.0);
    eRos3p.advance(3600.0);

    expect(eRos3p.diag.steps).toBeLessThan(0.5 * eRos2.diag.steps);
    const relDiff = Math.abs(eRos3p.y[IX]! - eRos2.y[IX]!) / eRos2.y[IX]!;
    expect(relDiff).toBeLessThan(1e-6);
  });

  it("determinism and checkpoint with ros3p", async () => {
    const L = await loadSyntheticCore();
    const a = scriptedRunRos3p(L, [500]);
    const b = scriptedRunRos3p(L, [500]);
    expect(comparable(a.checkpoint())).toEqual(comparable(b.checkpoint()));

    const part = scriptedRunRos3p(L, [213]);
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
    expect(comparable(resumed.checkpoint())).toEqual(comparable(a.checkpoint()));
  });

  it("pins always name the method", async () => {
    const L = await loadSyntheticCore();
    expect(scriptedRun(L, [3]).pins().config.method).toBe("ros2");
    expect(scriptedRunRos3p(L, [3]).pins().config.method).toBe("ros3p");
    const cp = JSON.parse(JSON.stringify(scriptedRun(L, [3]).checkpoint()));
    delete cp.pins.config.method;
    expect(Engine.restore(L, cp).config.method).toBe("ros2");
  });

  it("time dependent accuracy", async () => {
    const err = await runTimeDependentAccuracy();
    expect(err).toBeLessThan(2e-6);
  });

  it("time dependent accuracy catches wrong gamma", async () => {
    const origGamma2 = ros3pCoeffs.gamma2;
    try {
      ros3pCoeffs.gamma2 = 0.0;
      const err = await runTimeDependentAccuracy();
      expect(err).toBeGreaterThanOrEqual(2e-6);
    } finally {
      ros3pCoeffs.gamma2 = origGamma2;
    }

    const origGamma3 = ros3pCoeffs.gamma3;
    try {
      ros3pCoeffs.gamma3 = 0.0;
      const err = await runTimeDependentAccuracy();
      expect(err).toBeGreaterThanOrEqual(2e-6);
    } finally {
      ros3pCoeffs.gamma3 = origGamma3;
    }
  });

  it("ros2 unchanged", async () => {
    const L = await loadSyntheticCore();
    const e = scriptedRun(L, [500]);
    expect(String(e.y[0])).toBe("0.040326259713735685");
    expect(String(e.y[7])).toBe("293.15001301044094");
  });

  it("matches ROS3P reference table for all 6 scenarios", async () => {
    const L = await loadSyntheticCore();

    const referenceTable: Record<
      string,
      {
        peakPower: number;
        peakTime: number;
        lastSamplePower: number;
        lastSampleFuelTemp: number;
        events: number;
      }
    > = {
      "source-level": {
        peakPower: 0.0006153846153846155,
        peakTime: 1e-5,
        lastSamplePower: 0.0006153846153169616,
        lastSampleFuelTemp: 293.1500000462467,
        events: 0,
      },
      "rod-withdrawal": {
        peakPower: 0.040617196272151636,
        peakTime: 5.0,
        lastSamplePower: 0.040617196272151636,
        lastSampleFuelTemp: 293.15001305803213,
        events: 2,
      },
      pulse: {
        peakPower: 181785448.21701133,
        peakTime: 0.13882139744706026,
        lastSamplePower: 704034.9902932697,
        lastSampleFuelTemp: 507.92124948095295,
        events: 1,
      },
      scram: {
        peakPower: 0.04030387249234734,
        peakTime: 2.0,
        lastSamplePower: 0.005420646749790499,
        lastSampleFuelTemp: 293.15000617065255,
        events: 4,
      },
      rejections: {
        peakPower: 0.0006153846153846155,
        peakTime: 1e-5,
        lastSamplePower: 0.0006153846153709796,
        lastSampleFuelTemp: 293.15000000954063,
        events: 5,
      },
      "period-trip": {
        peakPower: 0.1473277345149852,
        peakTime: 16.953658447265624,
        lastSamplePower: 0.0032210485438220124,
        lastSampleFuelTemp: 293.1500208297418,
        events: 2,
      },
    };

    for (const [name, expected] of Object.entries(referenceTable)) {
      const file = join(engineVectorsDir, `${name}.json`);
      const committed = JSON.parse(readFileSync(file, "utf-8"));
      const sc = {
        name: committed.name,
        description: committed.description,
        init: committed.init,
        seed: committed.seed,
        config: { ...committed.config, method: "ros3p" },
        steps: committed.steps,
        sampleEvery: committed.sampleEvery,
        script: committed.script,
      };

      const doc = runScenario(L, sc);
      const final = doc.final;
      const lastSample = doc.samples[doc.samples.length - 1];

      // Compare powers and temperatures within 1e-9 relative
      expect(
        Math.abs(final.peakPower / expected.peakPower - 1.0),
        `${name} peakPower`,
      ).toBeLessThan(1e-9);
      expect(
        Math.abs(lastSample.power / expected.lastSamplePower - 1.0),
        `${name} lastSample power`,
      ).toBeLessThan(1e-9);
      expect(
        Math.abs(lastSample.fuelTemp / expected.lastSampleFuelTemp - 1.0),
        `${name} lastSample fuelTemp`,
      ).toBeLessThan(1e-9);

      // Times within 1e-9 absolute
      expect(
        Math.abs(final.peakTime - expected.peakTime),
        `${name} peakTime`,
      ).toBeLessThan(1e-9);

      // Event counts exactly
      expect(doc.events.length, `${name} events count`).toBe(expected.events);
    }
  });
});
