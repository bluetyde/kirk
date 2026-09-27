/**
 * Shared test helpers for simulation tests.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeReader } from "../library/node-reader";
import { Engine } from "./engine";
import { Table, loadLibrary, type Library } from "./library";
import { nearCriticalRods } from "./vectors";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const syntheticCorePath = join(repoRoot, "schema", "vectors", "synthetic-core");
export const engineVectorsDir = join(repoRoot, "schema", "engine-vectors");

export async function loadSyntheticCore(): Promise<Library> {
  return await loadLibrary(nodeReader(syntheticCorePath));
}

export async function kineticsOnlyLib(): Promise<Library> {
  const L = await loadSyntheticCore();
  L.extSource = 0.0;
  L.calibration = -L.refRho;
  const flat = new Table([0.0, 5000.0], [0.0, 0.0]);
  L.fuelTemp = flat;
  L.coolTemp = flat;
  L.xenon = new Table([0.0, 1e30], [0.0, 0.0]);
  await L.markModified("kinetics-only");
  return L;
}

export function inhourOmega(L: Library, rho: number): number {
  const f = (w: number) => {
    let sum = 0.0;
    for (let i = 0; i < L.beta.length; i++) {
      sum += (L.beta[i]! * w) / (w + L.lam[i]!);
    }
    return w * L.genTime + sum - rho;
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

export async function pulseLib(delayedReturn: boolean): Promise<[Library, number]> {
  const L = await kineticsOnlyLib();
  const alpha = -1e-4;
  const c = 320.0;
  const Tref = L.refTfuel;
  L.fuelTemp = new Table([0.0, 3000.0], [alpha * (0.0 - Tref), alpha * (3000.0 - Tref)]);
  L.fuelCp = new Table([0.0, 3000.0], [c, c]);
  L.hA = 0.0;
  if (!delayedReturn) {
    L.lam = [1e-12, 1e-12, 1e-12, 1e-12, 1e-12, 1e-12];
  }
  await L.markModified(`nordheim-fuchs-${delayedReturn}`);
  return [L, Math.abs(alpha) / (L.fuelMass * c)];
}

export function comparable(cp: Record<string, any>): Record<string, any> {
  const copy = { ...cp };
  delete copy.eventCount;
  return copy;
}

export function scriptedRun(L: Library, chunks: number[]): Engine {
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

export function scriptedRunRos3p(L: Library, chunks: number[]): Engine {
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
