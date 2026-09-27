/**
 * Reference engine for capability point-kinetics/lumped-thermal-v1.
 *
 * Ported line for line from kirk/engine.py. Inputs are plain params (./params.ts).
 */

import { MASK64, SplitMix64, luFactor, luSolve, type LUFactored } from "./numerics";
import { Model, Table, checkParams, paramsDigest, type ReactorParams } from "./params";

export const ENGINE_VERSION = "0.2.0";
export { CAPABILITY } from "./params";

export interface EngineConfig {
  outerDt: number;
  rtol: number;
  hInit: number;
  hMin: number;
  eventTol: number;
  method: string;
  [key: string]: any;
}

export const DEFAULT_CONFIG: EngineConfig = {
  outerDt: 0.01,
  rtol: 1e-6,
  hInit: 1e-5,
  hMin: 1e-12,
  eventTol: 1e-7,
  method: "ros2",
};

// ROS3P coefficients: J. Lang and J. Verwer (2001) Table 5.1
// Exported as a mutable object so tests can patch coefficients
export const ros3pCoeffs = {
  gamma: 7.886751345948129e-1,
  a21: 1.267949192431123e0,
  a31: 1.267949192431123e0,
  a32: 0.0,
  c21: -1.607695154586736e0,
  c31: -3.464101615137755e0,
  c32: -1.732050807568877e0,
  alpha1: 0.0,
  alpha2: 1.0,
  alpha3: 1.0,
  gamma1: 7.886751345948129e-1,
  gamma2: -2.113248654051871e-1,
  gamma3: -1.077350269189626e0,
  m1: 2.0,
  m2: 5.773502691896258e-1,
  m3: 4.226497308103742e-1,
  mhat1: 2.113248654051871e0,
  mhat2: 1.0,
  mhat3: 4.226497308103742e-1,
};

export const GAMMA = 1.0 + 1.0 / Math.sqrt(2.0);
export const IP = 0;
export const IC0 = 1;
export const ITF = 7;
export const ITC = 8;
export const II = 9;
export const IX = 10;
export const IEP = 11;
export const IEH = 12;
export const NBASE = 13;
export const LAGGABLE = ["power", "fuelTemp", "coolantTemp", "xenon"] as const;

export class InitError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "InitError";
    this.code = code;
  }
}

export class CheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointError";
  }
}

export class SolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolverError";
  }
}

export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function predSignals(p: any, defaultSig?: string): string[] {
  for (const key of ["all", "any"] as const) {
    if (Object.hasOwn(p, key)) {
      const out: string[] = [];
      for (const sub of p[key]) {
        out.push(...predSignals(sub, defaultSig));
      }
      return out;
    }
  }
  if (Object.hasOwn(p, "not")) {
    return predSignals(p.not, defaultSig);
  }
  return [p.signal ?? defaultSig];
}

export type PredLeaf = [signal: string, useAbs: boolean, threshold: number];

export function predLeaves(p: any, defaultSig?: string): PredLeaf[] {
  for (const key of ["all", "any"] as const) {
    if (Object.hasOwn(p, key)) {
      const out: PredLeaf[] = [];
      for (const sub of p[key]) {
        out.push(...predLeaves(sub, defaultSig));
      }
      return out;
    }
  }
  if (Object.hasOwn(p, "not")) {
    return predLeaves(p.not, defaultSig);
  }
  const sig = p.signal ?? defaultSig;
  const op = p.op;
  const ref = p.value;
  if (op === "between") {
    return [
      [sig, false, ref[0]],
      [sig, false, ref[1]],
    ];
  }
  if (typeof ref === "string") {
    return [];
  }
  return [[sig, op === "absGt", ref]];
}

export function sign(x: number): number {
  return (x > 0.0 ? 1 : 0) - (x < 0.0 ? 1 : 0);
}

export function evalPredicate(p: any, get: (s: string) => any, defaultSig?: string): boolean {
  if (Object.hasOwn(p, "all")) {
    return p.all.every((s: any) => evalPredicate(s, get, defaultSig));
  }
  if (Object.hasOwn(p, "any")) {
    return p.any.some((s: any) => evalPredicate(s, get, defaultSig));
  }
  if (Object.hasOwn(p, "not")) {
    return !evalPredicate(p.not, get, defaultSig);
  }
  const sig = p.signal ?? defaultSig;
  const v = get(sig);
  if (v === null || v === undefined) {
    return false;
  }
  const op = p.op;
  const ref = p.value;
  if (op === "eq") return v === ref;
  if (op === "ne") return v !== ref;
  if (op === "between") return ref[0] <= v && v <= ref[1];
  if (op === "gt") return v > ref;
  if (op === "ge") return v >= ref;
  if (op === "lt") return v < ref;
  if (op === "le") return v <= ref;
  if (op === "absGt") return Math.abs(v) > ref;
  throw new Error(`unknown operator ${op}`);
}

export class Engine {
  params: ReactorParams;
  digest: string;
  model: Model;
  config: EngineConfig;
  initSpec: any;
  seed: number | bigint;
  rng: SplitMix64;

  lagged: any[];
  lagIndex: Record<string, number>;
  locatedTrips: any[];
  boundaryTrips: any[];

  stepIndex: number;
  extraRho: number;
  h: number;
  latched: string[];
  activeTrips: string[];
  faults: Record<string, string>;
  indicated: Record<string, number | null>;
  pending: any[];
  nextSeq: number;
  commandLog: any[];
  events: any[];
  halted: string | null;
  diag: { steps: number; rejected: number; rhsCalls: number };

  motions: Record<string, any>;
  mode: string;
  pumps: Record<string, boolean>;
  y: number[];
  peakPower: number;
  peakTime: number;

  private _stepper: (
    t: number,
    y: number[],
    h: number,
    J: number[][],
    f0: number[],
    ft: number[],
  ) => [number[], number];
  private _stepExp: number;
  private _stepFac: (err: number) => number;

  constructor(params: ReactorParams, init?: any, seed: number | bigint = 1, config?: Partial<EngineConfig>) {
    this.params = structuredClone(params); // the caller may change its object later; this run keeps its inputs
    checkParams(this.params);
    this.digest = paramsDigest(this.params);
    const mdl = (this.model = new Model(this.params));
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    const method = this.config.method;
    if (method === "ros2") {
      this._stepper = this._ros2.bind(this);
      this._stepExp = -0.5;
      this._stepFac = (err: number) => 0.9 / Math.sqrt(err);
    } else if (method === "ros3p") {
      this._stepper = this._ros3p.bind(this);
      this._stepExp = -1.0 / 3.0;
      this._stepFac = (err: number) => 0.9 * Math.pow(err, this._stepExp);
    } else {
      throw new InitError("E_INIT_INVALID", `unknown method '${method}'`);
    }

    this.initSpec = structuredClone(init ?? {});
    this.seed = seed;
    this.rng = new SplitMix64(seed);

    this.lagged = mdl.instruments.filter(
      (ins: any) => ins.lag > 0 && LAGGABLE.includes(ins.signal.slice(6) as any),
    );
    this.lagIndex = {};
    for (let k = 0; k < this.lagged.length; k++) {
      this.lagIndex[this.lagged[k].id] = NBASE + k;
    }

    this.locatedTrips = [];
    this.boundaryTrips = [];
    for (const trip of mdl.trips) {
      const sigs = predSignals(trip.predicate, trip.input);
      if (sigs.every((s) => s.startsWith("truth."))) {
        this.locatedTrips.push(trip);
      } else {
        this.boundaryTrips.push(trip);
      }
    }

    this.stepIndex = 0;
    this.extraRho = 0.0;
    this.h = this.config.hInit;
    this.latched = [];
    this.activeTrips = [];
    this.faults = {};
    this.indicated = {};
    this.pending = [];
    this.nextSeq = 1;
    this.commandLog = [];
    this.events = [];
    this.halted = null;
    this.diag = { steps: 0, rejected: 0, rhsCalls: 0 };

    this.motions = {};
    this.mode = "";
    this.pumps = {};
    this.y = [];
    this._initState(this.initSpec);
    this.peakPower = this.y[IP]!;
    this.peakTime = 0.0;
    this._boundary(true);
  }

  private _initState(init: any): void {
    const mdl = this.model;
    const initRods = init.rods ?? {};
    const unknownRods = Object.keys(initRods)
      .filter((rid) => !Object.hasOwn(mdl.rodById, rid))
      .sort();
    if (unknownRods.length > 0) {
      throw new InitError("E_INIT_INVALID", `unknown rods [${unknownRods.map((r) => `'${r}'`).join(", ")}]`);
    }

    this.motions = {};
    for (const r of mdl.rods) {
      const x0 = Number(Object.hasOwn(initRods, r.id) ? initRods[r.id] : mdl.refRods[r.id]);
      this.motions[r.id] = { kind: "still", t0: 0.0, x0 };
    }
    for (const [rid, m] of Object.entries(this.motions)) {
      if (!(0.0 <= m.x0 && m.x0 <= 1.0)) {
        throw new InitError("E_INIT_INVALID", `rod ${rid} position must be in [0, 1]`);
      }
    }

    this.mode = init.mode ?? mdl.initialMode;
    if (!mdl.modes.includes(this.mode)) {
      throw new InitError("E_INIT_INVALID", `unknown mode '${this.mode}'`);
    }

    const initPumps = init.pumps ?? {};
    this.pumps = {};
    for (const p of mdl.pumps) {
      this.pumps[p] = Boolean(Object.hasOwn(initPumps, p) ? initPumps[p] : true);
    }

    const tf = Number(init.Tfuel ?? mdl.refTfuel);
    const tc = Number(init.Tcoolant ?? mdl.refTcool);

    const poisons = init.poisons ?? { mode: "zero" };
    const power = init.power ?? { mode: "source-equilibrium" };
    if (poisons.mode === "equilibrium" && power.mode === "source-equilibrium") {
      throw new InitError("E_INIT_INVALID", "equilibrium poisons need a given power");
    }

    const y = new Array<number>(NBASE + this.lagged.length).fill(0.0);
    y[ITF] = tf;
    y[ITC] = tc;

    let p0: number;
    if (power.mode === "given" || power.mode === "critical-equilibrium") {
      p0 = Number(power.value);
      if (p0 < 0) {
        throw new InitError("E_INIT_INVALID", "power must be >= 0");
      }
    } else {
      p0 = 0.0;
    }

    let i0 = 0.0;
    let x0 = 0.0;
    if (poisons.mode === "zero") {
      i0 = 0.0;
      x0 = 0.0;
    } else if (poisons.mode === "given") {
      i0 = Number(poisons.I);
      x0 = Number(poisons.X);
    } else if (poisons.mode === "equilibrium") {
      const phi = mdl.fluxPerWatt * p0;
      i0 = (mdl.gammaI * mdl.sigmaF * phi) / mdl.lambdaI;
      x0 = ((mdl.gammaI + mdl.gammaX) * mdl.sigmaF * phi) / (mdl.lambdaX + mdl.sigmaX * phi);
    } else {
      throw new InitError("E_INIT_INVALID", `unknown poisons mode '${poisons.mode}'`);
    }
    y[II] = i0;
    y[IX] = x0;

    this.y = y;
    const rho = this.reactivity(0.0, y).total;
    const S = mdl.extSource;
    const L = mdl.genTime;
    if (power.mode === "source-equilibrium") {
      if (S <= 0.0) {
        throw new InitError("E_INIT_NO_EQUILIBRIUM", "source equilibrium needs a positive neutron source");
      }
      if (rho >= 0.0) {
        throw new InitError(
          "E_INIT_NO_EQUILIBRIUM",
          `source equilibrium needs negative reactivity (rho = ${rho.toPrecision(6)})`,
        );
      }
      p0 = (-S * L) / rho;
    } else if (power.mode === "critical-equilibrium") {
      if (S !== 0.0) {
        throw new InitError(
          "E_INIT_NO_EQUILIBRIUM",
          "constant power at criticality needs zero source (P = -S*Lambda/rho)",
        );
      }
      if (Math.abs(rho) > 1e-12) {
        throw new InitError(
          "E_INIT_NO_EQUILIBRIUM",
          `critical equilibrium needs rho = 0 (rho = ${rho.toPrecision(6)})`,
        );
      }
    } else if (power.mode !== "given") {
      throw new InitError("E_INIT_INVALID", `unknown power mode '${power.mode}'`);
    }
    y[IP] = p0;

    const prec = init.precursors ?? "equilibrium";
    if (prec === "equilibrium") {
      for (let i = 0; i < 6; i++) {
        y[IC0 + i] = (mdl.beta[i]! * p0) / (L * mdl.lam[i]!);
      }
    } else {
      if (!Array.isArray(prec) || prec.length !== 6 || prec.some((c: number) => c < 0)) {
        throw new InitError("E_INIT_INVALID", "precursors must be 'equilibrium' or six values >= 0");
      }
      for (let i = 0; i < 6; i++) {
        y[IC0 + i] = Number(prec[i]);
      }
    }
    for (const ins of this.lagged) {
      y[this.lagIndex[ins.id]!] = this._truthSignal(ins.signal, 0.0, y);
    }
  }

  rodPosition(rid: string, t: number): number {
    const m = this.motions[rid]!;
    const k = m.kind;
    if (k === "still") {
      return m.x0;
    }
    if (k === "move") {
      return Math.min(1.0, Math.max(0.0, m.x0 + m.v * (t - m.t0)));
    }
    const rod = this.model.rodById[rid]!;
    if (k === "fire") {
      return Math.min(1.0, m.x0 + (t - m.t0) / rod.fireTime!);
    }
    if (k === "scram") {
      return rod.scramPosition(m.tau0 + (t - m.t0));
    }
    throw new Error(k);
  }

  private _rebaseRods(t: number): void {
    for (const [rid, m] of Object.entries(this.motions)) {
      if (m.kind === "still") {
        continue;
      }
      const rod = this.model.rodById[rid]!;
      const x = this.rodPosition(rid, t);
      if (m.kind === "scram") {
        const tau = m.tau0 + (t - m.t0);
        this.motions[rid] =
          tau >= rod.scramT[rod.scramT.length - 1]!
            ? { kind: "still", t0: t, x0: 0.0 }
            : { kind: "scram", t0: t, tau0: tau };
      } else if ((m.kind === "move" && (x <= 0.0 || x >= 1.0)) || (m.kind === "fire" && x >= 1.0)) {
        this.motions[rid] = { kind: "still", t0: t, x0: x };
      } else {
        this.motions[rid] = { ...m, t0: t, x0: x };
      }
    }
  }

  private _scramAll(t: number): void {
    for (const rid of Object.keys(this.motions)) {
      const x = this.rodPosition(rid, t);
      if (x <= 0.0) {
        this.motions[rid] = { kind: "still", t0: t, x0: 0.0 };
      } else {
        this.motions[rid] = { kind: "scram", t0: t, tau0: this.model.rodById[rid]!.scramTau(x) };
      }
    }
  }

  reactivity(t: number, y: number[]): Record<string, any> {
    const mdl = this.model;
    let rods = 0.0;
    for (const r of mdl.rods) {
      rods += r.worth.at(this.rodPosition(r.id, t));
    }
    const fuel = mdl.fuelTemp.at(y[ITF]!);
    const cool = mdl.coolTemp.at(y[ITC]!);
    const xe = mdl.xenon.at(y[IX]!);
    const base = mdl.refRho + mdl.calibration;
    return {
      total: base + this.extraRho + rods + fuel + cool + xe,
      reference: mdl.refRho,
      calibration: mdl.calibration,
      fault: this.extraRho,
      rods,
      fuel,
      coolant: cool,
      xenon: xe,
    };
  }

  rhs(t: number, y: number[]): number[] {
    this.diag.rhsCalls += 1;
    const mdl = this.model;
    const P = y[IP]!;
    const tf = y[ITF]!;
    const tc = y[ITC]!;
    const i_ = y[II]!;
    const x_ = y[IX]!;

    let rho = mdl.refRho + mdl.calibration + this.extraRho;
    for (const r of mdl.rods) {
      rho += r.worth.at(this.rodPosition(r.id, t));
    }
    rho += mdl.fuelTemp.at(tf) + mdl.coolTemp.at(tc) + mdl.xenon.at(x_);

    const L = mdl.genTime;
    const d = new Array<number>(y.length).fill(0.0);
    d[IP] = ((rho - mdl.betaTotal) / L) * P + mdl.extSource;
    for (let k = 0; k < 6; k++) {
      const c = y[IC0 + k]!;
      d[IP] += mdl.lam[k]! * c;
      d[IC0 + k] = (mdl.beta[k]! / L) * P - mdl.lam[k]! * c;
    }
    const q_hx =
      mdl.hxPump !== null && Object.hasOwn(this.pumps, mdl.hxPump) && this.pumps[mdl.hxPump]
        ? mdl.UA * (tc - mdl.sinkTemp)
        : 0.0;
    const q_fc = mdl.hA * (tf - tc);
    d[ITF] = (mdl.fuelFraction * P - q_fc) / (mdl.fuelMass * mdl.fuelCp.at(tf));
    d[ITC] = ((1.0 - mdl.fuelFraction) * P + q_fc - q_hx) / (mdl.coolMass * mdl.coolCp);
    const phi = mdl.fluxPerWatt * P;
    d[II] = mdl.gammaI * mdl.sigmaF * phi - mdl.lambdaI * i_;
    d[IX] = mdl.gammaX * mdl.sigmaF * phi + mdl.lambdaI * i_ - mdl.lambdaX * x_ - mdl.sigmaX * phi * x_;
    d[IEP] = P;
    d[IEH] = q_hx;
    for (const ins of this.lagged) {
      const j = this.lagIndex[ins.id]!;
      d[j] = (this._truthSignal(ins.signal, t, y) - y[j]!) / ins.lag;
    }
    return d;
  }

  _truthSignal(sig: string, t: number, y: number[]): any {
    const name = sig.slice("truth.".length);
    if (name === "power") return y[IP]!;
    if (name === "fuelTemp") return y[ITF]!;
    if (name === "coolantTemp") return y[ITC]!;
    if (name === "xenon") return y[IX]!;
    if (name === "mode") return this.mode;
    if (name === "period") {
      const dp = this.rhs(t, y)[IP]!;
      return dp === 0.0 ? Infinity : y[IP]! / dp;
    }
    if (name.startsWith("rod.")) {
      return this.rodPosition(name.slice(4), t);
    }
    throw new Error(`unknown truth signal: ${sig}`);
  }

  _signal(sig: string, t: number, y: number[]): any {
    if (sig.startsWith("indicated.")) {
      const name = sig.slice("indicated.".length);
      return Object.hasOwn(this.indicated, name) ? this.indicated[name] : undefined;
    }
    return this._truthSignal(sig, t, y);
  }

  _scales(y: number[]): number[] {
    const s = new Array<number>(y.length).fill(1e-12);
    s[ITF] = s[ITC] = 1e-6;
    s[II] = s[IX] = 1e8;
    s[IEP] = s[IEH] = 1e-6;
    for (const ins of this.lagged) {
      const name = ins.signal.slice(6);
      const scaleMap: Record<string, number> = {
        power: 1e-12,
        fuelTemp: 1e-6,
        coolantTemp: 1e-6,
        xenon: 1e8,
      };
      s[this.lagIndex[ins.id]!] = scaleMap[name]!;
    }
    return s;
  }

  _jacobian(t: number, y: number[], f0: number[]): [number[][], number[]] {
    const n = y.length;
    const floor = new Array<number>(n).fill(1e-6);
    floor[ITF] = floor[ITC] = 1.0;
    floor[II] = floor[IX] = 1e12;
    floor[IEP] = floor[IEH] = 1.0;

    const cols: number[][] = [];
    for (let j = 0; j < n; j++) {
      const dj = 1e-7 * Math.max(Math.abs(y[j]!), floor[j]!);
      const yj = [...y];
      yj[j]! += dj;
      const fj = this.rhs(t, yj);
      const col = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        col[i] = (fj[i]! - f0[i]!) / dj;
      }
      cols.push(col);
    }

    const J: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => cols[j]![i]!),
    );

    const dt = 1e-7 * Math.max(1.0, Math.abs(t));
    const f_t = this.rhs(t + dt, y);
    const ft = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      ft[i] = (f_t[i]! - f0[i]!) / dt;
    }
    return [J, ft];
  }

  _ros2(
    t: number,
    y: number[],
    h: number,
    J: number[][],
    f0: number[],
    ft: number[],
  ): [number[], number] {
    const n = y.length;
    const M: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1.0 : 0.0) - GAMMA * h * J[i]![j]!),
    );
    const lu = luFactor(M);

    const rhs1 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rhs1[i] = f0[i]! + GAMMA * h * ft[i]!;
    }
    const k1 = luSolve(lu, rhs1);

    const y1 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      y1[i] = y[i]! + h * k1[i]!;
    }
    const f1 = this.rhs(t + h, y1);

    const rhs2 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rhs2[i] = f1[i]! - GAMMA * h * ft[i]! - 2.0 * k1[i]!;
    }
    const k2 = luSolve(lu, rhs2);

    const yNew = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      yNew[i] = y[i]! + 1.5 * h * k1[i]! + 0.5 * h * k2[i]!;
    }

    const atol = this._scales(y);
    const rtol = this.config.rtol;
    let acc = 0.0;
    for (let i = 0; i < n; i++) {
      const e = 0.5 * h * (k1[i]! + k2[i]!);
      const sc = atol[i]! + rtol * Math.max(Math.abs(y[i]!), Math.abs(yNew[i]!));
      const r = e / sc;
      acc += r * r;
    }
    return [yNew, Math.sqrt(acc / n)];
  }

  _ros3p(
    t: number,
    y: number[],
    h: number,
    J: number[][],
    f0: number[],
    ft: number[],
  ): [number[], number] {
    const n = y.length;
    const invHGamma = 1.0 / (h * ros3pCoeffs.gamma);
    const M: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? invHGamma : 0.0) - J[i]![j]!),
    );
    const lu = luFactor(M);

    // Stage 1: alpha1 = 0.0, no prior stages
    const rhs1 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rhs1[i] = f0[i]! + h * ros3pCoeffs.gamma1 * ft[i]!;
    }
    const u1 = luSolve(lu, rhs1);

    // Stage 2: alpha2 = 1.0
    const yStage2 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      yStage2[i] = y[i]! + ros3pCoeffs.a21 * u1[i]!;
    }
    const fStage2 = this.rhs(t + h, yStage2);
    const rhs2 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rhs2[i] = fStage2[i]! + (ros3pCoeffs.c21 / h) * u1[i]! + h * ros3pCoeffs.gamma2 * ft[i]!;
    }
    const u2 = luSolve(lu, rhs2);

    // Stage 3: alpha3 = 1.0, a31 = a21, a32 = 0.0
    const rhs3 = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      rhs3[i] =
        fStage2[i]! +
        (ros3pCoeffs.c31 / h) * u1[i]! +
        (ros3pCoeffs.c32 / h) * u2[i]! +
        h * ros3pCoeffs.gamma3 * ft[i]!;
    }
    const u3 = luSolve(lu, rhs3);

    const yNew = new Array<number>(n);
    const yHat = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      yNew[i] =
        y[i]! +
        ros3pCoeffs.m1 * u1[i]! +
        ros3pCoeffs.m2 * u2[i]! +
        ros3pCoeffs.m3 * u3[i]!;
      yHat[i] =
        y[i]! +
        ros3pCoeffs.mhat1 * u1[i]! +
        ros3pCoeffs.mhat2 * u2[i]! +
        ros3pCoeffs.mhat3 * u3[i]!;
    }

    const atol = this._scales(y);
    const rtol = this.config.rtol;
    let acc = 0.0;
    for (let i = 0; i < n; i++) {
      const e = yNew[i]! - yHat[i]!;
      const sc = atol[i]! + rtol * Math.max(Math.abs(y[i]!), Math.abs(yNew[i]!));
      const r = e / sc;
      acc += r * r;
    }
    return [yNew, Math.sqrt(acc / n)];
  }

  private _integrate(t0: number, t1: number): void {
    let y = this.y;
    let h = this.h;
    let t = t0;
    while (t1 - t > 1e-12 * this.config.outerDt) {
      const f0 = this.rhs(t, y);
      const [J, ft] = this._jacobian(t, y, f0);
      let truncated = h >= t1 - t;
      let hs = truncated ? t1 - t : h;
      let yNew: number[];
      let err: number;
      while (true) {
        [yNew, err] = this._stepper(t, y, hs, J, f0, ft);
        if (err <= 1.0 && yNew[IP]! >= 0.0) {
          break;
        }
        this.diag.rejected += 1;
        hs *= yNew[IP]! < 0.0 ? 0.25 : Math.max(0.2, this._stepFac(err));
        truncated = false;
        if (hs < this.config.hMin) {
          throw new SolverError(`step size underflow at t = ${t.toPrecision(9)}`);
        }
      }
      const fac = Math.min(4.0, Math.max(0.2, this._stepFac(Math.max(err, 1e-10))));
      let tNew = truncated ? t1 : t + hs;
      [tNew, yNew] = this._locateTrips(t, y, hs, tNew, yNew, J, f0, ft);
      h = truncated ? Math.max(h, hs * fac) : hs * fac;
      t = tNew;
      y = yNew;
      this.diag.steps += 1;
      if (y[IP]! > this.peakPower) {
        this.peakPower = y[IP]!;
        this.peakTime = t;
      }
    }
    this.y = y;
    this.h = h;
  }

  private _leafG(leaf: PredLeaf, t: number, y: number[]): number | null {
    const [sig, useAbs, ref] = leaf;
    const v = this._truthSignal(sig, t, y);
    if (v === null || typeof v === "string") {
      return null;
    }
    return (useAbs ? Math.abs(v) : v) - ref;
  }

  private _bisect(
    t: number,
    y: number[],
    hs: number,
    J: number[][],
    f0: number[],
    ft: number[],
    crossed: (s: number, ys: number[]) => boolean,
    yEnd: number[],
  ): [number, number[]] {
    let lo = 0.0;
    let hi = hs;
    let yHi = yEnd;
    while (hi - lo > this.config.eventTol) {
      const mid = 0.5 * (lo + hi);
      const [yMid] = this._stepper(t, y, mid, J, f0, ft);
      if (crossed(mid, yMid)) {
        hi = mid;
        yHi = yMid;
      } else {
        lo = mid;
      }
    }
    return [hi, yHi];
  }

  private _locateTrips(
    t: number,
    y: number[],
    hs: number,
    tNew: number,
    yNew: number[],
    J: number[][],
    f0: number[],
    ft: number[],
  ): [number, number[]] {
    const cands = this.locatedTrips.filter(
      (tr) =>
        !this.latched.includes(tr.id) &&
        !this.activeTrips.includes(tr.id) &&
        this._tripModeOk(tr),
    );
    if (cands.length === 0) {
      return [tNew, yNew];
    }
    let best: [number, number[]] | null = null;
    for (const tr of cands) {
      const pred = tr.predicate;
      const inp = tr.input;
      const holds = (s: number, ys: number[]) =>
        evalPredicate(pred, (sig: string) => this._truthSignal(sig, t + s, ys), inp);
      const hits: [number, number[]][] = [];
      for (const leaf of predLeaves(pred, inp)) {
        const g0 = this._leafG(leaf, t, y);
        const g1 = this._leafG(leaf, tNew, yNew);
        if (g0 === null || g1 === null || sign(g0) === sign(g1)) {
          continue;
        }
        const s0 = sign(g0);
        const [s, ys] = this._bisect(
          t,
          y,
          hs,
          J,
          f0,
          ft,
          (stepS, stepYs) => {
            const g = this._leafG(leaf, t + stepS, stepYs);
            return g !== null && sign(g) !== s0;
          },
          yNew,
        );
        if (holds(s, ys)) {
          hits.push([s, ys]);
        }
      }
      if (hits.length === 0 && holds(hs, yNew)) {
        hits.push(this._bisect(t, y, hs, J, f0, ft, holds, yNew));
      }
      for (const h of hits) {
        if (best === null || h[0] < best[0]) {
          best = h;
        }
      }
    }
    if (best === null) {
      return [tNew, yNew];
    }
    const [sEv, yEv] = best;
    const tEv = t + sEv;
    const getEv = (sig: string) => this._truthSignal(sig, tEv, yEv);
    for (const tr of cands) {
      if (evalPredicate(tr.predicate, getEv, tr.input)) {
        this._trip(tr, tEv);
      }
    }
    return [tEv, yEv];
  }

  private _tripModeOk(trip: any): boolean {
    return !Object.hasOwn(trip, "modes") || trip.modes.includes(this.mode);
  }

  private _trip(trip: any, t: number): void {
    this.events.push({ type: "trip", id: trip.id, t });
    if (trip.latching) {
      this.latched.push(trip.id);
    } else {
      this.activeTrips.push(trip.id);
    }
    this._scramAll(t);
  }

  private _sampleInstruments(t: number): void {
    for (const ins of this.model.instruments) {
      const z = this.rng.normal(); // always drawn
      const iid = ins.id;
      let v: number;
      if (Object.hasOwn(this.lagIndex, iid)) {
        v = this.y[this.lagIndex[iid]!]!;
      } else {
        v = this._truthSignal(ins.signal, t, this.y);
      }
      const fault = Object.hasOwn(this.faults, iid) ? this.faults[iid] : undefined;
      if (fault === "dead") {
        this.indicated[iid] = null;
        continue;
      }
      if (fault === "stuck" && Object.hasOwn(this.indicated, iid)) {
        continue;
      }
      v = v * (1.0 + ins.noise * z);
      const [low, high] = ins.range;
      this.indicated[iid] = Math.min(high, Math.max(low, v));
    }
  }

  private _boundary(first = false): void {
    const t = this.t;
    this._rebaseRods(t);
    this._sampleInstruments(t);
    const get = (s: string) => this._signal(s, t, this.y);

    // non-latching trips clear when their condition clears
    const active = [...this.activeTrips];
    for (const tid of active) {
      const tr = this.model.trips.find((x: any) => x.id === tid);
      if (tr && !evalPredicate(tr.predicate, get, tr.input)) {
        this.activeTrips = this.activeTrips.filter((x) => x !== tid);
      }
    }

    const checkTrips = this.boundaryTrips.concat(first ? this.locatedTrips : []);
    for (const tr of checkTrips) {
      if (
        this.latched.includes(tr.id) ||
        this.activeTrips.includes(tr.id) ||
        !this._tripModeOk(tr)
      ) {
        continue;
      }
      if (evalPredicate(tr.predicate, get, tr.input)) {
        this._trip(tr, t);
      }
    }
    this._checkRejectTables();
  }

  private _checkRejectTables(): void {
    const mdl = this.model;
    const checks: [Table, number, string][] = [
      [mdl.fuelTemp, this.y[ITF]!, "fuelTemp"],
      [mdl.coolTemp, this.y[ITC]!, "coolantTemp"],
      [mdl.xenon, this.y[IX]!, "xenon"],
      [mdl.fuelCp, this.y[ITF]!, "fuelCp"],
    ];
    for (const r of mdl.rods) {
      checks.push([r.worth, this.rodPosition(r.id, this.t), `rod.${r.id}`]);
    }
    for (const [table, x, name] of checks) {
      if (table.outOfRange === "reject" && table.value(x)[1]) {
        this.halted = `R_TABLE_REJECT_${name}`;
        this.events.push({ type: "halt", t: this.t, reason: this.halted });
      }
    }
  }

  submit(cmd: Record<string, any>, clientId = "local"): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const entry = {
      seq,
      step: this.stepIndex,
      t: this.t,
      clientId,
      cmd: structuredClone(cmd),
    };
    this.commandLog.push(entry);
    this.pending.push(entry);
    return seq;
  }

  private _interlockBlock(ctype: string): any {
    const get = (s: string) => this._signal(s, this.t, this.y);
    for (const il of this.model.interlocks) {
      if (il.blocks.includes(ctype) && evalPredicate(il.when, get)) {
        return il;
      }
    }
    return null;
  }

  private _apply(entry: any): void {
    const cmd = entry.cmd;
    const t = this.t;
    let status = "accepted";
    let reason: string | null = null;
    const ctype = cmd.type;
    const tripped = Boolean(this.latched.length > 0 || this.activeTrips.length > 0);
    const il = typeof ctype === "string" ? this._interlockBlock(ctype) : null;

    if (ctype === "rod.move") {
      const rid = cmd.rod;
      const direction = cmd.direction;
      if (typeof rid !== "string" || !Object.hasOwn(this.motions, rid)) {
        status = "rejected";
        reason = "REJ_UNKNOWN_ROD";
      } else if (direction !== "in" && direction !== "out" && direction !== "stop") {
        status = "rejected";
        reason = "REJ_BAD_ARGUMENT";
      } else if (il) {
        status = "rejected";
        reason = `REJ_INTERLOCK:${il.id}`;
      } else if (direction === "out" && tripped) {
        status = "rejected";
        reason = "REJ_TRIPPED";
      } else if (this.motions[rid]!.kind === "scram") {
        // any drive command, even "in", would replace the scram profile with the slower drive (M1 review finding 1)
        status = "rejected";
        reason = "REJ_SCRAM_IN_PROGRESS";
      } else {
        const x = this.rodPosition(rid, t);
        if (direction === "stop") {
          this.motions[rid] = { kind: "still", t0: t, x0: x };
        } else {
          const v = this.model.rodById[rid]!.speed * (direction === "out" ? 1.0 : -1.0);
          this.motions[rid] = { kind: "move", t0: t, x0: x, v };
        }
      }
    } else if (ctype === "rod.fire") {
      const rid = cmd.rod;
      if (typeof rid !== "string" || !Object.hasOwn(this.motions, rid)) {
        status = "rejected";
        reason = "REJ_UNKNOWN_ROD";
      } else if (!this.model.rodById[rid]!.pulseCapable) {
        status = "rejected";
        reason = "REJ_NOT_PULSE_CAPABLE";
      } else if (il) {
        status = "rejected";
        reason = `REJ_INTERLOCK:${il.id}`;
      } else if (tripped) {
        status = "rejected";
        reason = "REJ_TRIPPED";
      } else {
        this.motions[rid] = { kind: "fire", t0: t, x0: this.rodPosition(rid, t) };
      }
    } else if (ctype === "mode.set") {
      const mode = cmd.mode;
      if (typeof mode !== "string" || !this.model.modes.includes(mode)) {
        status = "rejected";
        reason = "REJ_UNKNOWN_MODE";
      } else if (il) {
        status = "rejected";
        reason = `REJ_INTERLOCK:${il.id}`;
      } else {
        this.mode = mode;
      }
    } else if (ctype === "pump.set") {
      const pump = cmd.pump;
      if (typeof pump !== "string" || !Object.hasOwn(this.pumps, pump)) {
        status = "rejected";
        reason = "REJ_UNKNOWN_PUMP";
      } else if (il) {
        status = "rejected";
        reason = `REJ_INTERLOCK:${il.id}`;
      } else {
        this.pumps[pump] = Boolean(cmd.on);
      }
    } else if (ctype === "scram") {
      if (!this.latched.includes("manual")) {
        this.latched.push("manual");
      }
      this._scramAll(t);
      this.events.push({ type: "trip", id: "manual", t });
    } else if (ctype === "trip.reset") {
      const get = (s: string) => this._signal(s, t, this.y);
      const still = this.latched.filter((tid) => {
        if (tid === "manual") return false;
        const tr = this.model.trips.find((x: any) => x.id === tid)!;
        return evalPredicate(tr.predicate, get, tr.input);
      });
      if (still.length > 0) {
        status = "rejected";
        reason = `REJ_TRIP_ACTIVE:${still.join(",")}`;
      } else {
        this.latched = [];
      }
    } else if (ctype === "fault.reactivity") {
      this.extraRho += Number(cmd.deltaRho ?? 0.0);
    } else if (ctype === "fault.instrument") {
      const iid = cmd.instrument;
      const kind = cmd.kind;
      if (typeof iid !== "string" || !this.model.instruments.some((i: any) => i.id === iid)) {
        status = "rejected";
        reason = "REJ_UNKNOWN_INSTRUMENT";
      } else if (kind === "clear") {
        delete this.faults[iid];
      } else if (kind === "stuck" || kind === "dead") {
        this.faults[iid] = kind;
      } else {
        status = "rejected";
        reason = "REJ_BAD_ARGUMENT";
      }
    } else {
      status = "rejected";
      reason = "REJ_UNKNOWN_COMMAND";
    }

    this.events.push({
      type: "command",
      seq: entry.seq,
      clientId: entry.clientId,
      t,
      status,
      reason,
    });
  }

  get t(): number {
    return this.stepIndex * this.config.outerDt;
  }

  step(): void {
    if (this.halted) {
      return;
    }
    const queue = [...this.pending].sort((a, b) => a.seq - b.seq);
    this.pending = [];
    for (const c of queue) {
      this._apply(c);
    }
    const t0 = this.t;
    const t1 = (this.stepIndex + 1) * this.config.outerDt;
    this._integrate(t0, t1);
    this.stepIndex += 1;
    this._boundary();
  }

  advance(seconds: number): void {
    const n = roundHalfEven(seconds / this.config.outerDt);
    for (let i = 0; i < n; i++) {
      this.step();
    }
  }

  validity(): Record<string, any> {
    const mdl = this.model;
    const dom = this.model.validity;
    const out: string[] = [];
    const reasons: string[] = [];
    if (dom === null) {
      // params without a validity section claim no domain
      reasons.push("R_PARAMS_UNVALIDATED");
    } else {
      if (dom.status !== "validated-for-domain") {
        reasons.push("R_LIBRARY_" + dom.status.toUpperCase().replace(/-/g, "_"));
      }
      for (const r of mdl.rods) {
        const [lo, hi] = dom.rods[r.id]!;
        const pos = this.rodPosition(r.id, this.t);
        if (!(lo! <= pos && pos <= hi!)) {
          out.push(`R_DOMAIN_ROD_${r.id}`);
        }
      }
      const checks: [string, number[], number][] = [
        ["TFUEL", dom.Tfuel, this.y[ITF]!],
        ["TCOOLANT", dom.Tcoolant, this.y[ITC]!],
        ["XENON", dom.xenon, this.y[IX]!],
      ];
      for (const [name, [lo, hi], val] of checks) {
        if (!(lo! <= val && val <= hi!)) {
          out.push(`R_DOMAIN_${name}`);
        }
      }

      const moved: Record<string, number> = {};
      for (const r of mdl.rods) {
        const pos = this.rodPosition(r.id, this.t);
        if (Math.abs(pos - mdl.refRods[r.id]!) > 1e-9) {
          moved[r.id] = pos;
        }
      }
      if (Object.keys(moved).length >= 2) {
        const covered = dom.jointChecked.some((jc) =>
          mdl.rods.every((r) => {
            const refPos = Object.hasOwn(jc.rods, r.id) ? jc.rods[r.id]! : mdl.refRods[r.id]!;
            return Math.abs(refPos - this.rodPosition(r.id, this.t)) <= 0.05;
          }),
        );
        if (!covered) {
          reasons.push("R_JOINT_UNCHECKED");
        }
      }
    }
    if (this.halted) {
      out.push(this.halted);
    }
    const status = out.length > 0 ? "outOfDomain" : reasons.length > 0 ? "unvalidated" : "supported";
    return { status, reasons: [...out, ...reasons] };
  }

  shape(): number[] {
    const s = this.model.shape;
    if (s === null) {
      throw new Error("these params have no shape section");
    }
    const n = s.elements.length * (s.axialEdgesCm.length - 1);
    const out = [...s.base];

    const add = (grid: number[], arr: number[], x: number) => {
      x = Math.min(grid[grid.length - 1]!, Math.max(grid[0]!, x));
      let k = 0;
      while (k < grid.length - 2 && x > grid[k + 1]!) {
        k++;
      }
      const w = (x - grid[k]!) / (grid[k + 1]! - grid[k]!);
      const a = arr.slice(k * n, (k + 1) * n);
      const b = arr.slice((k + 1) * n, (k + 2) * n);
      for (let j = 0; j < n; j++) {
        out[j] = out[j]! + (1 - w) * a[j]! + w * b[j]!;
      }
    };

    for (const [rid, d] of Object.entries(s.rodDeltas)) {
      add(d.x, d.values, this.rodPosition(rid, this.t));
    }
    add(s.tempDelta.x, s.tempDelta.values, this.y[ITF]!);
    return out;
  }

  snapshot(includeShape = false): Record<string, any> {
    const t = this.t;
    const y = this.y;
    const rods: Record<string, any> = {};
    for (const [rid, m] of Object.entries(this.motions)) {
      let moving: "in" | "out" | null = null;
      if (m.kind === "move") {
        moving = (m.v ?? 0) > 0 ? "out" : "in";
      } else if (m.kind === "fire") {
        moving = "out";
      } else if (m.kind === "scram") {
        moving = "in";
      }
      rods[rid] = {
        position: this.rodPosition(rid, t),
        moving,
      };
    }

    const snap: Record<string, any> = {
      t,
      truth: {
        power: y[IP]!,
        precursors: y.slice(IC0, IC0 + 6),
        reactivity: this.reactivity(t, y),
        period: this._truthSignal("truth.period", t, y),
        fuelTemp: y[ITF]!,
        coolantTemp: y[ITC]!,
        iodine: y[II]!,
        xenon: y[IX]!,
        energy: y[IEP]!,
        heatRemoved: y[IEH]!,
        peakPower: this.peakPower,
        peakTime: this.peakTime,
        rods,
        mode: this.mode,
        pumps: { ...this.pumps },
      },
      indicated: { ...this.indicated },
      trips: { latched: [...this.latched], active: [...this.activeTrips] },
      tripped: Boolean(this.latched.length > 0 || this.activeTrips.length > 0),
      validity: this.validity(),
      diagnostics: { ...this.diag, events: this.events.length, h: this.h },
    };
    if (includeShape) {
      snap.truth.shape = this.shape();
    }
    return snap;
  }

  pins(): Record<string, any> {
    const cfg = { ...this.config };
    return {
      engineVersion: ENGINE_VERSION,
      paramsDigest: this.digest,
      config: cfg,
    };
  }

  checkpoint(): Record<string, any> {
    return {
      pins: this.pins(),
      seed: this.seed,
      init: structuredClone(this.initSpec),
      stepIndex: this.stepIndex,
      y: [...this.y],
      h: this.h,
      motions: structuredClone(this.motions),
      mode: this.mode,
      pumps: { ...this.pumps },
      latched: [...this.latched],
      activeTrips: [...this.activeTrips],
      faults: { ...this.faults },
      indicated: { ...this.indicated },
      rng: this.rng.state.toString(16).padStart(16, "0"),
      extraRho: this.extraRho,
      pending: structuredClone(this.pending),
      nextSeq: this.nextSeq,
      peak: [this.peakPower, this.peakTime],
      halted: this.halted,
      commandLog: structuredClone(this.commandLog),
      eventCount: this.events.length,
    };
  }

  static restore(params: ReactorParams, cp: Record<string, any>): Engine {
    const pins = cp.pins;
    if (pins.engineVersion !== ENGINE_VERSION) {
      throw new CheckpointError(
        `checkpoint from engine ${pins.engineVersion}, this is ${ENGINE_VERSION}`,
      );
    }
    if (pins.paramsDigest !== paramsDigest(params)) {
      throw new CheckpointError("params digest doesn't match the checkpoint");
    }
    const e = new Engine(params, cp.init, cp.seed, pins.config);
    e.stepIndex = cp.stepIndex;
    e.y = [...cp.y];
    e.h = cp.h;
    e.motions = structuredClone(cp.motions);
    e.mode = cp.mode;
    e.pumps = { ...cp.pumps };
    e.latched = [...cp.latched];
    e.activeTrips = [...cp.activeTrips];
    e.faults = { ...cp.faults };
    e.indicated = { ...cp.indicated };
    e.rng.state = BigInt("0x" + cp.rng) & MASK64;
    e.extraRho = cp.extraRho;
    e.pending = structuredClone(cp.pending);
    e.nextSeq = cp.nextSeq;
    e.peakPower = cp.peak[0];
    e.peakTime = cp.peak[1];
    e.halted = cp.halted;
    e.commandLog = structuredClone(cp.commandLog);
    e.events = [{ type: "restored", t: e.t, eventCount: cp.eventCount }];
    e.diag = { steps: 0, rejected: 0, rhsCalls: 0 };
    return e;
  }

  session(): Record<string, any> {
    return {
      pins: this.pins(),
      seed: this.seed,
      init: structuredClone(this.initSpec),
      commands: structuredClone(this.commandLog),
    };
  }

  static replay(params: ReactorParams, session: Record<string, any>, untilStep: number): Engine {
    const pins = session.pins;
    if (pins.engineVersion !== ENGINE_VERSION || pins.paramsDigest !== paramsDigest(params)) {
      throw new CheckpointError("session pins don't match this engine and params");
    }
    const e = new Engine(params, session.init, session.seed, pins.config);
    const cmds = [...session.commands].sort((a, b) => a.seq - b.seq);
    let k = 0;
    while (e.stepIndex < untilStep) {
      while (k < cmds.length && cmds[k].step === e.stepIndex) {
        e.submit(cmds[k].cmd, cmds[k].clientId);
        k++;
      }
      if (e.halted) {
        return e;
      }
      e.step();
    }
    while (k < cmds.length && cmds[k].step === e.stepIndex) {
      e.submit(cmds[k].cmd, cmds[k].clientId);
      k++;
    }
    return e;
  }
}
