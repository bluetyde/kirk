/**
 * Shared test helpers for simulation tests.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadParams } from "../library/adapter";
import { nodeReader } from "../library/node-reader";
import { Engine } from "./engine";
import { Model, type ReactorParams } from "./params";
import { nearCriticalRods } from "./vectors";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const syntheticCorePath = join(repoRoot, "schema", "vectors", "synthetic-core");
export const engineVectorsDir = join(repoRoot, "schema", "engine-vectors");

let fixture: ReactorParams | null = null;

/** Synthetic-core params: a fresh copy each call, so a test can change it freely. */
export async function loadSyntheticCore(): Promise<ReactorParams> {
  fixture ??= await loadParams(nodeReader(syntheticCorePath));
  return structuredClone(fixture);
}

/**
 * Synthetic core with no source, no feedback, and a calibration that makes the reference state critical.
 * The params digest follows the content, so these runs can't pass as the real fixture.
 */
export async function kineticsOnlyLib(): Promise<ReactorParams> {
  const L = await loadSyntheticCore();
  L.kinetics.extSource = 0.0;
  L.reference.calibration = -L.reference.rho;
  L.feedback.fuelTemp = { x: [0.0, 5000.0], y: [0.0, 0.0] };
  L.feedback.coolantTemp = { x: [0.0, 5000.0], y: [0.0, 0.0] };
  L.feedback.xenon = { x: [0.0, 1e30], y: [0.0, 0.0] };
  return L;
}

export function inhourOmega(L: ReactorParams, rho: number): number {
  const M = new Model(L);
  const f = (w: number) => {
    let sum = 0.0;
    for (let i = 0; i < M.beta.length; i++) {
      sum += (M.beta[i]! * w) / (w + M.lam[i]!);
    }
    return w * M.genTime + sum - rho;
  };
  let lo = 1e-12;
  let hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) < 0) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return 0.5 * (lo + hi);
}

export async function pulseLib(delayedReturn: boolean): Promise<[ReactorParams, number]> {
  const L = await kineticsOnlyLib();
  const alpha = -1e-4;
  const c = 320.0;
  const Tref = L.reference.Tfuel;
  L.feedback.fuelTemp = { x: [0.0, 3000.0], y: [alpha * (0.0 - Tref), alpha * (3000.0 - Tref)] };
  L.thermal.fuelCp = { x: [0.0, 3000.0], y: [c, c] };
  L.thermal.hA = 0.0;
  if (!delayedReturn) {
    L.kinetics.lambda = [1e-12, 1e-12, 1e-12, 1e-12, 1e-12, 1e-12];
  }
  return [L, Math.abs(alpha) / (L.thermal.fuelMass * c)];
}

export function comparable(cp: Record<string, any>): Record<string, any> {
  const copy = { ...cp };
  delete copy.eventCount;
  return copy;
}

export function scriptedRun(L: ReactorParams, chunks: number[]): Engine {
  const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) }, 42);
  const script: Record<number, any[]> = {
    0: [{ type: "rod.move", rod: "transient", direction: "out" }],
    150: [{ type: "rod.move", rod: "transient", direction: "stop" }],
    300: [{ type: "fault.instrument", instrument: "log", kind: "stuck" }],
  };
  for (const n of chunks) {
    for (let i = 0; i < n; i++) {
      const cmds = script[e.stepIndex];
      if (cmds) {
        for (const cmd of cmds) {
          e.submit(cmd, "script");
        }
      }
      e.step();
    }
  }
  return e;
}

export function scriptedRunRos3p(L: ReactorParams, chunks: number[]): Engine {
  const e = new Engine(L, { rods: nearCriticalRods(L, -0.0005) }, 42, { method: "ros3p" });
  const script: Record<number, any[]> = {
    0: [{ type: "rod.move", rod: "transient", direction: "out" }],
    150: [{ type: "rod.move", rod: "transient", direction: "stop" }],
    300: [{ type: "fault.instrument", instrument: "log", kind: "stuck" }],
  };
  for (const n of chunks) {
    for (let i = 0; i < n; i++) {
      const cmds = script[e.stepIndex];
      if (cmds) {
        for (const cmd of cmds) {
          e.submit(cmd, "script");
        }
      }
      e.step();
    }
  }
  return e;
}
