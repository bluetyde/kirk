/**
 * Minimal JSON Schema checker for the subset used by schema/library.schema.json,
 * command.schema.json, and snapshot.schema.json.
 *
 * Ported from pipeline/library/minischema.py.
 */

export const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs"]);
export const SUPPORTED = new Set([
  ...ANNOTATIONS,
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "enum",
  "const",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "$ref",
  "anyOf",
]);

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") {
    return typeof a === "boolean" && typeof b === "boolean" && a === b;
  }
  if (isNumber(a) || isNumber(b)) {
    return isNumber(a) && isNumber(b) && a === b;
  }
  if (typeof a === "string" || typeof b === "string") {
    return typeof a === "string" && typeof b === "string" && a === b;
  }
  if (a === null || b === null) {
    return a === null && b === null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      return false;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!Object.hasOwn(b, k)) return false;
      if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
        return false;
      }
    }
    return true;
  }
  return a === b;
}

function typeOk(v: unknown, t: string): boolean {
  if (t === "object") return isPlainObject(v);
  if (t === "array") return Array.isArray(v);
  if (t === "string") return typeof v === "string";
  if (t === "number") return isNumber(v);
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "boolean") return typeof v === "boolean";
  if (t === "null") return v === null;
  throw new SchemaError(`unsupported type ${JSON.stringify(t)}`);
}

export function checkSchema(schema: unknown, where = "#"): void {
  if (typeof schema === "boolean") {
    return;
  }
  if (!isPlainObject(schema)) {
    throw new SchemaError(`${where}: schema must be an object`);
  }
  const unknown: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k)) {
      unknown.push(k);
    }
  }
  if (unknown.length > 0) {
    unknown.sort();
    throw new SchemaError(`${where}: unsupported keyword(s) ${JSON.stringify(unknown)}`);
  }
  for (const key of ["properties", "$defs"]) {
    if (Object.hasOwn(schema, key)) {
      const container = (schema as Record<string, unknown>)[key];
      if (isPlainObject(container)) {
        for (const name of Object.keys(container)) {
          checkSchema((container as Record<string, unknown>)[name], `${where}/${key}/${name}`);
        }
      }
    }
  }
  for (const key of ["items", "additionalProperties"]) {
    if (Object.hasOwn(schema, key)) {
      checkSchema((schema as Record<string, unknown>)[key], `${where}/${key}`);
    }
  }
  if (Object.hasOwn(schema, "anyOf")) {
    const arr = (schema as Record<string, unknown>).anyOf;
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        checkSchema(arr[i], `${where}/anyOf/${i}`);
      }
    }
  }
}

export class Validator {
  readonly root: unknown;
  private patternCache = new Map<string, RegExp>();

  constructor(schema: unknown) {
    checkSchema(schema);
    this.root = schema;
  }

  private resolve(ref: string): unknown {
    if (!ref.startsWith("#/")) {
      throw new SchemaError(`only local refs are supported: ${ref}`);
    }
    let node: unknown = this.root;
    for (const part of ref.slice(2).split("/")) {
      if (!isPlainObject(node) || !Object.hasOwn(node, part)) {
        throw new SchemaError(`cannot resolve ref: ${ref}`);
      }
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  errors(instance: unknown): [string, string][] {
    const out: [string, string][] = [];
    this.check(instance, this.root, "$", out);
    return out;
  }

  private getPattern(pattern: string): RegExp {
    let re = this.patternCache.get(pattern);
    if (!re) {
      re = new RegExp(pattern, "u");
      this.patternCache.set(pattern, re);
    }
    return re;
  }

  private check(v: unknown, s: unknown, path: string, out: [string, string][]): void {
    if (s === true) {
      return;
    }
    if (s === false) {
      out.push([path, "no value is allowed here"]);
      return;
    }
    if (!isPlainObject(s)) {
      return;
    }

    if (Object.hasOwn(s, "$ref")) {
      const ref = s.$ref as string;
      this.check(v, this.resolve(ref), path, out);
    }

    if (Object.hasOwn(s, "anyOf")) {
      const anyOf = s.anyOf as unknown[];
      const branchErrors: [string, string][][] = [];
      let matched = false;
      for (const sub of anyOf) {
        const errs: [string, string][] = [];
        this.check(v, sub, path, errs);
        if (errs.length === 0) {
          matched = true;
          break;
        }
        branchErrors.push(errs);
      }
      if (!matched) {
        let best = branchErrors[0] ?? [];
        for (let i = 1; i < branchErrors.length; i++) {
          const curr = branchErrors[i]!;
          if (curr.length < best.length) {
            best = curr;
          }
        }
        const details = best
          .slice(0, 3)
          .map(([p, m]) => `${p}: ${m}`)
          .join("; ");
        out.push([
          path,
          "doesn't match any allowed form; closest form fails with: " + details,
        ]);
      }
    }

    if (Object.hasOwn(s, "type")) {
      const t = s.type as string;
      if (!typeOk(v, t)) {
        out.push([path, `expected ${t}`]);
        return;
      }
    }

    if (Object.hasOwn(s, "const")) {
      if (!jsonEqual(v, s.const)) {
        out.push([path, `must be ${JSON.stringify(s.const)}`]);
      }
    }

    if (Object.hasOwn(s, "enum")) {
      const enumList = s.enum as unknown[];
      if (!enumList.some((e) => jsonEqual(v, e))) {
        out.push([path, `must be one of ${JSON.stringify(enumList)}`]);
      }
    }

    if (typeof v === "string") {
      if (Object.hasOwn(s, "minLength")) {
        const minLen = s.minLength as number;
        if ([...v].length < minLen) {
          out.push([path, `shorter than ${minLen}`]);
        }
      }
      if (Object.hasOwn(s, "pattern")) {
        const pattern = s.pattern as string;
        if (!this.getPattern(pattern).test(v)) {
          out.push([path, `doesn't match pattern ${pattern}`]);
        }
      }
    }

    if (isNumber(v)) {
      if (Object.hasOwn(s, "minimum")) {
        const min = s.minimum as number;
        if (v < min) {
          out.push([path, `below minimum ${min}`]);
        }
      }
      if (Object.hasOwn(s, "maximum")) {
        const max = s.maximum as number;
        if (v > max) {
          out.push([path, `above maximum ${max}`]);
        }
      }
      if (Object.hasOwn(s, "exclusiveMinimum")) {
        const exMin = s.exclusiveMinimum as number;
        if (v <= exMin) {
          out.push([path, `must be > ${exMin}`]);
        }
      }
    }

    if (Array.isArray(v)) {
      if (Object.hasOwn(s, "minItems")) {
        const minItems = s.minItems as number;
        if (v.length < minItems) {
          out.push([path, `needs at least ${minItems} items`]);
        }
      }
      if (Object.hasOwn(s, "maxItems")) {
        const maxItems = s.maxItems as number;
        if (v.length > maxItems) {
          out.push([path, `allows at most ${maxItems} items`]);
        }
      }
      if (Object.hasOwn(s, "items")) {
        for (let i = 0; i < v.length; i++) {
          this.check(v[i], s.items, `${path}[${i}]`, out);
        }
      }
    }

    if (isPlainObject(v)) {
      if (Object.hasOwn(s, "required") && Array.isArray(s.required)) {
        for (const req of s.required as string[]) {
          if (!Object.hasOwn(v, req)) {
            out.push([path, `missing required field '${req}'`]);
          }
        }
      }
      const props =
        Object.hasOwn(s, "properties") && isPlainObject(s.properties)
          ? (s.properties as Record<string, unknown>)
          : {};
      for (const key of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[key];
        if (Object.hasOwn(props, key)) {
          this.check(val, props[key], `${path}.${key}`, out);
        } else if (
          Object.hasOwn(s, "additionalProperties") &&
          s.additionalProperties === false
        ) {
          out.push([path, `unknown field '${key}'`]);
        } else if (Object.hasOwn(s, "additionalProperties")) {
          this.check(val, s.additionalProperties, `${path}.${key}`, out);
        }
      }
    }
  }
}
