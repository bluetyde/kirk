/**
 * Load a validated reactor library into plain TypeScript objects for the engine.
 *
 * Ported line for line from kirk/library.py.
 */

import type { LibraryReader } from "../library/platform";
import { sha256Hex } from "../library/platform";
import type { Issue } from "../library/validate";
import { validateLibrary } from "../library/validate";

export class LibraryError extends Error {
  issues: Issue[];

  constructor(issues: Issue[]) {
    const summary = issues.slice(0, 5).map((i) => `${i.code} ${i.path}`).join("; ");
    super(summary);
    this.name = "LibraryError";
    this.issues = issues;
  }
}

function bisectRight(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]!) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

export type OutOfRangeFlag = "below" | "above" | null;

export class Table {
  xs: number[];
  ys: number[];
  outOfRange: string;

  constructor(xs: number[], ys: number[], outOfRange = "clamp-and-flag") {
    if (xs.length !== ys.length || xs.length < 2) {
      throw new Error("table needs two equal-length columns of at least 2 points");
    }
    this.xs = [...xs];
    this.ys = [...ys];
    this.outOfRange = outOfRange;
  }

  value(x: number): [number, OutOfRangeFlag] {
    const xs = this.xs;
    const ys = this.ys;
    if (x < xs[0]!) {
      if (this.outOfRange === "extrapolate-and-flag") {
        return [ys[0]! + ((x - xs[0]!) * (ys[1]! - ys[0]!)) / (xs[1]! - xs[0]!), "below"];
      }
      return [ys[0]!, "below"];
    }
    if (x > xs[xs.length - 1]!) {
      if (this.outOfRange === "extrapolate-and-flag") {
        return [
          ys[ys.length - 1]! +
            ((x - xs[xs.length - 1]!) * (ys[ys.length - 1]! - ys[ys.length - 2]!)) /
              (xs[xs.length - 1]! - xs[xs.length - 2]!),
          "above",
        ];
      }
      return [ys[ys.length - 1]!, "above"];
    }
    const i = Math.min(bisectRight(xs, x) - 1, xs.length - 2);
    const t = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
    return [ys[i]! + t * (ys[i + 1]! - ys[i]!), null];
  }

  at(x: number): number {
    return this.value(x)[0];
  }

  integral(a: number, b: number): number {
    if (b < a) {
      return -this.integral(b, a);
    }
    const pts = [a, ...this.xs.filter((x) => a < x && x < b), b];
    let total = 0.0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i]!;
      const q = pts[i + 1]!;
      total += 0.5 * (this.at(p) + this.at(q)) * (q - p);
    }
    return total;
  }
}

export class Rod {
  id: string;
  name: string;
  travelCm: number;
  speed: number;
  pulseCapable: boolean;
  fireTime?: number;
  worth: Table;
  scramT: number[];
  scramX: number[];
  _scramTable: Table;

  constructor(d: any) {
    this.id = d.id;
    this.name = d.name;
    this.travelCm = d.travelCm;
    this.speed = d.speed;
    this.pulseCapable = d.pulseCapable;
    this.fireTime = d.fireTime;
    const w = d.worth;
    this.worth = new Table(w.x, w.rho, w.outOfRange);
    this.scramT = [...d.scram.t];
    this.scramX = [...d.scram.x];
    this._scramTable = new Table(this.scramT, this.scramX);
  }

  scramPosition(tau: number): number {
    return this._scramTable.at(tau);
  }

  scramTau(x: number): number {
    const ts = this.scramT;
    const xs = this.scramX;
    if (x >= xs[0]!) {
      return 0.0;
    }
    for (let i = 0; i < xs.length - 1; i++) {
      if (xs[i]! >= x && x >= xs[i + 1]!) {
        if (xs[i]! === xs[i + 1]!) {
          return ts[i]!;
        }
        return ts[i]! + ((xs[i]! - x) / (xs[i]! - xs[i + 1]!)) * (ts[i + 1]! - ts[i]!);
      }
    }
    return ts[ts.length - 1]!;
  }
}

export class Library {
  manifest: any;
  id: string;
  status: string;
  digest: string;

  refRods: Record<string, number>;
  refTfuel: number;
  refTcool: number;
  refXenon: number;
  refRho: number;
  calibration: number;

  beta: number[];
  lam: number[];
  betaTotal: number;
  genTime: number;
  extSource: number;

  rods: Rod[];
  rodById: Record<string, Rod>;
  fuelTemp: Table;
  coolTemp: Table;
  xenon: Table;

  fuelMass: number;
  fuelCp: Table;
  coolMass: number;
  coolCp: number;
  hA: number;
  UA: number;
  sinkTemp: number;
  hxPump: string;
  fuelFraction: number;

  fluxPerWatt: number;
  sigmaF: number;
  gammaI: number;
  gammaX: number;
  lambdaI: number;
  lambdaX: number;
  sigmaX: number;

  modes: string[];
  initialMode: string;
  pumps: string[];
  instruments: any[];
  trips: any[];
  interlocks: any[];

  domain: any;
  shapes: any;
  arrays: Record<string, number[]>;

  constructor(m: any, digest: string, arrays: Record<string, number[]>) {
    this.manifest = m;
    this.id = m.id;
    this.status = m.status;
    this.digest = digest;

    const ref = m.reference;
    this.refRods = { ...ref.rods };
    this.refTfuel = ref.Tfuel.value;
    this.refTcool = ref.Tcoolant.value;
    this.refXenon = ref.xenon.value;
    this.refRho = ref.rho.value;
    this.calibration = ref.calibration ? ref.calibration.deltaRho : 0.0;

    const k = m.kinetics;
    this.beta = [...k.beta.values];
    this.lam = [...k.lambda.values];
    this.betaTotal = 0.0;
    for (const b of this.beta) {
      this.betaTotal += b;
    }
    this.genTime = k.genTime.value;
    this.extSource = k.extSource.value;

    const r = m.reactivity;
    this.rods = r.rods.map((d: any) => new Rod(d));
    this.rodById = {};
    for (const rod of this.rods) {
      this.rodById[rod.id] = rod;
    }
    this.fuelTemp = new Table(r.fuelTemp.T, r.fuelTemp.rho, r.fuelTemp.outOfRange);
    this.coolTemp = new Table(r.coolantTemp.T, r.coolantTemp.rho, r.coolantTemp.outOfRange);
    this.xenon = new Table(r.xenon.N, r.xenon.rho, r.xenon.outOfRange);

    const t = m.thermal;
    this.fuelMass = t.fuel.mass.value;
    this.fuelCp = new Table(t.fuel.cp.T, t.fuel.cp.c, t.fuel.cp.outOfRange);
    this.coolMass = t.coolant.mass.value;
    this.coolCp = t.coolant.cp.value;
    this.hA = t.hA.value;
    this.UA = t.heatExchanger.UA.value;
    this.sinkTemp = t.heatExchanger.sinkTemp.value;
    this.hxPump = t.heatExchanger.pump;
    this.fuelFraction = t.deposition.fuelFraction.value;

    const p = m.poisons;
    this.fluxPerWatt = p.fluxPerWatt.value;
    this.sigmaF = p.sigmaF.value;
    this.gammaI = p.gammaI.value;
    this.gammaX = p.gammaXe.value;
    this.lambdaI = p.lambdaI.value;
    this.lambdaX = p.lambdaXe.value;
    this.sigmaX = p.sigmaXe.value;

    const pl = m.plant;
    this.modes = [...pl.modes];
    this.initialMode = pl.initialMode;
    this.pumps = pl.pumps.map((x: any) => x.id);
    this.instruments = pl.instruments.map((i: any) => ({ ...i }));
    this.trips = pl.trips.map((tr: any) => ({ ...tr }));
    this.interlocks = pl.interlocks.map((i: any) => ({ ...i }));

    this.domain = m.domain;
    this.shapes = m.shapes;
    this.arrays = arrays;
  }

  async markModified(note: string): Promise<void> {
    const data = new TextEncoder().encode(this.digest + "|modified:" + note);
    this.digest = await sha256Hex(data);
  }
}

export async function loadLibrary(reader: LibraryReader): Promise<Library> {
  const issues = await validateLibrary(reader);
  if (issues.length > 0) {
    throw new LibraryError(issues);
  }
  const manifestRaw = await reader.read("manifest.json");
  if (manifestRaw === null) {
    throw new Error("manifest.json not found");
  }
  const manifestText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestRaw);
  const m = JSON.parse(manifestText);

  // Compute digest: SHA-256 over manifest bytes followed by UTF-8 bytes of each array's sha256 in sorted name order
  const arrayNames = Object.keys(m.arrays).sort();
  const textEncoder = new TextEncoder();
  const chunks: Uint8Array[] = [manifestRaw];
  for (const name of arrayNames) {
    chunks.push(textEncoder.encode(m.arrays[name].sha256));
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const concat = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    concat.set(c, offset);
    offset += c.length;
  }
  const digest = await sha256Hex(concat);

  // Load arrays
  const arrays: Record<string, number[]> = {};
  for (const [name, d] of Object.entries<any>(m.arrays)) {
    const data = await reader.read(d.file);
    if (data === null) {
      throw new Error(`Array file ${d.file} not found`);
    }
    const n = Math.floor(d.byteLength / 4);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const arr = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      arr[i] = view.getFloat32(d.offset + 4 * i, true);
    }
    arrays[name] = arr;
  }

  return new Library(m, digest, arrays);
}
