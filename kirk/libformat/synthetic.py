"""Generate the synthetic test library and the invalid conformance fixtures.

Usage (from the repo root):
    python -m kirk.libformat.synthetic            # writes schema/vectors/
    python -m kirk.libformat.synthetic --out DIR  # writes somewhere else

Every number here is invented (status "synthetic", source "synthetic"), except the
delayed-neutron group structure, which uses standard U-235 thermal-fission group data.
They're shaped to be self-consistent and TRIGA-like, not to describe any real reactor.
Output is byte-for-byte deterministic: no timestamps, fixed ordering.
Standard library only.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import shutil
import struct
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "schema" / "vectors"

SYN = "synthetic"
T_REF = 293.15          # K
PITCH = 4.3             # cm, hex lattice pitch
CORE_H = 38.0           # cm, fuel height
R_EXT = 16.0            # cm, extrapolated radius (shape)
H_EXT = 24.0            # cm, extrapolated half-height (shape)
AXIAL_EDGES = [-19.0, -15.0, -11.0, -7.0, -3.5, 0.0, 3.5, 7.0, 11.0, 15.0, 19.0]  # unequal on purpose
ROD_X = [i / 10 for i in range(11)]
TEMP_GRID = [T_REF, 400.0, 600.0, 800.0, 1000.0, 1200.0]
ROD_SPEC = {  # id: (name, hex position, total worth)
    "safety": ("Safety rod", "C2", 0.021),
    "regulating": ("Regulating rod", "C6", 0.014),
    "transient": ("Transient rod", "C10", 0.0175),
}
# U-235 thermal fission delayed groups: relative abundances and decay constants (1/s)
GROUP_ABUNDANCE = [0.033, 0.219, 0.196, 0.395, 0.115, 0.042]
GROUP_LAMBDA = [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01]
BETA_TOTAL = 0.0070


def S(value: float, **extra) -> dict:
    return {"value": value, "source": SYN, **extra}


def hex_positions() -> dict[str, tuple[float, float]]:
    pos = {"A1": (0.0, 0.0)}
    for k in range(6):
        a = math.radians(60 * k)
        pos[f"B{k + 1}"] = (PITCH * math.cos(a), PITCH * math.sin(a))
    for k in range(12):
        if k % 2 == 0:
            a, r = math.radians(30 * k), 2 * PITCH
        else:
            a, r = math.radians(30 * k), math.sqrt(3) * PITCH
        pos[f"C{k + 1}"] = (r * math.cos(a), r * math.sin(a))
    return {k: (round(x, 4), round(y, 4)) for k, (x, y) in pos.items()}


def f32(v: float) -> float:
    return struct.unpack("<f", struct.pack("<f", v))[0]


def rod_worth(total: float, x: float) -> float:
    return total * (x - math.sin(2 * math.pi * x) / (2 * math.pi))


def build_core():
    pos = hex_positions()
    rod_pos = {rid: spec[1] for rid, spec in ROD_SPEC.items()}
    elements = [e for e in pos if e != "A1" and e not in rod_pos.values()]
    mids = [(a + b) / 2 for a, b in zip(AXIAL_EDGES, AXIAL_EDGES[1:])]
    widths = [b - a for a, b in zip(AXIAL_EDGES, AXIAL_EDGES[1:])]
    return pos, rod_pos, elements, mids, widths


def raw_shape(rod_x: dict[str, float], T: float) -> list[float]:
    """Unnormalized bin powers: cosine x cosine, depressed near inserted absorber, flattened when hot."""
    pos, rod_pos, elements, mids, widths = build_core()
    flat = 1.0 - 0.15 * (T - T_REF) / (1200.0 - T_REF)
    out = []
    for e in elements:
        x, y = pos[e]
        r = math.hypot(x, y)
        radial = math.cos(math.pi * r / (2 * R_EXT))
        for z, dz in zip(mids, widths):
            v = radial * math.cos(math.pi * z / (2 * H_EXT))
            for rid, rp in rod_pos.items():
                rx, ry = pos[rp]
                d2 = (x - rx) ** 2 + (y - ry) ** 2
                tip = AXIAL_EDGES[0] + CORE_H * rod_x[rid]          # absorber bottom rises as the rod withdraws
                covered = 1.0 / (1.0 + math.exp(-(z - tip) / 1.5))
                v *= 1.0 - 0.25 * math.exp(-d2 / 50.0) * covered
            out.append((v ** flat) * dz)
    return out


def normalized(v: list[float]) -> list[float]:
    s = sum(v)
    return [a / s for a in v]


def build_arrays():
    pos, rod_pos, elements, mids, widths = build_core()
    all_in = {rid: 0.0 for rid in ROD_SPEC}
    base = normalized(raw_shape(all_in, T_REF))
    rod_deltas = {}
    for rid in ROD_SPEC:
        slices = []
        for x in ROD_X:
            if x == 0.0:
                slices.extend([0.0] * len(base))
                continue
            state = dict(all_in, **{rid: x})
            sh = normalized(raw_shape(state, T_REF))
            slices.extend(a - b for a, b in zip(sh, base))
        rod_deltas[rid] = slices
    temp = []
    for T in TEMP_GRID:
        if T == T_REF:
            temp.extend([0.0] * len(base))
            continue
        sh = normalized(raw_shape(all_in, T))
        temp.extend(a - b for a, b in zip(sh, base))
    r_meat = 1.82
    volumes = [math.pi * r_meat ** 2 * dz for _ in elements for dz in widths]
    base_unc = [0.01 + 0.02 * (1 - b / max(base)) for b in base]
    return elements, base, base_unc, volumes, rod_deltas, temp


def pack(values: list[float]) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def descriptor(file: str, data: bytes, shape: list[int]) -> dict:
    return {"file": file, "dtype": "float32", "byteOrder": "little", "shape": shape, "order": "C",
            "offset": 0, "byteLength": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def build_library() -> tuple[dict, dict[str, bytes]]:
    pos, rod_pos, _, mids, widths = build_core()
    elements, base, base_unc, volumes, rod_deltas, temp = build_arrays()
    E, A = len(elements), len(AXIAL_EDGES) - 1

    blobs: dict[str, bytes] = {"arrays/base.f32": pack(base), "arrays/base_unc.f32": pack(base_unc),
                               "arrays/volumes.f32": pack(volumes), "arrays/temp_delta.f32": pack(temp)}
    arrays = {"base": descriptor("arrays/base.f32", blobs["arrays/base.f32"], [E, A]),
              "baseUnc": descriptor("arrays/base_unc.f32", blobs["arrays/base_unc.f32"], [E, A]),
              "volumes": descriptor("arrays/volumes.f32", blobs["arrays/volumes.f32"], [E, A]),
              "tempDelta": descriptor("arrays/temp_delta.f32", blobs["arrays/temp_delta.f32"], [len(TEMP_GRID), E, A])}
    for rid in ROD_SPEC:
        f = f"arrays/rod_{rid}.f32"
        blobs[f] = pack(rod_deltas[rid])
        arrays[f"rod_{rid}"] = descriptor(f, blobs[f], [len(ROD_X), E, A])

    rods = []
    for rid, (name, _, total) in ROD_SPEC.items():
        rod = {"id": rid, "name": name, "travelCm": CORE_H, "speed": 0.02, "pulseCapable": rid == "transient",
               "worth": {"x": ROD_X, "rho": [round(rod_worth(total, x), 12) for x in ROD_X],
                         "interp": "linear", "outOfRange": "clamp-and-flag", "source": SYN},
               "scram": {"t": [0.0, 0.05, 0.15, 0.3, 0.45, 0.6], "x": [1.0, 0.98, 0.85, 0.55, 0.2, 0.0], "source": SYN}}
        if rid == "transient":
            rod["fireTime"] = 0.08
        rods.append(rod)

    phi = 4.0e10    # n/(m^2 s) per W
    geometry = [{"type": "cylinder", "center": [0, 0, 0], "radius": 100.0, "height": 640.0, "material": "water"},
                {"type": "annulus", "center": [0, 0, 0], "rInner": 12.0, "radius": 30.0, "height": 55.0, "material": "graphite"},
                {"type": "cylinder", "center": [0, 0, 0], "radius": 1.9, "height": 60.0, "material": "aluminum"}]
    for e in elements:
        x, y = pos[e]
        geometry.append({"type": "cylinder", "center": [x, y, 0.0], "radius": 1.82, "height": CORE_H, "material": "fuel", "element": e})
        geometry.append({"type": "annulus", "center": [x, y, 0.0], "rInner": 1.82, "radius": 1.87, "height": CORE_H, "material": "steel", "element": e})
    for rid, rp in rod_pos.items():
        x, y = pos[rp]
        geometry.append({"type": "cylinder", "center": [x, y, 0.0], "radius": 1.6, "height": CORE_H, "material": "b4c", "rod": rid})

    m = {
        "schemaVersion": "0.1.0",
        "id": "synthetic-core",
        "name": "Synthetic TRIGA-like core (test fixture, not a real reactor)",
        "status": "synthetic",
        "capabilities": ["point-kinetics/lumped-thermal-v1"],
        "provenance": {"generator": "kirk.libformat.synthetic", "created": "2026-09-25",
                       "notes": "All values invented for tests, except the delayed-group structure (standard U-235 thermal data).",
                       "sources": []},
        "reference": {"rods": {rid: 0.0 for rid in ROD_SPEC}, "Tfuel": S(T_REF), "Tcoolant": S(T_REF), "xenon": S(0.0),
                      "rho": S(-0.0325), "calibration": None},
        "kinetics": {"beta": {"values": [round(a * BETA_TOTAL, 8) for a in GROUP_ABUNDANCE], "source": SYN},
                     "lambda": {"values": GROUP_LAMBDA, "source": SYN},
                     "genTime": S(4.0e-5), "extSource": S(0.5)},
        "reactivity": {
            "rods": rods,
            "fuelTemp": {"T": TEMP_GRID + [], "rho": [round(-(9e-5 * (T - T_REF) + 1.5e-8 * (T - T_REF) ** 2), 12) for T in [T_REF, 400.0, 600.0, 800.0, 1000.0, 1200.0]],
                         "interp": "linear", "outOfRange": "clamp-and-flag", "source": SYN},
            "coolantTemp": {"T": [283.15, T_REF, 313.15, 333.15, 353.15],
                            "rho": [round(-2e-5 * (T - T_REF), 12) for T in [283.15, T_REF, 313.15, 333.15, 353.15]],
                            "interp": "linear", "outOfRange": "clamp-and-flag", "source": SYN},
            "xenon": {"N": [0.0, 1e20, 2e20, 4e20], "rho": [0.0, -0.0015, -0.003, -0.006],
                      "interp": "linear", "outOfRange": "extrapolate-and-flag", "source": SYN},
        },
        "thermal": {
            "fuel": {"mass": S(40.0), "cp": {"T": [T_REF, 600.0, 900.0, 1200.0], "c": [320.0, 420.0, 500.0, 560.0],
                                             "interp": "linear", "outOfRange": "clamp-and-flag", "source": SYN}},
            "coolant": {"mass": S(20000.0), "cp": S(4180.0)},
            "hA": S(1000.0),
            "heatExchanger": {"UA": S(8000.0), "sinkTemp": S(T_REF), "pump": "primary"},
            "deposition": {"fuelFraction": S(1.0)},
        },
        "poisons": {"fluxPerWatt": S(phi), "sigmaF": S(5.0), "gammaI": S(0.0639), "gammaXe": S(0.00237),
                    "lambdaI": S(2.93e-5), "lambdaXe": S(2.09e-5), "sigmaXe": S(2.6e-22)},
        "plant": {
            "modes": ["steady", "pulse"], "initialMode": "steady",
            "pumps": [{"id": "primary"}],
            "instruments": [
                {"id": "linear", "signal": "truth.power", "scale": "linear", "range": [0.0, 3.0e5], "lag": 0.1, "noise": 0.01},
                {"id": "log", "signal": "truth.power", "scale": "log", "range": [1e-4, 3e9], "lag": 0.005, "noise": 0.02},
                {"id": "fuel-tc", "signal": "truth.fuelTemp", "scale": "linear", "range": [273.15, 1273.15], "lag": 1.0, "noise": 0.002},
                {"id": "pool-temp", "signal": "truth.coolantTemp", "scale": "linear", "range": [273.15, 373.15], "lag": 5.0, "noise": 0.001},
            ],
            "trips": [
                {"id": "power-high", "input": "indicated.linear", "predicate": {"op": "gt", "value": 2.75e5}, "modes": ["steady"], "latching": True},
                {"id": "fuel-temp-high", "input": "indicated.fuel-tc", "predicate": {"op": "gt", "value": 873.15}, "latching": True},
                {"id": "period-short", "input": "truth.period",
                 "predicate": {"all": [{"op": "gt", "value": 0.0}, {"op": "lt", "value": 3.0}]}, "modes": ["steady"], "latching": True},
            ],
            "interlocks": [
                {"id": "fire-needs-pulse-mode", "when": {"signal": "truth.mode", "op": "ne", "value": "pulse"},
                 "blocks": ["rod.fire"], "reason": "The transient rod can only be fired in pulse mode."},
                {"id": "pulse-mode-low-power",
                 "when": {"all": [{"signal": "truth.mode", "op": "eq", "value": "steady"}, {"signal": "indicated.linear", "op": "gt", "value": 1000.0}]},
                 "blocks": ["mode.set"], "reason": "Switching to pulse mode needs power below 1 kW."},
            ],
        },
        "shapes": {
            "bins": {"elements": elements, "axialEdgesCm": AXIAL_EDGES},
            "basis": "heating", "normalization": "fraction-of-total-power", "form": "separable",
            "base": "base", "baseUnc": "baseUnc", "volumes": "volumes",
            "rodDeltas": {rid: {"x": ROD_X, "array": f"rod_{rid}"} for rid in ROD_SPEC},
            "tempDelta": {"T": TEMP_GRID, "array": "tempDelta"},
        },
        "arrays": arrays,
        "geometry": {"units": "cm", "up": "z", "primitives": geometry},
        "domain": {"rods": {rid: [0.0, 1.0] for rid in ROD_SPEC}, "Tfuel": [T_REF, 1200.0],
                   "Tcoolant": [283.15, 353.15], "xenon": [0.0, 4e20], "jointChecked": []},
    }
    return m, blobs


README = """# synthetic-core

Test fixture for the reactor library format (docs/library-format.md). **Not a real reactor.**
Every value is invented (status "synthetic"), except the delayed-group structure (standard U-235 thermal data).
Generated by `python -m kirk.libformat.synthetic`. Don't edit by hand; change the generator and regenerate.

18 hex positions: 15 fuel elements, 3 rods (safety, regulating, transient), central thimble.
10 axial bins of unequal height, so bin volumes differ.
Reference state: all rods fully inserted, 293.15 K, no xenon, reference reactivity -0.0325 (+0.02 with all rods out).
"""


def write_library(folder: Path, m: dict, blobs: dict[str, bytes], manifest_text: str | None = None) -> None:
    if folder.exists():
        shutil.rmtree(folder)
    (folder / "arrays").mkdir(parents=True)
    for name, data in blobs.items():
        (folder / name).write_bytes(data)
    text = manifest_text if manifest_text is not None else json.dumps(m, indent=2, ensure_ascii=False) + "\n"
    (folder / "manifest.json").write_bytes(text.encode("utf-8"))


# ---------------------------------------------------------------- invalid fixtures

def _redigest(m: dict, blobs: dict, name: str) -> None:
    d = m["arrays"][name]
    d["sha256"] = hashlib.sha256(blobs[d["file"]]).hexdigest()


def _edit_array(m: dict, blobs: dict, name: str, fn: Callable[[list[float]], None]) -> None:
    d = m["arrays"][name]
    data = blobs[d["file"]]
    vals = list(struct.unpack(f"<{len(data) // 4}f", data))
    fn(vals)
    blobs[d["file"]] = pack(vals)
    _redigest(m, blobs, name)


def _nan(v):
    v[0] = float("nan")


def _zero(v):
    v[0] = 0.0


def _scale(v):
    v[:] = [a * 1.1 for a in v]


def _n(m):
    return len(m["shapes"]["bins"]["elements"]) * (len(m["shapes"]["bins"]["axialEdgesCm"]) - 1)


def invalid_cases() -> list[tuple[str, list[str], Callable]]:
    """(name, expected codes, mutation(m, blobs) -> optional manifest text)."""
    def setp(path, value):
        def f(m, b):
            node = m
            for k in path[:-1]:
                node = node[k]
            node[path[-1]] = value
        return f

    def delp(path):
        def f(m, b):
            node = m
            for k in path[:-1]:
                node = node[k]
            del node[path[-1]]
        return f

    def sum_breaking(name, k):
        def f(m, b):
            n = _n(m)
            def g(v):
                v[k * n] += 0.01
            _edit_array(m, b, name, g)
        return f

    def negative(name, k):
        def f(m, b):
            n = _n(m)
            def g(v):
                v[k * n] -= 1.0
                v[k * n + 1] += 1.0
            _edit_array(m, b, name, g)
        return f

    def ref_nonzero_delta(m, b):
        def g(v):
            v[0] += 0.001
            v[1] -= 0.001
        _edit_array(m, b, "tempDelta", g)

    def bump_worth(m, b):
        m["reactivity"]["rods"][0]["worth"]["rho"] = [r + 0.001 for r in m["reactivity"]["rods"][0]["worth"]["rho"]]

    def swap_T(m, b):
        t = m["reactivity"]["fuelTemp"]["T"]
        t[1], t[2] = t[2], t[1]

    def dup_element(m, b):
        els = m["shapes"]["bins"]["elements"]
        els[1] = els[0]

    def ghost_rod(m, b):
        m["reference"]["rods"]["ghost"] = 0.0

    def bad_json(m, b):
        return "{ \"schemaVersion\": \"0.1.0\", \n"

    def geometry_unknown(m, b):
        m["geometry"]["primitives"].append({"type": "box", "center": [0, 0, 0], "size": [1, 1, 1], "material": "steel", "element": "Z9"})

    def scram_end(m, b):
        m["reactivity"]["rods"][0]["scram"]["x"][-1] = 0.1

    def scram_increasing(m, b):
        # stays in [0, 1] and ends at 0, but moves outward mid-scram (Rod.scram_tau needs a non-increasing profile)
        x = m["reactivity"]["rods"][0]["scram"]["x"]
        x[1], x[2] = x[2], x[1]

    def fire_time_missing(m, b):
        rod = next(r for r in m["reactivity"]["rods"] if r["pulseCapable"])
        del rod["fireTime"]

    def shape_dims(m, b):
        d = m["arrays"]["base"]
        d["shape"] = list(reversed(d["shape"]))

    def offset(m, b):
        m["arrays"]["base"]["byteLength"] += 4

    return [
        ("bad-json", ["E_JSON"], bad_json),
        ("unsupported-version", ["E_VERSION_UNSUPPORTED"], setp(["schemaVersion"], "9.0.0")),
        ("unsupported-capability", ["E_CAPABILITY_UNSUPPORTED"], setp(["capabilities"], ["point-kinetics/lumped-thermal-v1", "spatial-kinetics-v1"])),
        ("schema-missing-field", ["E_SCHEMA"], delp(["kinetics", "genTime"])),
        ("schema-unknown-field", ["E_SCHEMA"], setp(["reactivity", "extra"], 1)),
        ("schema-bad-operator", ["E_SCHEMA"], setp(["plant", "trips", 0, "predicate"], {"op": "approx", "value": 1.0})),
        ("unknown-signal", ["E_SIGNAL_UNKNOWN"], setp(["plant", "trips", 0, "input"], "truth.flux")),
        ("predicate-type", ["E_PREDICATE_TYPE"], setp(["plant", "trips", 0, "predicate"], {"op": "gt", "value": "high"})),
        ("mode-unknown", ["E_MODE_UNKNOWN"], setp(["plant", "initialMode"], "turbo")),
        ("pump-unknown", ["E_PUMP_UNKNOWN"], setp(["thermal", "heatExchanger", "pump"], "secondary")),
        ("ref-nonzero-rod", ["E_REF_NONZERO"], bump_worth),
        ("table-not-monotonic", ["E_TABLE_NOT_MONOTONIC"], swap_T),
        ("table-length", ["E_TABLE_LENGTH"], setp(["reactivity", "coolantTemp", "rho"], [0.0, 0.0, 0.0, 0.0])),
        ("scram-profile", ["E_SCRAM_PROFILE"], scram_end),
        ("scram-profile-increasing", ["E_SCRAM_PROFILE"], scram_increasing),
        ("pulse-rod-without-firetime", ["E_SCHEMA"], fire_time_missing),
        ("duplicate-element", ["E_DUPLICATE_ID", "E_GEOMETRY_ID"], dup_element),
        ("rod-unknown", ["E_ROD_UNKNOWN"], ghost_rod),
        ("synthetic-source-in-experimental", ["E_SOURCE_SYNTHETIC"], setp(["status"], "experimental")),
        ("path-unsafe", ["E_PATH_UNSAFE"], setp(["arrays", "base", "file"], "../base.f32")),
        ("file-missing", ["E_FILE_MISSING"], setp(["arrays", "base", "file"], "arrays/missing.f32")),
        ("offset-bounds", ["E_OFFSET_BOUNDS"], offset),
        ("digest-mismatch", ["E_DIGEST_MISMATCH"], setp(["arrays", "base", "sha256"], "0" * 64)),
        ("nonfinite", ["E_NONFINITE"], lambda m, b: _edit_array(m, b, "volumes", _nan)),
        ("shape-dims", ["E_SHAPE_DIMS"], shape_dims),
        ("array-unknown", ["E_ARRAY_UNKNOWN"], setp(["shapes", "base"], "nothing")),
        ("shape-normalization", ["E_SHAPE_NORMALIZATION"], lambda m, b: _edit_array(m, b, "base", _scale)),
        ("delta-sum", ["E_DELTA_SUM"], sum_breaking("tempDelta", 2)),
        ("shape-negative", ["E_SHAPE_NEGATIVE"], negative("rod_transient", 10)),
        ("delta-ref-nonzero", ["E_REF_NONZERO"], ref_nonzero_delta),
        ("volume-nonpositive", ["E_VOLUME_NONPOSITIVE"], lambda m, b: _edit_array(m, b, "volumes", _zero)),
        ("geometry-id", ["E_GEOMETRY_ID"], geometry_unknown),
    ]


def generate(out: Path = DEFAULT_OUT) -> list[str]:
    m, blobs = build_library()
    valid = out / "synthetic-core"
    write_library(valid, m, blobs)
    (valid / "README.md").write_bytes(README.encode("utf-8"))
    names = []
    inv_root = out / "invalid"
    if inv_root.exists():
        shutil.rmtree(inv_root)
    for name, codes, mutate in invalid_cases():
        mm, bb = copy.deepcopy(m), dict(blobs)
        text = mutate(mm, bb)
        folder = inv_root / name
        write_library(folder, mm, bb, text)
        (folder / "expected.json").write_bytes((json.dumps({"codes": codes}, indent=2) + "\n").encode("utf-8"))
        names.append(name)
    return names


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate the synthetic library and invalid fixtures.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    names = generate(args.out)
    print(f"wrote {args.out / 'synthetic-core'} and {len(names)} invalid fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
