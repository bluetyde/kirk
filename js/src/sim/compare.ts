/**
 * Tolerant comparison for engine golden vectors.
 *
 * Ported from tests/test_vectors.py (_compare).
 */

export const CATEGORY: Record<string, string> = {
  power: "power",
  precursors: "power",
  energy: "power",
  peakPower: "power",
  fuelTemp: "temperature",
  coolantTemp: "temperature",
  iodine: "poisons",
  xenon: "poisons",
  t: "eventTime",
  peakTime: "eventTime",
};

export const DEFAULT_TOL = { rel: 1e-9, abs: 1e-12 };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function compareInner(
  a: unknown,
  b: unknown,
  tol: Record<string, { rel?: number; abs?: number }>,
  path: string,
  problems: string[],
  key?: string,
): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length || !aKeys.every((k, i) => k === bKeys[i])) {
      problems.push(`${path}: keys differ`);
      return;
    }
    for (const k of aKeys) {
      compareInner(a[k], b[k], tol, `${path}.${k}`, problems, k);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      problems.push(`${path}: length ${a.length} != ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      compareInner(a[i], b[i], tol, `${path}[${i}]`, problems, key);
    }
  } else if (typeof a === "number" || typeof b === "number") {
    if (
      typeof a !== "number" ||
      typeof b !== "number" ||
      typeof a === "boolean" ||
      typeof b === "boolean"
    ) {
      problems.push(`${path}: type differs`);
      return;
    }
    const cat = key ? CATEGORY[key] : undefined;
    const t = cat && tol[cat] ? tol[cat] : DEFAULT_TOL;
    const absTol = t.abs ?? 0.0;
    const relTol = t.rel ?? 0.0;
    const limit = absTol + relTol * Math.max(Math.abs(a), Math.abs(b));
    if (Math.abs(a - b) > limit) {
      problems.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)} (limit ${limit.toPrecision(3)})`);
    }
  } else if (a !== b || typeof a !== typeof b) {
    problems.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}

export function compareDocs(
  a: unknown,
  b: unknown,
  tol: Record<string, { rel?: number; abs?: number }>,
  path = "$",
): string[] {
  const problems: string[] = [];
  compareInner(a, b, tol, path, problems);
  return problems;
}
