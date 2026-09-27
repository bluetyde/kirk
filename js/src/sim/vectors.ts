/**
 * Deterministic golden-vector runner and sampler for the reference physics engine.
 *
 * Ported from kirk/vectors.py.
 */

import { Engine } from "./engine";
import { Library } from "./library";

export const TOLERANCES = {
  power: { rel: 1e-9, abs: 1e-15 },
  temperature: { rel: 1e-9, abs: 1e-9 },
  poisons: { rel: 1e-9, abs: 1.0 },
  eventTime: { abs: 1e-9 },
};

export function nearCriticalRods(lib: Library, targetRho: number): Record<string, number> {
  const base = lib.refRho + lib.rodById.safety!.worth.at(1.0);
  const reg = lib.rodById.regulating!.worth;
  let lo = 0.0;
  let hi = 1.0;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (base + reg.at(mid) < targetRho) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { safety: 1.0, regulating: 0.5 * (lo + hi), transient: 0.0 };
}

export function sampleFromEngine(e: Engine): Record<string, any> {
  const snap = e.snapshot();
  const truth = snap.truth;
  const rods: Record<string, number> = {};
  for (const [rid, r] of Object.entries<any>(truth.rods)) {
    rods[rid] = r.position;
  }
  return {
    step: e.stepIndex,
    t: snap.t,
    power: truth.power,
    precursors: [...truth.precursors],
    fuelTemp: truth.fuelTemp,
    coolantTemp: truth.coolantTemp,
    iodine: truth.iodine,
    xenon: truth.xenon,
    energy: truth.energy,
    reactivityTotal: truth.reactivity.total,
    rods,
    mode: truth.mode,
    indicated: { ...snap.indicated },
    tripped: snap.tripped,
    latched: [...snap.trips.latched],
    validityStatus: snap.validity.status,
  };
}

export function runScenario(
  lib: Library,
  sc: Record<string, any>,
  onStep?: (e: Engine) => void,
): Record<string, any> {
  const e = new Engine(lib, sc.init, sc.seed, sc.config);
  const sampleEvery = sc.sampleEvery;
  const totalSteps = sc.steps;

  const scriptByStep = new Map<number, any[]>();
  for (const item of sc.script) {
    if (!scriptByStep.has(item.step)) {
      scriptByStep.set(item.step, []);
    }
    scriptByStep.get(item.step)!.push(item.cmd);
  }

  const samples = [sampleFromEngine(e)];
  const sampledSteps = new Set<number>([0]);

  for (let k = 0; k < totalSteps; k++) {
    const cmds = scriptByStep.get(k);
    if (cmds) {
      for (const cmd of cmds) {
        e.submit(cmd);
      }
    }
    e.step();
    if (onStep) {
      onStep(e);
    }
    if (e.stepIndex % sampleEvery === 0 || e.stepIndex === totalSteps) {
      if (!sampledSteps.has(e.stepIndex)) {
        samples.push(sampleFromEngine(e));
        sampledSteps.add(e.stepIndex);
      }
    }
  }

  return {
    vectorFormat: 1,
    name: sc.name,
    description: sc.description,
    init: structuredClone(sc.init),
    seed: sc.seed,
    config: structuredClone(sc.config),
    steps: sc.steps,
    sampleEvery: sc.sampleEvery,
    script: structuredClone(sc.script),
    libraryId: lib.id,
    pins: e.pins(),
    samples,
    events: structuredClone(e.events),
    final: {
      peakPower: e.peakPower,
      peakTime: e.peakTime,
    },
    tolerances: structuredClone(TOLERANCES),
  };
}
