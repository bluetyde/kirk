/**
 * Small portable numerics: a seeded generator and a dense linear solver.
 *
 * Ported line for line from kirk/numerics.py.
 */

export const MASK64 = (1n << 64n) - 1n;

export class SplitMix64 {
  private _state: bigint;

  constructor(seed: number | bigint) {
    this._state = BigInt(seed) & MASK64;
  }

  get state(): bigint {
    return this._state;
  }

  set state(value: number | bigint) {
    this._state = BigInt(value) & MASK64;
  }

  nextU64(): bigint {
    this._state = (this._state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this._state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  uniform(): number {
    const u = this.nextU64();
    return (Number(u >> 11n) + 0.5) / 9007199254740992.0;
  }

  normal(): number {
    const u1 = this.uniform();
    const u2 = this.uniform();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }
}

export function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let maxVal = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(m[r]![col]!);
      if (val > maxVal) {
        maxVal = val;
        piv = r;
      }
    }
    if (m[piv]![col] === 0.0) {
      throw new Error("singular matrix");
    }
    if (piv !== col) {
      const tmp = m[col]!;
      m[col] = m[piv]!;
      m[piv] = tmp;
    }
    const pivotRow = m[col]!;
    const inv = 1.0 / pivotRow[col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! * inv;
      if (factor !== 0.0) {
        const row = m[r]!;
        for (let c = col; c <= n; c++) {
          row[c]! -= factor * pivotRow[c]!;
        }
      }
    }
  }
  const x = new Array<number>(n).fill(0.0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let c = r + 1; c < n; c++) {
      s -= m[r]![c]! * x[c]!;
    }
    x[r] = s / m[r]![r]!;
  }
  return x;
}

export type LUFactored = [lu: number[][], perm: number[]];

export function luFactor(a: number[][]): LUFactored {
  const n = a.length;
  const lu = a.map((row) => [...row]);
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let col = 0; col < n; col++) {
    let piv = col;
    let maxVal = Math.abs(lu[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(lu[r]![col]!);
      if (val > maxVal) {
        maxVal = val;
        piv = r;
      }
    }
    if (lu[piv]![col] === 0.0) {
      throw new Error("singular matrix");
    }
    if (piv !== col) {
      const tmpLu = lu[col]!;
      lu[col] = lu[piv]!;
      lu[piv] = tmpLu;
      const tmpP = perm[col]!;
      perm[col] = perm[piv]!;
      perm[piv] = tmpP;
    }
    const inv = 1.0 / lu[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      lu[r]![col]! *= inv;
      const f = lu[r]![col]!;
      if (f !== 0.0) {
        const rr = lu[r]!;
        const rc = lu[col]!;
        for (let c = col + 1; c < n; c++) {
          rr[c]! -= f * rc[c]!;
        }
      }
    }
  }
  return [lu, perm];
}

export function luSolve(factored: LUFactored, b: number[]): number[] {
  const [lu, perm] = factored;
  const n = b.length;
  const y = Array.from({ length: n }, (_, i) => b[perm[i]!]!);
  for (let i = 0; i < n; i++) {
    const row = lu[i]!;
    let acc = 0.0;
    for (let j = 0; j < i; j++) {
      acc += row[j]! * y[j]!;
    }
    y[i]! -= acc;
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = lu[i]!;
    let acc = 0.0;
    for (let j = i + 1; j < n; j++) {
      acc += row[j]! * y[j]!;
    }
    y[i] = (y[i]! - acc) / row[i]!;
  }
  return y;
}
