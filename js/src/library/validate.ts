/**
 * Validate a reactor library folder against docs/library-format.md.
 *
 * Ported from pipeline/library/validate.py.
 */

import librarySchema from "../../../schema/library.schema.json";
import { Validator } from "./minischema";
import type { LibraryReader } from "./platform";
import { sha256Hex } from "./platform";

export const SUPPORTED_VERSIONS = ["0.1.0"];
export const SUPPORTED_CAPABILITIES = ["point-kinetics/lumped-thermal-v1"];
export const TRUTH_SIGNALS = ["power", "period", "fuelTemp", "coolantTemp", "xenon", "mode"];

export const TABLE_REF_TOL = 1e-9; // reactivity tables (JSON doubles)
export const ARRAY_REF_TOL = 1e-6; // float32 arrays
export const SUM_TOL = 1e-5;
export const NEG_TOL = 1e-6;

export interface Issue {
  code: string;
  path: string;
  message: string;
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

/** Linear interpolation; null when x is outside [xs[0], xs[-1]]. */
export function interp(xs: number[], ys: number[], x: number): number | null {
  if (xs.length === 0 || ys.length === 0) return null;
  const x0 = xs[0]!;
  const xLast = xs[xs.length - 1]!;
  if (x < x0 || x > xLast) {
    return null;
  }
  const i = bisectRight(xs, x) - 1;
  if (i >= xs.length - 1) {
    return ys[ys.length - 1]!;
  }
  const xi = xs[i]!;
  const xi1 = xs[i + 1]!;
  const yi = ys[i]!;
  const yi1 = ys[i + 1]!;
  const t = (x - xi) / (xi1 - xi);
  return yi + t * (yi1 - yi);
}

export function increasing(xs: number[]): boolean {
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i]!;
    const b = xs[i + 1]!;
    if (!(b > a)) return false;
  }
  return true;
}

export function safeRelpath(p: string): boolean {
  if (!p || p.includes("\\") || p.includes(":") || p.startsWith("/")) {
    return false;
  }
  const segs = p.split("/");
  return segs.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const libraryValidator = new Validator(librarySchema);

class Checker {
  private issues: Issue[] = [];
  private arrays = new Map<string, number[]>();

  constructor(private reader: LibraryReader) {}

  private add(code: string, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }

  async run(): Promise<Issue[]> {
    const raw = await this.reader.read("manifest.json");
    if (raw === null) {
      this.add("E_JSON", "manifest.json", "manifest.json not found");
      return this.issues;
    }

    let text: string;
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      text = decoder.decode(raw);
    } catch (e) {
      if (e instanceof TypeError) {
        this.add("E_JSON", "manifest.json", `not valid JSON: ${e.message}`);
        return this.issues;
      }
      throw e;
    }

    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) {
        this.add("E_JSON", "manifest.json", `not valid JSON: ${e.message}`);
        return this.issues;
      }
      throw e;
    }

    if (!isPlainObject(m)) {
      this.add("E_JSON", "$", "manifest must be a JSON object");
      return this.issues;
    }

    const version = Object.hasOwn(m, "schemaVersion") ? m.schemaVersion : undefined;
    if (typeof version === "string" && !SUPPORTED_VERSIONS.includes(version)) {
      this.add(
        "E_VERSION_UNSUPPORTED",
        "$.schemaVersion",
        `'${version}' isn't supported (supported: ${SUPPORTED_VERSIONS.join(", ")})`,
      );
      return this.issues;
    }

    for (const [path, msg] of libraryValidator.errors(m)) {
      this.add("E_SCHEMA", path, msg);
    }
    if (this.issues.length > 0) {
      return this.issues; // semantic checks assume a structurally valid manifest
    }

    const capabilities = m.capabilities as string[];
    for (const cap of capabilities) {
      if (!SUPPORTED_CAPABILITIES.includes(cap)) {
        this.add("E_CAPABILITY_UNSUPPORTED", "$.capabilities", `'${cap}' isn't implemented`);
      }
    }
    if (this.issues.length > 0) {
      return this.issues;
    }

    this.checkSources(m, "$", m.status as string);
    this.checkIds(m);
    this.checkRods(m);
    this.checkTables(m);
    this.checkPlant(m);
    await this.checkArrays(m);
    this.checkShapes(m);
    this.checkGeometry(m);
    return this.issues;
  }

  private checkSources(node: unknown, path: string, status: string): void {
    if (isPlainObject(node)) {
      if (
        Object.hasOwn(node, "source") &&
        node.source === "synthetic" &&
        status !== "synthetic"
      ) {
        this.add(
          "E_SOURCE_SYNTHETIC",
          path,
          "'synthetic' values are only allowed in a synthetic library",
        );
      }
      for (const k of Object.keys(node)) {
        this.checkSources(node[k], `${path}.${k}`, status);
      }
    } else if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        this.checkSources(node[i], `${path}[${i}]`, status);
      }
    }
  }

  private dupes(ids: string[], path: string): void {
    const seen = new Set<string>();
    for (const i of ids) {
      if (seen.has(i)) {
        this.add("E_DUPLICATE_ID", path, `duplicate id '${i}'`);
      }
      seen.add(i);
    }
  }

  private checkIds(m: any): void {
    this.dupes(
      m.reactivity.rods.map((r: any) => r.id as string),
      "$.reactivity.rods",
    );
    this.dupes(
      m.shapes.bins.elements as string[],
      "$.shapes.bins.elements",
    );
    const p = m.plant;
    for (const key of ["instruments", "trips", "interlocks", "pumps"] as const) {
      this.dupes(
        p[key].map((x: any) => x.id as string),
        `$.plant.${key}`,
      );
    }
  }

  private checkRods(m: any): void {
    const rods = new Set<string>(m.reactivity.rods.map((r: any) => r.id as string));
    for (const [where, keysList] of [
      ["$.reference.rods", Object.keys(m.reference.rods)],
      ["$.domain.rods", Object.keys(m.domain.rods)],
    ] as const) {
      const keys = new Set(keysList);
      let same = rods.size === keys.size;
      if (same) {
        for (const r of rods) {
          if (!keys.has(r)) {
            same = false;
            break;
          }
        }
      }
      if (!same) {
        const missing = Array.from(rods).filter((x) => !keys.has(x)).sort();
        const extra = Array.from(keys).filter((x) => !rods.has(x)).sort();
        this.add(
          "E_ROD_UNKNOWN",
          where,
          `must list exactly the rods; missing [${missing.join(", ")}], unknown [${extra.join(", ")}]`,
        );
      }
    }
    for (const rid of Object.keys(m.shapes.rodDeltas)) {
      if (!rods.has(rid)) {
        this.add("E_ROD_UNKNOWN", `$.shapes.rodDeltas.${rid}`, "unknown rod");
      }
    }
    for (let i = 0; i < m.domain.jointChecked.length; i++) {
      const jc = m.domain.jointChecked[i];
      for (const rid of jc.rods) {
        if (!rods.has(rid)) {
          this.add("E_ROD_UNKNOWN", `$.domain.jointChecked[${i}]`, `unknown rod '${rid}'`);
        }
      }
    }
  }

  private table(
    t: Record<string, number[]>,
    axis: string,
    value: string,
    path: string,
    ref: number | null,
  ): void {
    const cols = [axis, value, ...(Object.hasOwn(t, "unc") ? ["unc"] : [])];
    const axisCol = t[axis]!;
    const n = axisCol.length;
    if (cols.some((c) => t[c]!.length !== n) || n < 2) {
      this.add("E_TABLE_LENGTH", path, `columns [${cols.join(", ")}] must have equal length >= 2`);
      return;
    }
    if (!increasing(axisCol)) {
      this.add("E_TABLE_NOT_MONOTONIC", `${path}.${axis}`, "axis must be strictly increasing");
      return;
    }
    if (ref !== null) {
      const v = interp(axisCol, t[value]!, ref);
      if (v === null) {
        this.add("E_REF_NONZERO", path, `reference point ${ref} is outside the table`);
      } else if (Math.abs(v) > TABLE_REF_TOL) {
        this.add(
          "E_REF_NONZERO",
          path,
          `value at reference point ${ref} is ${v.toExponential(3)}, must be 0`,
        );
      }
    }
  }

  private checkTables(m: any): void {
    const ref = m.reference;
    const r = m.reactivity;
    for (let i = 0; i < r.rods.length; i++) {
      const rod = r.rods[i];
      const path = `$.reactivity.rods[${i}]`;
      const rodRef = Object.hasOwn(ref.rods, rod.id) ? (ref.rods[rod.id] as number) : null;
      this.table(rod.worth, "x", "rho", `${path}.worth`, rodRef);
      const sc = rod.scram;
      if (sc.t.length !== sc.x.length) {
        this.add("E_TABLE_LENGTH", `${path}.scram`, "t and x must have equal length");
      } else if (sc.t[0] !== 0 || !increasing(sc.t)) {
        this.add("E_TABLE_NOT_MONOTONIC", `${path}.scram.t`, "must start at 0 and strictly increase");
      } else if (
        sc.x[sc.x.length - 1] !== 0 ||
        sc.x.some((x: number) => !(0 <= x && x <= 1))
      ) {
        this.add("E_SCRAM_PROFILE", `${path}.scram.x`, "positions must be in [0, 1] and end at 0");
      } else if (sc.x.some((b: number, i: number) => i > 0 && b > sc.x[i - 1])) {
        // the engine inverts the profile (Rod.scram_tau), which needs it non-increasing
        this.add("E_SCRAM_PROFILE", `${path}.scram.x`, "positions must not increase during a scram");
      }
      if (Object.hasOwn(rod, "fireTime") && !rod.pulseCapable) {
        this.add("E_SCHEMA", `${path}.fireTime`, "only pulse-capable rods may have fireTime");
      }
      if (rod.pulseCapable && !Object.hasOwn(rod, "fireTime")) {
        this.add("E_SCHEMA", `${path}`, "pulse-capable rods need fireTime");
      }
    }
    this.table(r.fuelTemp, "T", "rho", "$.reactivity.fuelTemp", ref.Tfuel.value);
    this.table(r.coolantTemp, "T", "rho", "$.reactivity.coolantTemp", ref.Tcoolant.value);
    this.table(r.xenon, "N", "rho", "$.reactivity.xenon", ref.xenon.value);
    this.table(m.thermal.fuel.cp, "T", "c", "$.thermal.fuel.cp", null);
  }

  private signalOk(sig: string, inst: Set<string>, rods: Set<string>): boolean {
    if (sig.startsWith("truth.")) {
      const name = sig.slice("truth.".length);
      return (
        TRUTH_SIGNALS.includes(name) ||
        (name.startsWith("rod.") && rods.has(name.slice(4)))
      );
    }
    if (sig.startsWith("indicated.")) {
      return inst.has(sig.slice("indicated.".length));
    }
    return false;
  }

  private predicate(
    p: any,
    path: string,
    defaultSig: string | null,
    inst: Set<string>,
    rods: Set<string>,
  ): void {
    for (const key of ["all", "any"] as const) {
      if (Object.hasOwn(p, key)) {
        for (let i = 0; i < p[key].length; i++) {
          this.predicate(p[key][i], `${path}.${key}[${i}]`, defaultSig, inst, rods);
        }
        return;
      }
    }
    if (Object.hasOwn(p, "not")) {
      this.predicate(p.not, `${path}.not`, defaultSig, inst, rods);
      return;
    }
    const sig = Object.hasOwn(p, "signal") ? (p.signal as string) : defaultSig;
    if (sig === null || sig === undefined) {
      this.add("E_SIGNAL_UNKNOWN", path, "predicate must name a signal here");
    } else if (!this.signalOk(sig, inst, rods)) {
      this.add("E_SIGNAL_UNKNOWN", path, `unknown signal '${sig}'`);
    }
    if (typeof p.value === "string" && p.op !== "eq" && p.op !== "ne") {
      this.add("E_PREDICATE_TYPE", path, `op '${p.op}' needs a number`);
    }
    if (sig === "truth.mode" && p.op !== "eq" && p.op !== "ne") {
      this.add("E_PREDICATE_TYPE", path, "truth.mode only supports eq and ne");
    }
  }

  private checkPlant(m: any): void {
    const p = m.plant;
    const rods = new Set<string>(m.reactivity.rods.map((r: any) => r.id as string));
    const inst = new Set<string>(p.instruments.map((i: any) => i.id as string));
    if (!p.modes.includes(p.initialMode)) {
      this.add("E_MODE_UNKNOWN", "$.plant.initialMode", `'${p.initialMode}' isn't in modes`);
    }
    const pumps = new Set<string>(p.pumps.map((x: any) => x.id as string));
    if (!pumps.has(m.thermal.heatExchanger.pump)) {
      this.add("E_PUMP_UNKNOWN", "$.thermal.heatExchanger.pump", "unknown pump");
    }
    for (let i = 0; i < p.instruments.length; i++) {
      const ins = p.instruments[i];
      if (
        !ins.signal.startsWith("truth.") ||
        !this.signalOk(ins.signal, inst, rods)
      ) {
        this.add(
          "E_SIGNAL_UNKNOWN",
          `$.plant.instruments[${i}]`,
          `instrument signal must be a truth signal, got '${ins.signal}'`,
        );
      }
    }
    for (let i = 0; i < p.trips.length; i++) {
      const t = p.trips[i];
      const path = `$.plant.trips[${i}]`;
      if (!this.signalOk(t.input, inst, rods)) {
        this.add("E_SIGNAL_UNKNOWN", `${path}.input`, `unknown signal '${t.input}'`);
      }
      this.predicate(t.predicate, `${path}.predicate`, t.input, inst, rods);
      const modes = Object.hasOwn(t, "modes") ? (t.modes as string[]) : [];
      for (const mode of modes) {
        if (!p.modes.includes(mode)) {
          this.add("E_MODE_UNKNOWN", `${path}.modes`, `'${mode}' isn't in modes`);
        }
      }
    }
    for (let i = 0; i < p.interlocks.length; i++) {
      const il = p.interlocks[i];
      this.predicate(il.when, `$.plant.interlocks[${i}].when`, null, inst, rods);
    }
  }

  private async checkArrays(m: any): Promise<void> {
    for (const name of Object.keys(m.arrays)) {
      const d = m.arrays[name];
      const path = `$.arrays.${name}`;
      if (!safeRelpath(d.file)) {
        this.add("E_PATH_UNSAFE", path, `'${d.file}' must be a contained relative path`);
        continue;
      }
      const data = await this.reader.read(d.file);
      if (data === null) {
        this.add("E_FILE_MISSING", path, `${d.file} not found`);
        continue;
      }
      let count = 1;
      for (const dim of d.shape as number[]) {
        count *= dim;
      }
      if (d.byteLength !== 4 * count || d.offset + d.byteLength > data.byteLength) {
        this.add(
          "E_OFFSET_BOUNDS",
          path,
          `byteLength ${d.byteLength} / offset ${d.offset} don't fit shape [${d.shape.join(", ")}] and file size ${data.byteLength}`,
        );
        continue;
      }
      const digest = await sha256Hex(data);
      if (digest !== d.sha256) {
        this.add("E_DIGEST_MISMATCH", path, "sha256 doesn't match the file");
        continue;
      }
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const values: number[] = new Array(count);
      let hasNonFinite = false;
      for (let i = 0; i < count; i++) {
        const v = view.getFloat32(d.offset + 4 * i, true);
        if (!Number.isFinite(v)) {
          hasNonFinite = true;
        }
        values[i] = v;
      }
      if (hasNonFinite) {
        this.add("E_NONFINITE", path, "contains NaN or infinity");
        continue;
      }
      this.arrays.set(name, values);
    }
  }

  private getArray(m: any, name: string, dims: number[], path: string): number[] | null {
    if (!Object.hasOwn(m.arrays, name)) {
      this.add("E_ARRAY_UNKNOWN", path, `array '${name}' isn't declared in $.arrays`);
      return null;
    }
    const shape = m.arrays[name].shape as number[];
    if (shape.length !== dims.length || !shape.every((v, i) => v === dims[i])) {
      this.add(
        "E_SHAPE_DIMS",
        path,
        `array '${name}' has shape [${shape.join(", ")}], expected [${dims.join(", ")}]`,
      );
      return null;
    }
    return this.arrays.get(name) ?? null;
  }

  private checkShapes(m: any): void {
    const s = m.shapes;
    const E = (s.bins.elements as string[]).length;
    const edges = s.bins.axialEdgesCm as number[];
    if (!increasing(edges)) {
      this.add("E_TABLE_NOT_MONOTONIC", "$.shapes.bins.axialEdgesCm", "must be strictly increasing");
      return;
    }
    const A = edges.length - 1;
    const n = E * A;
    const base = this.getArray(m, s.base, [E, A], "$.shapes.base");
    if (Object.hasOwn(s, "baseUnc")) {
      this.getArray(m, s.baseUnc, [E, A], "$.shapes.baseUnc");
    }
    const vols = this.getArray(m, s.volumes, [E, A], "$.shapes.volumes");
    if (vols !== null) {
      let minVol = Infinity;
      for (let i = 0; i < vols.length; i++) {
        if (vols[i]! < minVol) minVol = vols[i]!;
      }
      if (minVol <= 0) {
        this.add("E_VOLUME_NONPOSITIVE", "$.shapes.volumes", "every bin volume must be > 0");
      }
    }
    if (base !== null) {
      let baseSum = 0;
      for (let i = 0; i < base.length; i++) {
        baseSum += base[i]!;
      }
      if (Math.abs(baseSum - 1.0) > SUM_TOL) {
        this.add("E_SHAPE_NORMALIZATION", "$.shapes.base", `sums to ${baseSum.toFixed(7)}, must be 1`);
      }
    }

    const ref = m.reference;
    const deltas: Array<{ path: string; grid: number[]; name: string; refPt: number | null }> = [];
    for (const rid of Object.keys(s.rodDeltas)) {
      const d = s.rodDeltas[rid];
      const refPt = Object.hasOwn(ref.rods, rid) ? (ref.rods[rid] as number) : null;
      deltas.push({
        path: `$.shapes.rodDeltas.${rid}`,
        grid: d.x,
        name: d.array,
        refPt,
      });
    }
    deltas.push({
      path: "$.shapes.tempDelta",
      grid: s.tempDelta.T,
      name: s.tempDelta.array,
      refPt: ref.Tfuel.value,
    });

    for (const { path, grid, name, refPt } of deltas) {
      if (!increasing(grid)) {
        this.add("E_TABLE_NOT_MONOTONIC", path, "grid must be strictly increasing");
        continue;
      }
      const arr = this.getArray(m, name, [grid.length, E, A], path);
      if (arr === null) {
        continue;
      }
      const slices: number[][] = [];
      for (let k = 0; k < grid.length; k++) {
        slices.push(arr.slice(k * n, (k + 1) * n));
      }
      for (let k = 0; k < slices.length; k++) {
        const sl = slices[k]!;
        let slSum = 0;
        for (let j = 0; j < sl.length; j++) {
          slSum += sl[j]!;
        }
        if (Math.abs(slSum) > SUM_TOL) {
          this.add("E_DELTA_SUM", `${path}[${k}]`, `slice sums to ${slSum.toExponential(3)}, must be 0`);
        }
        if (base !== null) {
          let low = Infinity;
          for (let j = 0; j < n; j++) {
            const v = base[j]! + sl[j]!;
            if (v < low) low = v;
          }
          if (low < -NEG_TOL) {
            this.add("E_SHAPE_NEGATIVE", `${path}[${k}]`, `reconstructed shape reaches ${low.toExponential(3)}`);
          }
        }
      }
      if (refPt === null) {
        continue;
      }
      const atRef: Array<number | null> = [];
      for (let j = 0; j < n; j++) {
        const col = slices.map((sl) => sl[j]!);
        atRef.push(interp(grid, col, refPt));
      }
      if (atRef[0] === null) {
        this.add("E_REF_NONZERO", path, `reference point ${refPt} is outside the grid`);
      } else {
        let maxAbs = 0;
        for (let j = 0; j < n; j++) {
          const v = Math.abs(atRef[j]!);
          if (v > maxAbs) maxAbs = v;
        }
        if (maxAbs > ARRAY_REF_TOL) {
          this.add("E_REF_NONZERO", path, `delta at reference point ${refPt} isn't zero`);
        }
      }
    }
  }

  private checkGeometry(m: any): void {
    const elements = new Set<string>(m.shapes.bins.elements as string[]);
    const rods = new Set<string>(m.reactivity.rods.map((r: any) => r.id as string));
    const covered = new Set<string>();
    for (let i = 0; i < m.geometry.primitives.length; i++) {
      const p = m.geometry.primitives[i];
      if (Object.hasOwn(p, "element")) {
        if (elements.has(p.element)) {
          covered.add(p.element);
        } else {
          this.add("E_GEOMETRY_ID", `$.geometry.primitives[${i}]`, `unknown element '${p.element}'`);
        }
      }
      if (Object.hasOwn(p, "rod") && !rods.has(p.rod)) {
        this.add("E_GEOMETRY_ID", `$.geometry.primitives[${i}]`, `unknown rod '${p.rod}'`);
      }
    }
    const missingElements = Array.from(elements).filter((e) => !covered.has(e)).sort();
    for (const e of missingElements) {
      this.add("E_GEOMETRY_ID", "$.geometry.primitives", `element '${e}' has no geometry`);
    }
  }
}

export async function validateLibrary(reader: LibraryReader): Promise<Issue[]> {
  const checker = new Checker(reader);
  return await checker.run();
}
