/**
 * Plain engine inputs ("params") for capability point-kinetics/lumped-thermal-v1.
 *
 * Ported from kirk/params.py: the same JSON-shaped data, checks, canonical digest and compiled form.
 *
 *   checkParams(p)    structural checks; throws ParamsError with a JSON path (structure only: the
 *                     library validator's physics conventions apply only to library folders)
 *   paramsDigest(p)   SHA-256 of a canonical encoding (identical bytes to Python)
 *   Model             the compiled form the engine reads (tables, rods, sums)
 */

import { sha256HexSync } from "./sha256.js";

export const CAPABILITY = "point-kinetics/lumped-thermal-v1";
export const DIGEST_PREFIX = "kirk-params-v1\n";
export const OUT_OF_RANGE = ["clamp-and-flag", "extrapolate-and-flag", "reject"] as const;
export const STATUSES = ["synthetic", "experimental", "validated-for-domain"] as const;
const TRUTH_SIGNALS = ["power", "period", "fuelTemp", "coolantTemp", "xenon", "mode"];
const OPS = ["gt", "ge", "lt", "le", "absGt", "eq", "ne", "between"];
const COMMAND_TYPES = [
  "rod.move",
  "rod.fire",
  "mode.set",
  "pump.set",
  "scram",
  "trip.reset",
  "fault.reactivity",
  "fault.instrument",
];

// ---------------------------------------------------------------- types

export interface TableParams {
  x: number[]; // strictly increasing, at least 2 points
  y: number[];
  outOfRange?: (typeof OUT_OF_RANGE)[number]; // default "clamp-and-flag"
}

export interface KineticsParams {
  beta: number[]; // 6 delayed-neutron fractions
  lambda: number[]; // 6 decay constants, 1/s
  genTime: number; // s
  extSource: number; // W/s, may be 0
}

export interface ReferenceParams {
  rods: Record<string, number>; // rod positions (0..1) at which rho was measured
  Tfuel: number; // K
  Tcoolant: number; // K
  rho: number;
  calibration?: number; // added to rho (default 0)
}

export interface RodParams {
  id: string;
  speed: number; // fraction/s
  pulseCapable: boolean;
  fireTime?: number; // s, pulse-capable rods only
  worth: TableParams; // rho vs position (0..1)
  scram: { t: number[]; x: number[] };
  name?: string;
  travelCm?: number;
}

export interface FeedbackParams {
  fuelTemp: TableParams;
  coolantTemp: TableParams;
  xenon: TableParams;
}

export interface ThermalParams {
  fuelMass: number;
  fuelCp: TableParams;
  coolantMass: number;
  coolantCp: number;
  hA: number;
  UA: number;
  sinkTemp: number;
  hxPump: string | null;
  fuelFraction: number;
}

export interface PoisonParams {
  fluxPerWatt: number;
  sigmaF: number;
  gammaI: number;
  gammaXe: number;
  lambdaI: number;
  lambdaXe: number;
  sigmaXe: number;
}

export interface PlantParams {
  modes: string[];
  initialMode: string;
  pumps: string[];
  instruments: any[]; // {id, signal, scale, range, lag, noise}
  trips: any[]; // {id, input, predicate, modes?, latching}
  interlocks: any[]; // {id, when, blocks, reason}
}

export interface ValidityParams {
  status: (typeof STATUSES)[number];
  rods: Record<string, number[]>;
  Tfuel: number[];
  Tcoolant: number[];
  xenon: number[];
  jointChecked: { rods: Record<string, number> }[];
}

export interface ShapeParams {
  elements: string[];
  axialEdgesCm: number[];
  base: number[];
  rodDeltas: Record<string, { x: number[]; values: number[] }>;
  tempDelta: { x: number[]; values: number[] };
}

export interface ReactorParams {
  id: string;
  kinetics: KineticsParams;
  reference: ReferenceParams;
  rods: RodParams[];
  feedback: FeedbackParams;
  thermal: ThermalParams;
  poisons: PoisonParams;
  plant: PlantParams;
  validity?: ValidityParams;
  shape?: ShapeParams;
}

// ---------------------------------------------------------------- checks

export class ParamsError extends Error {
  path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ParamsError";
    this.path = path;
  }
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function has(v: any, k: string): boolean {
  return Object.hasOwn(v, k) && v[k] !== undefined;
}

function fail(path: string, message: string): never {
  throw new ParamsError(path, message);
}

function obj(v: any, path: string, required: readonly string[], optional: readonly string[] = []): any {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    fail(path, "must be an object");
  }
  for (const k of required) {
    if (!has(v, k)) fail(`${path}.${k}`, "is required");
  }
  for (const k of Object.keys(v)) {
    if (v[k] !== undefined && !required.includes(k) && !optional.includes(k)) fail(`${path}.${k}`, "unknown key");
  }
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string" || v === "") fail(path, "must be a non-empty string");
  return v;
}

function num(v: unknown, path: string, opts: { lo?: number; positive?: boolean } = {}): number {
  if (!isNum(v)) fail(path, "must be a finite number");
  if (opts.positive && !(v > 0)) fail(path, "must be > 0");
  if (opts.lo !== undefined && v < opts.lo) fail(path, `must be >= ${opts.lo}`);
  return v;
}

function nums(v: unknown, path: string, opts: { n?: number; minLen?: number } = {}): number[] {
  if (!Array.isArray(v)) fail(path, "must be a list of numbers");
  if (opts.n !== undefined && v.length !== opts.n) fail(path, `must have ${opts.n} values`);
  if (v.length < (opts.minLen ?? 0)) fail(path, `must have at least ${opts.minLen} values`);
  v.forEach((x, i) => num(x, `${path}[${i}]`));
  return v;
}

function increasing(xs: number[], path: string): void {
  for (let i = 0; i < xs.length - 1; i++) {
    if (!(xs[i]! < xs[i + 1]!)) fail(path, "must be strictly increasing");
  }
}

function interval(v: unknown, path: string): void {
  const [lo, hi] = nums(v, path, { n: 2 });
  if (lo! > hi!) fail(path, "must be [lo, hi] with lo <= hi");
}

function ids(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) fail(path, "must be a list");
  const seen = new Set<string>();
  v.forEach((x, i) => {
    str(x, `${path}[${i}]`);
    if (seen.has(x)) fail(`${path}[${i}]`, `duplicate id '${x}'`);
    seen.add(x);
  });
  return v;
}

function table(t: any, path: string): void {
  obj(t, path, ["x", "y"], ["outOfRange"]);
  nums(t.x, `${path}.x`, { minLen: 2 });
  nums(t.y, `${path}.y`, { n: t.x.length });
  increasing(t.x, `${path}.x`);
  if (!(OUT_OF_RANGE as readonly string[]).includes(t.outOfRange ?? "clamp-and-flag")) {
    fail(`${path}.outOfRange`, `must be one of ${OUT_OF_RANGE.join(", ")}`);
  }
}

function signalOk(sig: unknown, rods: readonly string[], instruments: readonly string[]): boolean {
  if (typeof sig !== "string") return false;
  if (sig.startsWith("truth.")) {
    const name = sig.slice("truth.".length);
    return TRUTH_SIGNALS.includes(name) || (name.startsWith("rod.") && rods.includes(name.slice(4)));
  }
  return sig.startsWith("indicated.") && instruments.includes(sig.slice("indicated.".length));
}

function predicate(p: any, path: string, dflt: string | null, rods: string[], instruments: string[]): void {
  if (typeof p !== "object" || p === null || Array.isArray(p)) fail(path, "must be an object");
  for (const key of ["all", "any"]) {
    if (has(p, key)) {
      obj(p, path, [key]);
      if (!Array.isArray(p[key]) || p[key].length === 0) fail(`${path}.${key}`, "must be a non-empty list");
      p[key].forEach((sub: any, i: number) => predicate(sub, `${path}.${key}[${i}]`, dflt, rods, instruments));
      return;
    }
  }
  if (has(p, "not")) {
    obj(p, path, ["not"]);
    predicate(p.not, `${path}.not`, dflt, rods, instruments);
    return;
  }
  obj(p, path, ["op", "value"], ["signal"]);
  const sig = has(p, "signal") ? p.signal : dflt;
  if (sig === null) fail(path, "must name a signal");
  if (!signalOk(sig, rods, instruments)) fail(path, `unknown signal '${sig}'`);
  const op = p.op;
  const value = p.value;
  if (!OPS.includes(op)) fail(`${path}.op`, `unknown operator '${op}'`);
  if (op === "between") {
    interval(value, `${path}.value`);
  } else if (typeof value === "string") {
    if (op !== "eq" && op !== "ne") fail(`${path}.value`, "string values need eq or ne");
  } else if (!isNum(value)) {
    fail(`${path}.value`, "must be a number or a string");
  }
  if (sig === "truth.mode" && op !== "eq" && op !== "ne") fail(`${path}.op`, "truth.mode only supports eq and ne");
}

function idsOf(list: unknown, path: string): string[] {
  if (!Array.isArray(list)) fail(path, "must be a list");
  return ids(
    list.map((x) => (typeof x === "object" && x !== null ? x.id : null)),
    `${path}[*].id`,
  );
}

/** Throw ParamsError (with a JSON path) at the first structural problem in p. */
export function checkParams(p: any): asserts p is ReactorParams {
  obj(p, "$", ["id", "kinetics", "reference", "rods", "feedback", "thermal", "poisons", "plant"], ["validity", "shape"]);
  str(p.id, "$.id");

  const k = obj(p.kinetics, "$.kinetics", ["beta", "lambda", "genTime", "extSource"]);
  nums(k.beta, "$.kinetics.beta", { n: 6 });
  nums(k.lambda, "$.kinetics.lambda", { n: 6 });
  for (let i = 0; i < 6; i++) {
    num(k.beta[i], `$.kinetics.beta[${i}]`, { lo: 0.0 });
    num(k.lambda[i], `$.kinetics.lambda[${i}]`, { positive: true });
  }
  num(k.genTime, "$.kinetics.genTime", { positive: true });
  num(k.extSource, "$.kinetics.extSource", { lo: 0.0 });

  const rodIds = idsOf(p.rods, "$.rods");
  p.rods.forEach((r: any, i: number) => {
    const path = `$.rods[${i}]`;
    obj(r, path, ["id", "speed", "pulseCapable", "worth", "scram"], ["fireTime", "name", "travelCm"]);
    num(r.speed, `${path}.speed`, { positive: true });
    if (typeof r.pulseCapable !== "boolean") fail(`${path}.pulseCapable`, "must be true or false");
    if (r.pulseCapable !== has(r, "fireTime")) {
      fail(`${path}.fireTime`, "pulse-capable rods need fireTime, and only they may have it");
    }
    if (has(r, "fireTime")) num(r.fireTime, `${path}.fireTime`, { positive: true });
    if (has(r, "name")) str(r.name, `${path}.name`);
    if (has(r, "travelCm")) num(r.travelCm, `${path}.travelCm`, { positive: true });
    table(r.worth, `${path}.worth`);
    const s = obj(r.scram, `${path}.scram`, ["t", "x"]);
    nums(s.t, `${path}.scram.t`, { minLen: 2 });
    nums(s.x, `${path}.scram.x`, { n: s.t.length });
    increasing(s.t, `${path}.scram.t`);
    if (s.t[0] !== 0.0) fail(`${path}.scram.t`, "must start at 0");
    for (let j = 0; j < s.x.length; j++) {
      if (!(0.0 <= s.x[j] && s.x[j] <= 1.0)) fail(`${path}.scram.x[${j}]`, "must be in [0, 1]");
    }
    for (let j = 0; j < s.x.length - 1; j++) {
      if (s.x[j] < s.x[j + 1]) fail(`${path}.scram.x`, "must be non-increasing");
    }
    if (s.x[s.x.length - 1] !== 0.0) fail(`${path}.scram.x`, "must end at 0 (fully inserted)");
  });

  const ref = obj(p.reference, "$.reference", ["rods", "Tfuel", "Tcoolant", "rho"], ["calibration"]);
  obj(ref.rods, "$.reference.rods", rodIds);
  for (const rid of rodIds) {
    const x = num(ref.rods[rid], `$.reference.rods.${rid}`);
    if (!(0.0 <= x && x <= 1.0)) fail(`$.reference.rods.${rid}`, "must be in [0, 1]");
  }
  for (const key of ["Tfuel", "Tcoolant", "rho", "calibration"]) {
    if (has(ref, key)) num(ref[key], `$.reference.${key}`);
  }

  const fb = obj(p.feedback, "$.feedback", ["fuelTemp", "coolantTemp", "xenon"]);
  for (const key of ["fuelTemp", "coolantTemp", "xenon"]) {
    table(fb[key], `$.feedback.${key}`);
  }

  const pl = obj(p.plant, "$.plant", ["modes", "initialMode", "pumps", "instruments", "trips", "interlocks"]);
  const modes = ids(pl.modes, "$.plant.modes");
  if (!modes.includes(pl.initialMode)) fail("$.plant.initialMode", "must be one of modes");
  const pumps = ids(pl.pumps, "$.plant.pumps");

  const t = obj(p.thermal, "$.thermal", [
    "fuelMass",
    "fuelCp",
    "coolantMass",
    "coolantCp",
    "hA",
    "UA",
    "sinkTemp",
    "hxPump",
    "fuelFraction",
  ]);
  for (const key of ["fuelMass", "coolantMass", "coolantCp"]) {
    num(t[key], `$.thermal.${key}`, { positive: true });
  }
  for (const key of ["hA", "UA"]) {
    num(t[key], `$.thermal.${key}`, { lo: 0.0 });
  }
  num(t.sinkTemp, "$.thermal.sinkTemp");
  table(t.fuelCp, "$.thermal.fuelCp");
  t.fuelCp.y.forEach((c: number, i: number) => {
    if (!(c > 0)) fail(`$.thermal.fuelCp.y[${i}]`, "must be > 0");
  });
  if (t.hxPump !== null && !pumps.includes(t.hxPump)) fail("$.thermal.hxPump", "must be a pump id or null");
  const f = num(t.fuelFraction, "$.thermal.fuelFraction");
  if (!(0.0 <= f && f <= 1.0)) fail("$.thermal.fuelFraction", "must be in [0, 1]");

  const po = obj(p.poisons, "$.poisons", [
    "fluxPerWatt",
    "sigmaF",
    "gammaI",
    "gammaXe",
    "lambdaI",
    "lambdaXe",
    "sigmaXe",
  ]);
  for (const key of Object.keys(po)) {
    num(po[key], `$.poisons.${key}`, { lo: 0.0 });
  }
  for (const key of ["lambdaI", "lambdaXe"]) {
    num(po[key], `$.poisons.${key}`, { positive: true });
  }

  const instIds = idsOf(pl.instruments, "$.plant.instruments");
  pl.instruments.forEach((ins: any, i: number) => {
    const path = `$.plant.instruments[${i}]`;
    obj(ins, path, ["id", "signal", "scale", "range", "lag", "noise"]);
    const sig = ins.signal;
    if (!signalOk(sig, rodIds, []) || !sig.startsWith("truth.") || sig === "truth.mode") {
      fail(`${path}.signal`, "must be a numeric truth signal");
    }
    if (ins.scale !== "linear" && ins.scale !== "log") fail(`${path}.scale`, "must be linear or log");
    interval(ins.range, `${path}.range`);
    num(ins.lag, `${path}.lag`, { lo: 0.0 });
    num(ins.noise, `${path}.noise`, { lo: 0.0 });
  });

  idsOf(pl.trips, "$.plant.trips");
  pl.trips.forEach((tr: any, i: number) => {
    const path = `$.plant.trips[${i}]`;
    obj(tr, path, ["id", "input", "predicate", "latching"], ["modes"]);
    if (!signalOk(tr.input, rodIds, instIds)) fail(`${path}.input`, `unknown signal '${tr.input}'`);
    predicate(tr.predicate, `${path}.predicate`, tr.input, rodIds, instIds);
    if (typeof tr.latching !== "boolean") fail(`${path}.latching`, "must be true or false");
    if (has(tr, "modes")) {
      ids(tr.modes, `${path}.modes`).forEach((m, j) => {
        if (!modes.includes(m)) fail(`${path}.modes[${j}]`, `unknown mode '${m}'`);
      });
    }
  });

  idsOf(pl.interlocks, "$.plant.interlocks");
  pl.interlocks.forEach((il: any, i: number) => {
    const path = `$.plant.interlocks[${i}]`;
    obj(il, path, ["id", "when", "blocks", "reason"]);
    predicate(il.when, `${path}.when`, null, rodIds, instIds);
    ids(il.blocks, `${path}.blocks`).forEach((c, j) => {
      if (!COMMAND_TYPES.includes(c)) fail(`${path}.blocks[${j}]`, `unknown command type '${c}'`);
    });
    str(il.reason, `${path}.reason`);
  });

  if (has(p, "validity")) {
    const v = obj(p.validity, "$.validity", ["status", "rods", "Tfuel", "Tcoolant", "xenon", "jointChecked"]);
    if (!(STATUSES as readonly string[]).includes(v.status)) {
      fail("$.validity.status", `must be one of ${STATUSES.join(", ")}`);
    }
    obj(v.rods, "$.validity.rods", rodIds);
    for (const rid of rodIds) interval(v.rods[rid], `$.validity.rods.${rid}`);
    for (const key of ["Tfuel", "Tcoolant", "xenon"]) interval(v[key], `$.validity.${key}`);
    if (!Array.isArray(v.jointChecked)) fail("$.validity.jointChecked", "must be a list");
    v.jointChecked.forEach((jc: any, i: number) => {
      obj(jc, `$.validity.jointChecked[${i}]`, ["rods"]);
      obj(jc.rods, `$.validity.jointChecked[${i}].rods`, [], rodIds);
      for (const [rid, x] of Object.entries(jc.rods)) num(x, `$.validity.jointChecked[${i}].rods.${rid}`);
    });
  }

  if (has(p, "shape")) {
    const s = obj(p.shape, "$.shape", ["elements", "axialEdgesCm", "base", "rodDeltas", "tempDelta"]);
    ids(s.elements, "$.shape.elements");
    nums(s.axialEdgesCm, "$.shape.axialEdgesCm", { minLen: 2 });
    increasing(s.axialEdgesCm, "$.shape.axialEdgesCm");
    const n = s.elements.length * (s.axialEdgesCm.length - 1);
    nums(s.base, "$.shape.base", { n });
    obj(s.rodDeltas, "$.shape.rodDeltas", [], rodIds);
    const deltas: [string, any][] = Object.entries(s.rodDeltas).map(([rid, d]) => [`$.shape.rodDeltas.${rid}`, d]);
    deltas.push(["$.shape.tempDelta", s.tempDelta]);
    for (const [path, d] of deltas) {
      obj(d, path, ["x", "values"]);
      nums(d.x, `${path}.x`, { minLen: 2 });
      increasing(d.x, `${path}.x`);
      nums(d.values, `${path}.values`, { n: d.x.length * n });
    }
  }
}

// ---------------------------------------------------------------- digest

function compareCodePoints(a: string, b: string): number {
  // Python sorts strings by code point; JS's default sort compares UTF-16 code units.
  const A = Array.from(a);
  const B = Array.from(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i]!.codePointAt(0)! - B[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

function jsonString(s: string): string {
  // Same text as Python's json.dumps(s, ensure_ascii=True): every non-ASCII UTF-16 unit as \uXXXX (lowercase hex).
  return JSON.stringify(s).replace(
    /[\u0080-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

const f64 = new DataView(new ArrayBuffer(8));

/** Canonical text: sorted keys, no whitespace, ASCII-only strings, numbers as float64 big-endian bits. */
export function canon(v: unknown, out: string[]): void {
  if (v === null) {
    out.push("null");
  } else if (v === true) {
    out.push("true");
  } else if (v === false) {
    out.push("false");
  } else if (typeof v === "number") {
    f64.setFloat64(0, v, false);
    let hex = "f";
    for (let i = 0; i < 8; i++) hex += f64.getUint8(i).toString(16).padStart(2, "0");
    out.push(hex);
  } else if (typeof v === "string") {
    out.push(jsonString(v));
  } else if (Array.isArray(v)) {
    out.push("[");
    v.forEach((x, i) => {
      if (i) out.push(",");
      canon(x, out);
    });
    out.push("]");
  } else if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined) // an undefined property is an absent key, as in JSON
      .sort(compareCodePoints);
    out.push("{");
    keys.forEach((k, i) => {
      if (i) out.push(",");
      out.push(jsonString(k), ":");
      canon(o[k], out);
    });
    out.push("}");
  } else {
    throw new TypeError(`params can't hold ${typeof v}`);
  }
}

export function paramsDigest(p: unknown): string {
  const out: string[] = [DIGEST_PREFIX];
  canon(p, out);
  return sha256HexSync(new TextEncoder().encode(out.join("")));
}

// ---------------------------------------------------------------- compiled form

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

  static of(t: TableParams): Table {
    return new Table(t.x, t.y, t.outOfRange ?? "clamp-and-flag");
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
  travelCm?: number;
  speed: number;
  pulseCapable: boolean;
  fireTime?: number;
  worth: Table;
  scramT: number[];
  scramX: number[];
  _scramTable: Table;

  constructor(d: RodParams) {
    this.id = d.id;
    this.name = d.name ?? d.id;
    this.travelCm = d.travelCm;
    this.speed = d.speed;
    this.pulseCapable = d.pulseCapable;
    this.fireTime = d.fireTime;
    this.worth = Table.of(d.worth);
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

/** Read-only compiled view of checked params, in the form the engine's hot path reads. */
export class Model {
  id: string;

  refRods: Record<string, number>;
  refTfuel: number;
  refTcool: number;
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
  hxPump: string | null;
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

  validity: ValidityParams | null;
  shape: ShapeParams | null;

  constructor(p: ReactorParams) {
    this.id = p.id;

    const ref = p.reference;
    this.refRods = { ...ref.rods };
    this.refTfuel = ref.Tfuel;
    this.refTcool = ref.Tcoolant;
    this.refRho = ref.rho;
    this.calibration = ref.calibration ?? 0.0;

    const k = p.kinetics;
    this.beta = [...k.beta];
    this.lam = [...k.lambda];
    this.betaTotal = 0.0;
    for (const b of this.beta) {
      this.betaTotal += b;
    }
    this.genTime = k.genTime;
    this.extSource = k.extSource;

    this.rods = p.rods.map((d) => new Rod(d));
    this.rodById = {};
    for (const rod of this.rods) {
      this.rodById[rod.id] = rod;
    }
    this.fuelTemp = Table.of(p.feedback.fuelTemp);
    this.coolTemp = Table.of(p.feedback.coolantTemp);
    this.xenon = Table.of(p.feedback.xenon);

    const t = p.thermal;
    this.fuelMass = t.fuelMass;
    this.fuelCp = Table.of(t.fuelCp);
    this.coolMass = t.coolantMass;
    this.coolCp = t.coolantCp;
    this.hA = t.hA;
    this.UA = t.UA;
    this.sinkTemp = t.sinkTemp;
    this.hxPump = t.hxPump;
    this.fuelFraction = t.fuelFraction;

    const po = p.poisons;
    this.fluxPerWatt = po.fluxPerWatt;
    this.sigmaF = po.sigmaF;
    this.gammaI = po.gammaI;
    this.gammaX = po.gammaXe;
    this.lambdaI = po.lambdaI;
    this.lambdaX = po.lambdaXe;
    this.sigmaX = po.sigmaXe;

    const pl = p.plant;
    this.modes = [...pl.modes];
    this.initialMode = pl.initialMode;
    this.pumps = [...pl.pumps];
    this.instruments = pl.instruments.map((i) => ({ ...i }));
    this.trips = pl.trips.map((tr) => ({ ...tr }));
    this.interlocks = pl.interlocks.map((i) => ({ ...i }));

    this.validity = p.validity ?? null;
    this.shape = p.shape ?? null;
  }
}
