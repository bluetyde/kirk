"""Minimal JSON Schema checker for the subset used by kirk/schemas/library.schema.json.

Standard library only, so the fast checks run on a clean checkout without extra packages.
Any keyword outside SUPPORTED makes the schema itself invalid (SchemaError): the schema can
never silently use a rule this checker would ignore. web/src/library/ ports this file to
TypeScript line for line, and both must give the same (path, code) results on every fixture, so
the semantics here are pinned to what JavaScript can reproduce:
- const/enum use JSON equality: true is not 1, and 1 equals 1.0 (JSON has one number type);
- pattern is an ECMAScript-compatible regex, and a trailing "$" means end of string (Python's "$"
  also matches before a final newline; JavaScript's doesn't);
- minLength counts code points.
"""
from __future__ import annotations

import math
import re
from typing import Any

ANNOTATIONS = {"$schema", "$id", "title", "description", "$defs"}
SUPPORTED = ANNOTATIONS | {
    "type", "required", "properties", "additionalProperties", "items", "minItems", "maxItems",
    "enum", "const", "pattern", "minLength", "minimum", "maximum", "exclusiveMinimum", "$ref", "anyOf",
}


class SchemaError(Exception):
    """The schema uses something this checker doesn't implement."""


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _json_equal(a: Any, b: Any) -> bool:
    """Equality of JSON values as JavaScript would see them (Python's True == 1 isn't)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) or _is_number(b):
        return _is_number(a) and _is_number(b) and a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_equal(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _pattern_ok(pattern: str, v: str) -> bool:
    """re.search, except a trailing "$" means end of string, as in JavaScript."""
    if pattern.endswith("$") and not pattern.endswith("\\$"):
        pattern = pattern[:-1] + r"\Z"
    return re.search(pattern, v) is not None


def _type_ok(v: Any, t: str) -> bool:
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "number":
        return _is_number(v) and math.isfinite(v)
    if t == "integer":
        return _is_number(v) and math.isfinite(v) and float(v).is_integer()
    if t == "boolean":
        return isinstance(v, bool)
    if t == "null":
        return v is None
    raise SchemaError(f"unsupported type {t!r}")


def check_schema(schema: Any, where: str = "#") -> None:
    """Raise SchemaError if the schema uses unsupported keywords anywhere."""
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaError(f"{where}: schema must be an object")
    unknown = set(schema) - SUPPORTED
    if unknown:
        raise SchemaError(f"{where}: unsupported keyword(s) {sorted(unknown)}")
    for key in ("properties", "$defs"):
        for name, sub in schema.get(key, {}).items():
            check_schema(sub, f"{where}/{key}/{name}")
    for key in ("items", "additionalProperties"):
        if key in schema:
            check_schema(schema[key], f"{where}/{key}")
    for i, sub in enumerate(schema.get("anyOf", [])):
        check_schema(sub, f"{where}/anyOf/{i}")


class Validator:
    def __init__(self, schema: dict):
        check_schema(schema)
        self.root = schema

    def _resolve(self, ref: str) -> Any:
        if not ref.startswith("#/"):
            raise SchemaError(f"only local refs are supported: {ref}")
        node: Any = self.root
        for part in ref[2:].split("/"):
            node = node[part]
        return node

    def errors(self, instance: Any) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        self._check(instance, self.root, "$", out)
        return out

    def _check(self, v: Any, s: Any, path: str, out: list) -> None:
        if s is True:
            return
        if s is False:
            out.append((path, "no value is allowed here"))
            return
        if "$ref" in s:
            self._check(v, self._resolve(s["$ref"]), path, out)
        if "anyOf" in s:
            branch_errors = []
            for sub in s["anyOf"]:
                errs: list = []
                self._check(v, sub, path, errs)
                if not errs:
                    break
                branch_errors.append(errs)
            else:
                best = min(branch_errors, key=len)
                out.append((path, "doesn't match any allowed form; closest form fails with: "
                            + "; ".join(f"{p}: {m}" for p, m in best[:3])))
        if "type" in s and not _type_ok(v, s["type"]):
            out.append((path, f"expected {s['type']}"))
            return
        if "const" in s and not _json_equal(v, s["const"]):
            out.append((path, f"must be {s['const']!r}"))
        if "enum" in s and not any(_json_equal(v, e) for e in s["enum"]):
            out.append((path, f"must be one of {s['enum']}"))
        if isinstance(v, str):
            if "minLength" in s and len(v) < s["minLength"]:  # code points
                out.append((path, f"shorter than {s['minLength']}"))
            if "pattern" in s and not _pattern_ok(s["pattern"], v):
                out.append((path, f"doesn't match pattern {s['pattern']}"))
        if _is_number(v):
            if "minimum" in s and v < s["minimum"]:
                out.append((path, f"below minimum {s['minimum']}"))
            if "maximum" in s and v > s["maximum"]:
                out.append((path, f"above maximum {s['maximum']}"))
            if "exclusiveMinimum" in s and v <= s["exclusiveMinimum"]:
                out.append((path, f"must be > {s['exclusiveMinimum']}"))
        if isinstance(v, list):
            if "minItems" in s and len(v) < s["minItems"]:
                out.append((path, f"needs at least {s['minItems']} items"))
            if "maxItems" in s and len(v) > s["maxItems"]:
                out.append((path, f"allows at most {s['maxItems']} items"))
            if "items" in s:
                for i, item in enumerate(v):
                    self._check(item, s["items"], f"{path}[{i}]", out)
        if isinstance(v, dict):
            for req in s.get("required", []):
                if req not in v:
                    out.append((path, f"missing required field {req!r}"))
            props = s.get("properties", {})
            for key, val in v.items():
                if key in props:
                    self._check(val, props[key], f"{path}.{key}", out)
                elif s.get("additionalProperties") is False:
                    out.append((path, f"unknown field {key!r}"))
                elif "additionalProperties" in s:
                    self._check(val, s["additionalProperties"], f"{path}.{key}", out)
