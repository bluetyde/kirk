/**
 * Validation for reactor engine commands and snapshots.
 *
 * Ported from pipeline/contracts/validate.py.
 */

import { commandSchema, snapshotSchema } from "../schemas.js";
import { Validator } from "../library/minischema.js";
import type { Issue } from "../library/validate.js";

const commandValidator = new Validator(commandSchema);
const snapshotValidator = new Validator(snapshotSchema);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Return a deep copy where every non-finite float (NaN, ±inf) becomes null. */
export function jsonForm<T>(obj: T): T {
  if (typeof obj === "boolean") {
    return obj;
  }
  if (typeof obj === "number") {
    return (Number.isFinite(obj) ? obj : null) as unknown as T;
  }
  if (typeof obj === "string" || obj === null || obj === undefined) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => jsonForm(item)) as unknown as T;
  }
  if (isPlainObject(obj)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      out[k] = jsonForm((obj as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return obj;
}

function findNonfinite(obj: unknown, path = "$"): Issue[] {
  const issues: Issue[] = [];
  if (typeof obj === "boolean") {
    return issues;
  }
  if (typeof obj === "number" && !Number.isFinite(obj)) {
    issues.push({
      code: "E_NONFINITE",
      path,
      message: `non-finite float ${obj}`,
    });
    return issues;
  }
  if (isPlainObject(obj)) {
    for (const k of Object.keys(obj)) {
      issues.push(...findNonfinite((obj as Record<string, unknown>)[k], `${path}.${k}`));
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      issues.push(...findNonfinite(obj[i], `${path}[${i}]`));
    }
  }
  return issues;
}

export function validateCommand(obj: unknown): Issue[] {
  const nonfinite = findNonfinite(obj);
  if (nonfinite.length > 0) {
    return nonfinite;
  }
  return commandValidator.errors(obj).map(([path, message]) => ({
    code: "E_SCHEMA",
    path,
    message,
  }));
}

export function validateSnapshot(obj: unknown): Issue[] {
  const nonfinite = findNonfinite(obj);
  if (nonfinite.length > 0) {
    return nonfinite;
  }
  return snapshotValidator.errors(obj).map(([path, message]) => ({
    code: "E_SCHEMA",
    path,
    message,
  }));
}
