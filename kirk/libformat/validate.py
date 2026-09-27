"""Validate a reactor library folder against docs/library-format.md.

Usage (from the repo root):
    python -m kirk.libformat.validate path/to/library [--json]

Exit code 0 when valid, 1 when any issue is found. Standard library only.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import struct
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .minischema import Validator

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "schema" / "library.schema.json"

SUPPORTED_VERSIONS = ("0.1.0",)
SUPPORTED_CAPABILITIES = ("point-kinetics/lumped-thermal-v1",)
TRUTH_SIGNALS = ("power", "period", "fuelTemp", "coolantTemp", "xenon", "mode")

TABLE_REF_TOL = 1e-9     # reactivity tables (JSON doubles)
ARRAY_REF_TOL = 1e-6     # float32 arrays
SUM_TOL = 1e-5
NEG_TOL = 1e-6


@dataclass(frozen=True)
class Issue:
    code: str
    path: str
    message: str


def _interp(xs: list[float], ys: list[float], x: float) -> float | None:
    """Linear interpolation; None when x is outside [xs[0], xs[-1]]."""
    if x < xs[0] or x > xs[-1]:
        return None
    i = bisect.bisect_right(xs, x) - 1
    if i >= len(xs) - 1:
        return ys[-1]
    t = (x - xs[i]) / (xs[i + 1] - xs[i])
    return ys[i] + t * (ys[i + 1] - ys[i])


class _NonStandardJSON(ValueError):
    pass


def _reject_constant(name: str) -> Any:
    raise _NonStandardJSON(f"{name} isn't valid JSON")


def _load_json(text: str) -> Any:
    """json.loads as strict as JavaScript's JSON.parse: NaN, Infinity and -Infinity are errors."""
    return json.loads(text, parse_constant=_reject_constant)


def _increasing(xs: list[float]) -> bool:
    return all(b > a for a, b in zip(xs, xs[1:]))


def _safe_relpath(p: str) -> bool:
    if not p or "\\" in p or ":" in p or p.startswith("/"):
        return False
    # Check raw segments: PurePosixPath would silently normalize "./a" and "a//b".
    return all(seg not in ("", ".", "..") for seg in p.split("/"))


class _Checker:
    def __init__(self, folder: Path):
        self.folder = folder
        self.issues: list[Issue] = []
        self.arrays: dict[str, list[float]] = {}

    def add(self, code: str, path: str, message: str) -> None:
        self.issues.append(Issue(code, path, message))

    # ---------- entry ----------
    def run(self) -> list[Issue]:
        manifest_path = self.folder / "manifest.json"
        try:
            m = _load_json(manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.add("E_JSON", "manifest.json", "manifest.json not found")
            return self.issues
        except (json.JSONDecodeError, _NonStandardJSON, UnicodeDecodeError) as e:
            self.add("E_JSON", "manifest.json", f"not valid JSON: {e}")
            return self.issues
        if not isinstance(m, dict):
            self.add("E_JSON", "$", "manifest must be a JSON object")
            return self.issues

        version = m.get("schemaVersion")
        if isinstance(version, str) and version not in SUPPORTED_VERSIONS:
            self.add("E_VERSION_UNSUPPORTED", "$.schemaVersion",
                     f"{version!r} isn't supported (supported: {', '.join(SUPPORTED_VERSIONS)})")
            return self.issues

        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        for path, msg in Validator(schema).errors(m):
            self.add("E_SCHEMA", path, msg)
        if self.issues:
            return self.issues  # semantic checks assume a structurally valid manifest

        for cap in m["capabilities"]:
            if cap not in SUPPORTED_CAPABILITIES:
                self.add("E_CAPABILITY_UNSUPPORTED", "$.capabilities", f"{cap!r} isn't implemented")
        if self.issues:
            return self.issues

        self.check_sources(m, "$", m["status"])
        self.check_ids(m)
        self.check_rods(m)
        self.check_tables(m)
        self.check_plant(m)
        self.check_arrays(m)
        self.check_shapes(m)
        self.check_geometry(m)
        return self.issues

    # ---------- checks ----------
    def check_sources(self, node: Any, path: str, status: str) -> None:
        if isinstance(node, dict):
            if node.get("source") == "synthetic" and status != "synthetic":
                self.add("E_SOURCE_SYNTHETIC", path, "'synthetic' values are only allowed in a synthetic library")
            for k, v in node.items():
                self.check_sources(v, f"{path}.{k}", status)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                self.check_sources(v, f"{path}[{i}]", status)

    def _dupes(self, ids: list[str], path: str) -> None:
        seen = set()
        for i in ids:
            if i in seen:
                self.add("E_DUPLICATE_ID", path, f"duplicate id {i!r}")
            seen.add(i)

    def check_ids(self, m: dict) -> None:
        self._dupes([r["id"] for r in m["reactivity"]["rods"]], "$.reactivity.rods")
        self._dupes(m["shapes"]["bins"]["elements"], "$.shapes.bins.elements")
        p = m["plant"]
        for key in ("instruments", "trips", "interlocks", "pumps"):
            self._dupes([x["id"] for x in p[key]], f"$.plant.{key}")

    def check_rods(self, m: dict) -> None:
        rods = {r["id"] for r in m["reactivity"]["rods"]}
        for where, keys in (("$.reference.rods", set(m["reference"]["rods"])),
                            ("$.domain.rods", set(m["domain"]["rods"]))):
            if keys != rods:
                missing, extra = sorted(rods - keys), sorted(keys - rods)
                self.add("E_ROD_UNKNOWN", where, f"must list exactly the rods; missing {missing}, unknown {extra}")
        for rid in m["shapes"]["rodDeltas"]:
            if rid not in rods:
                self.add("E_ROD_UNKNOWN", f"$.shapes.rodDeltas.{rid}", "unknown rod")
        for i, jc in enumerate(m["domain"]["jointChecked"]):
            for rid in jc["rods"]:
                if rid not in rods:
                    self.add("E_ROD_UNKNOWN", f"$.domain.jointChecked[{i}]", f"unknown rod {rid!r}")

    def _table(self, t: dict, axis: str, value: str, path: str, ref: float | None) -> None:
        cols = [axis, value] + (["unc"] if "unc" in t else [])
        n = len(t[axis])
        if any(len(t[c]) != n for c in cols) or n < 2:
            self.add("E_TABLE_LENGTH", path, f"columns {cols} must have equal length >= 2")
            return
        if not _increasing(t[axis]):
            self.add("E_TABLE_NOT_MONOTONIC", f"{path}.{axis}", "axis must be strictly increasing")
            return
        if ref is not None:
            v = _interp(t[axis], t[value], ref)
            if v is None:
                self.add("E_REF_NONZERO", path, f"reference point {ref} is outside the table")
            elif abs(v) > TABLE_REF_TOL:
                self.add("E_REF_NONZERO", path, f"value at reference point {ref} is {v:.3e}, must be 0")

    def check_tables(self, m: dict) -> None:
        ref = m["reference"]
        r = m["reactivity"]
        for i, rod in enumerate(r["rods"]):
            path = f"$.reactivity.rods[{i}]"
            self._table(rod["worth"], "x", "rho", f"{path}.worth", ref["rods"].get(rod["id"]))
            sc = rod["scram"]
            if len(sc["t"]) != len(sc["x"]):
                self.add("E_TABLE_LENGTH", f"{path}.scram", "t and x must have equal length")
            elif sc["t"][0] != 0 or not _increasing(sc["t"]):
                self.add("E_TABLE_NOT_MONOTONIC", f"{path}.scram.t", "must start at 0 and strictly increase")
            elif sc["x"][-1] != 0 or any(not 0 <= x <= 1 for x in sc["x"]):
                self.add("E_SCRAM_PROFILE", f"{path}.scram.x", "positions must be in [0, 1] and end at 0")
            elif any(b > a for a, b in zip(sc["x"], sc["x"][1:])):
                # the engine inverts the profile (Rod.scram_tau), which needs it non-increasing
                self.add("E_SCRAM_PROFILE", f"{path}.scram.x", "positions must not increase during a scram")
            if "fireTime" in rod and not rod["pulseCapable"]:
                self.add("E_SCHEMA", f"{path}.fireTime", "only pulse-capable rods may have fireTime")
            if rod["pulseCapable"] and "fireTime" not in rod:
                self.add("E_SCHEMA", f"{path}", "pulse-capable rods need fireTime")
        self._table(r["fuelTemp"], "T", "rho", "$.reactivity.fuelTemp", ref["Tfuel"]["value"])
        self._table(r["coolantTemp"], "T", "rho", "$.reactivity.coolantTemp", ref["Tcoolant"]["value"])
        self._table(r["xenon"], "N", "rho", "$.reactivity.xenon", ref["xenon"]["value"])
        self._table(m["thermal"]["fuel"]["cp"], "T", "c", "$.thermal.fuel.cp", None)

    def _signal_ok(self, sig: str, instruments: set[str], rods: set[str]) -> bool:
        if sig.startswith("truth."):
            name = sig[len("truth."):]
            return name in TRUTH_SIGNALS or (name.startswith("rod.") and name[4:] in rods)
        if sig.startswith("indicated."):
            return sig[len("indicated."):] in instruments
        return False

    def _predicate(self, p: dict, path: str, default: str | None, inst: set, rods: set) -> None:
        for key in ("all", "any"):
            if key in p:
                for i, sub in enumerate(p[key]):
                    self._predicate(sub, f"{path}.{key}[{i}]", default, inst, rods)
                return
        if "not" in p:
            self._predicate(p["not"], f"{path}.not", default, inst, rods)
            return
        sig = p.get("signal", default)
        if sig is None:
            self.add("E_SIGNAL_UNKNOWN", path, "predicate must name a signal here")
        elif not self._signal_ok(sig, inst, rods):
            self.add("E_SIGNAL_UNKNOWN", path, f"unknown signal {sig!r}")
        if isinstance(p["value"], str) and p["op"] not in ("eq", "ne"):
            self.add("E_PREDICATE_TYPE", path, f"op {p['op']!r} needs a number")
        if sig == "truth.mode" and p["op"] not in ("eq", "ne"):
            self.add("E_PREDICATE_TYPE", path, "truth.mode only supports eq and ne")

    def check_plant(self, m: dict) -> None:
        p = m["plant"]
        rods = {r["id"] for r in m["reactivity"]["rods"]}
        inst = {i["id"] for i in p["instruments"]}
        if p["initialMode"] not in p["modes"]:
            self.add("E_MODE_UNKNOWN", "$.plant.initialMode", f"{p['initialMode']!r} isn't in modes")
        pumps = {x["id"] for x in p["pumps"]}
        if m["thermal"]["heatExchanger"]["pump"] not in pumps:
            self.add("E_PUMP_UNKNOWN", "$.thermal.heatExchanger.pump", "unknown pump")
        for i, ins in enumerate(p["instruments"]):
            if not ins["signal"].startswith("truth.") or not self._signal_ok(ins["signal"], inst, rods):
                self.add("E_SIGNAL_UNKNOWN", f"$.plant.instruments[{i}]", f"instrument signal must be a truth signal, got {ins['signal']!r}")
        for i, t in enumerate(p["trips"]):
            path = f"$.plant.trips[{i}]"
            if not self._signal_ok(t["input"], inst, rods):
                self.add("E_SIGNAL_UNKNOWN", f"{path}.input", f"unknown signal {t['input']!r}")
            self._predicate(t["predicate"], f"{path}.predicate", t["input"], inst, rods)
            for mode in t.get("modes", []):
                if mode not in p["modes"]:
                    self.add("E_MODE_UNKNOWN", f"{path}.modes", f"{mode!r} isn't in modes")
        for i, il in enumerate(p["interlocks"]):
            self._predicate(il["when"], f"$.plant.interlocks[{i}].when", None, inst, rods)

    def check_arrays(self, m: dict) -> None:
        for name, d in m["arrays"].items():
            path = f"$.arrays.{name}"
            if not _safe_relpath(d["file"]):
                self.add("E_PATH_UNSAFE", path, f"{d['file']!r} must be a contained relative path")
                continue
            f = self.folder / d["file"]
            if not f.is_file():
                self.add("E_FILE_MISSING", path, f"{d['file']} not found")
                continue
            data = f.read_bytes()
            # The schema's integers may arrive as integral floats (0.0); struct needs Python ints.
            offset, byte_length = int(d["offset"]), int(d["byteLength"])
            count = math.prod(int(n) for n in d["shape"])
            if byte_length != 4 * count or offset + byte_length > len(data):
                self.add("E_OFFSET_BOUNDS", path, f"byteLength {d['byteLength']} / offset {d['offset']} don't fit shape {d['shape']} and file size {len(data)}")
                continue
            if hashlib.sha256(data).hexdigest() != d["sha256"]:
                self.add("E_DIGEST_MISMATCH", path, "sha256 doesn't match the file")
                continue
            values = list(struct.unpack_from(f"<{count}f", data, offset))
            if not all(math.isfinite(v) for v in values):
                self.add("E_NONFINITE", path, "contains NaN or infinity")
                continue
            self.arrays[name] = values

    def _array(self, m: dict, name: str, dims: list[int], path: str) -> list[float] | None:
        if name not in m["arrays"]:
            self.add("E_ARRAY_UNKNOWN", path, f"array {name!r} isn't declared in $.arrays")
            return None
        if [int(n) for n in m["arrays"][name]["shape"]] != dims:
            self.add("E_SHAPE_DIMS", path, f"array {name!r} has shape {m['arrays'][name]['shape']}, expected {dims}")
            return None
        return self.arrays.get(name)  # None if it failed an array check (already reported)

    def check_shapes(self, m: dict) -> None:
        s = m["shapes"]
        E = len(s["bins"]["elements"])
        edges = s["bins"]["axialEdgesCm"]
        if not _increasing(edges):
            self.add("E_TABLE_NOT_MONOTONIC", "$.shapes.bins.axialEdgesCm", "must be strictly increasing")
            return
        A = len(edges) - 1
        n = E * A
        base = self._array(m, s["base"], [E, A], "$.shapes.base")
        if "baseUnc" in s:
            self._array(m, s["baseUnc"], [E, A], "$.shapes.baseUnc")
        vols = self._array(m, s["volumes"], [E, A], "$.shapes.volumes")
        if vols is not None and min(vols) <= 0:
            self.add("E_VOLUME_NONPOSITIVE", "$.shapes.volumes", "every bin volume must be > 0")
        if base is not None and abs(sum(base) - 1.0) > SUM_TOL:
            self.add("E_SHAPE_NORMALIZATION", "$.shapes.base", f"sums to {sum(base):.7f}, must be 1")

        ref = m["reference"]
        deltas = [(f"$.shapes.rodDeltas.{rid}", d["x"], d["array"], ref["rods"].get(rid))
                  for rid, d in s["rodDeltas"].items()]
        deltas.append(("$.shapes.tempDelta", s["tempDelta"]["T"], s["tempDelta"]["array"], ref["Tfuel"]["value"]))
        for path, grid, name, ref_pt in deltas:
            if not _increasing(grid):
                self.add("E_TABLE_NOT_MONOTONIC", path, "grid must be strictly increasing")
                continue
            arr = self._array(m, name, [len(grid), E, A], path)
            if arr is None:
                continue
            slices = [arr[k * n:(k + 1) * n] for k in range(len(grid))]
            for k, sl in enumerate(slices):
                if abs(sum(sl)) > SUM_TOL:
                    self.add("E_DELTA_SUM", f"{path}[{k}]", f"slice sums to {sum(sl):.3e}, must be 0")
                if base is not None:
                    low = min(b + d for b, d in zip(base, sl))
                    if low < -NEG_TOL:
                        self.add("E_SHAPE_NEGATIVE", f"{path}[{k}]", f"reconstructed shape reaches {low:.3e}")
            if ref_pt is None:
                continue
            at_ref = [_interp(grid, [sl[j] for sl in slices], ref_pt) for j in range(n)]
            if at_ref[0] is None:
                self.add("E_REF_NONZERO", path, f"reference point {ref_pt} is outside the grid")
            elif max(abs(v) for v in at_ref) > ARRAY_REF_TOL:
                self.add("E_REF_NONZERO", path, f"delta at reference point {ref_pt} isn't zero")

    def check_geometry(self, m: dict) -> None:
        elements = set(m["shapes"]["bins"]["elements"])
        rods = {r["id"] for r in m["reactivity"]["rods"]}
        covered = set()
        for i, p in enumerate(m["geometry"]["primitives"]):
            if "element" in p:
                if p["element"] in elements:
                    covered.add(p["element"])
                else:
                    self.add("E_GEOMETRY_ID", f"$.geometry.primitives[{i}]", f"unknown element {p['element']!r}")
            if "rod" in p and p["rod"] not in rods:
                self.add("E_GEOMETRY_ID", f"$.geometry.primitives[{i}]", f"unknown rod {p['rod']!r}")
        for e in sorted(elements - covered):
            self.add("E_GEOMETRY_ID", "$.geometry.primitives", f"element {e!r} has no geometry")


def validate_library(folder: str | Path) -> list[Issue]:
    return _Checker(Path(folder)).run()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("library")
    ap.add_argument("--json", action="store_true", help="print issues as JSON")
    args = ap.parse_args(argv)
    issues = validate_library(args.library)
    if args.json:
        print(json.dumps([asdict(i) for i in issues], indent=2))
    elif issues:
        for i in issues:
            print(f"{i.code}  {i.path}  {i.message}")
    else:
        print(f"OK  {args.library}")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
