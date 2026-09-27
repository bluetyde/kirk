"""Plain engine inputs ("params") for capability point-kinetics/lumped-thermal-v1.

The engine runs from a ReactorParams object: plain, JSON-shaped data (dicts, lists,
strings, numbers, booleans, None) with the same camelCase keys in Python and
TypeScript. No files are needed. kirk.libformat builds params from a library folder.

    check_params(p)    structural checks; raises ParamsError with a JSON path
    params_digest(p)   SHA-256 of a canonical encoding; the engine pins it in
                       checkpoints and sessions, so an edited copy can't pass as the original
    Model(p)           the compiled form the engine reads (tables, rods, sums)

Table, Rod and Model keep the explicit left-to-right sums of numerics.py.
"""
from __future__ import annotations

import bisect
import hashlib
import json
import math
import struct
from typing import Any, NotRequired, TypedDict

CAPABILITY = "point-kinetics/lumped-thermal-v1"
DIGEST_PREFIX = "kirk-params-v1\n"
OUT_OF_RANGE = ("clamp-and-flag", "extrapolate-and-flag", "reject")
STATUSES = ("synthetic", "experimental", "validated-for-domain")
TRUTH_SIGNALS = ("power", "period", "fuelTemp", "coolantTemp", "xenon", "mode")
OPS = ("gt", "ge", "lt", "le", "absGt", "eq", "ne", "between")
COMMAND_TYPES = ("rod.move", "rod.fire", "mode.set", "pump.set", "scram", "trip.reset",
                 "fault.reactivity", "fault.instrument")


# ---------------------------------------------------------------- types (documentation; plain dicts at run time)

class TableParams(TypedDict):
    x: list[float]                  # strictly increasing, at least 2 points
    y: list[float]
    outOfRange: NotRequired[str]    # "clamp-and-flag" (default), "extrapolate-and-flag" or "reject"


# Functional form, because "lambda" is a Python keyword.
KineticsParams = TypedDict("KineticsParams", {
    "beta": list[float],            # 6 delayed-neutron fractions
    "lambda": list[float],          # 6 decay constants, 1/s
    "genTime": float,               # s
    "extSource": float,             # W/s, may be 0
})


class ReferenceParams(TypedDict):
    rods: dict[str, float]          # rod positions (0..1) at which rho was measured
    Tfuel: float                    # K
    Tcoolant: float                 # K
    rho: float                      # reactivity of the reference state
    calibration: NotRequired[float]  # added to rho (default 0)


class ScramParams(TypedDict):
    t: list[float]                  # s, starts at 0, strictly increasing
    x: list[float]                  # position, non-increasing


class RodParams(TypedDict):
    id: str
    speed: float                    # fraction/s
    pulseCapable: bool
    fireTime: NotRequired[float]    # s, pulse-capable rods only
    worth: TableParams              # rho vs position (0..1)
    scram: ScramParams
    name: NotRequired[str]
    travelCm: NotRequired[float]


class FeedbackParams(TypedDict):
    fuelTemp: TableParams           # rho vs fuel temperature (K)
    coolantTemp: TableParams        # rho vs coolant temperature (K)
    xenon: TableParams              # rho vs xenon number


class ThermalParams(TypedDict):
    fuelMass: float                 # kg
    fuelCp: TableParams             # J/(kg K) vs fuel temperature (K)
    coolantMass: float              # kg
    coolantCp: float                # J/(kg K)
    hA: float                       # W/K, fuel to coolant
    UA: float                       # W/K, coolant to sink while hxPump runs
    sinkTemp: float                 # K
    hxPump: str | None              # pump id, or None for no heat exchanger
    fuelFraction: float             # fraction of power deposited in the fuel


class PoisonParams(TypedDict):
    fluxPerWatt: float
    sigmaF: float
    gammaI: float
    gammaXe: float
    lambdaI: float
    lambdaXe: float
    sigmaXe: float


class PlantParams(TypedDict):
    modes: list[str]
    initialMode: str
    pumps: list[str]
    instruments: list[dict]         # {id, signal, scale, range, lag, noise}
    trips: list[dict]               # {id, input, predicate, modes?, latching}
    interlocks: list[dict]          # {id, when, blocks, reason}


class ValidityParams(TypedDict):
    status: str                     # "synthetic", "experimental" or "validated-for-domain"
    rods: dict[str, list[float]]    # [lo, hi] per rod
    Tfuel: list[float]
    Tcoolant: list[float]
    xenon: list[float]
    jointChecked: list[dict]        # [{rods: {id: x}}]


class ShapeParams(TypedDict):
    elements: list[str]
    axialEdgesCm: list[float]
    base: list[float]               # E*A values
    rodDeltas: dict[str, dict]      # {rodId: {x: [...], values: [len(x)*E*A]}}
    tempDelta: dict                 # {x: [...K], values: [len(x)*E*A]}


class ReactorParams(TypedDict):
    id: str
    kinetics: KineticsParams
    reference: ReferenceParams
    rods: list[RodParams]
    feedback: FeedbackParams
    thermal: ThermalParams
    poisons: PoisonParams
    plant: PlantParams
    validity: NotRequired[ValidityParams]
    shape: NotRequired[ShapeParams]


# ---------------------------------------------------------------- checks

class ParamsError(ValueError):
    def __init__(self, path: str, message: str):
        self.path = path
        super().__init__(f"{path}: {message}")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class _Checker:
    def fail(self, path, message):
        raise ParamsError(path, message)

    def obj(self, v, path, required, optional=()):
        if not isinstance(v, dict):
            self.fail(path, "must be an object")
        for k in required:
            if k not in v:
                self.fail(f"{path}.{k}", "is required")
        for k in v:
            if k not in required and k not in optional:
                self.fail(f"{path}.{k}", "unknown key")
        return v

    def str_(self, v, path):
        if not isinstance(v, str) or not v:
            self.fail(path, "must be a non-empty string")
        return v

    def number(self, v, path, lo=None, positive=False):
        if not _num(v):
            self.fail(path, "must be a finite number")
        if positive and not v > 0:
            self.fail(path, "must be > 0")
        if lo is not None and v < lo:
            self.fail(path, f"must be >= {lo}")
        return v

    def numbers(self, v, path, n=None, min_len=0):
        if not isinstance(v, list):
            self.fail(path, "must be a list of numbers")
        if n is not None and len(v) != n:
            self.fail(path, f"must have {n} values")
        if len(v) < min_len:
            self.fail(path, f"must have at least {min_len} values")
        for i, x in enumerate(v):
            self.number(x, f"{path}[{i}]")
        return v

    def increasing(self, xs, path):
        for i in range(len(xs) - 1):
            if not xs[i] < xs[i + 1]:
                self.fail(path, "must be strictly increasing")

    def interval(self, v, path):
        self.numbers(v, path, n=2)
        if v[0] > v[1]:
            self.fail(path, "must be [lo, hi] with lo <= hi")

    def ids(self, v, path):
        if not isinstance(v, list):
            self.fail(path, "must be a list")
        seen = set()
        for i, x in enumerate(v):
            self.str_(x, f"{path}[{i}]")
            if x in seen:
                self.fail(f"{path}[{i}]", f"duplicate id {x!r}")
            seen.add(x)
        return v

    def table(self, t, path):
        self.obj(t, path, ("x", "y"), ("outOfRange",))
        self.numbers(t["x"], f"{path}.x", min_len=2)
        self.numbers(t["y"], f"{path}.y", n=len(t["x"]))
        self.increasing(t["x"], f"{path}.x")
        if t.get("outOfRange", "clamp-and-flag") not in OUT_OF_RANGE:
            self.fail(f"{path}.outOfRange", f"must be one of {', '.join(OUT_OF_RANGE)}")

    def signal_ok(self, sig, rods, instruments):
        if not isinstance(sig, str):
            return False
        if sig.startswith("truth."):
            name = sig[len("truth."):]
            return name in TRUTH_SIGNALS or (name.startswith("rod.") and name[4:] in rods)
        return sig.startswith("indicated.") and sig[len("indicated."):] in instruments

    def predicate(self, p, path, default, rods, instruments):
        if not isinstance(p, dict):
            self.fail(path, "must be an object")
        for key in ("all", "any"):
            if key in p:
                self.obj(p, path, (key,))
                if not isinstance(p[key], list) or not p[key]:
                    self.fail(f"{path}.{key}", "must be a non-empty list")
                for i, sub in enumerate(p[key]):
                    self.predicate(sub, f"{path}.{key}[{i}]", default, rods, instruments)
                return
        if "not" in p:
            self.obj(p, path, ("not",))
            self.predicate(p["not"], f"{path}.not", default, rods, instruments)
            return
        self.obj(p, path, ("op", "value"), ("signal",))
        sig = p.get("signal", default)
        if sig is None:
            self.fail(path, "must name a signal")
        if not self.signal_ok(sig, rods, instruments):
            self.fail(path, f"unknown signal {sig!r}")
        op, value = p["op"], p["value"]
        if op not in OPS:
            self.fail(f"{path}.op", f"unknown operator {op!r}")
        if op == "between":
            self.interval(value, f"{path}.value")
        elif isinstance(value, str):
            if op not in ("eq", "ne"):
                self.fail(f"{path}.value", "string values need eq or ne")
        elif not _num(value):
            self.fail(f"{path}.value", "must be a number or a string")
        if sig == "truth.mode" and op not in ("eq", "ne"):
            self.fail(f"{path}.op", "truth.mode only supports eq and ne")

    def run(self, p):
        self.obj(p, "$", ("id", "kinetics", "reference", "rods", "feedback", "thermal", "poisons", "plant"),
                 ("validity", "shape"))
        self.str_(p["id"], "$.id")

        k = self.obj(p["kinetics"], "$.kinetics", ("beta", "lambda", "genTime", "extSource"))
        self.numbers(k["beta"], "$.kinetics.beta", n=6)
        self.numbers(k["lambda"], "$.kinetics.lambda", n=6)
        for i in range(6):
            self.number(k["beta"][i], f"$.kinetics.beta[{i}]", lo=0.0)
            self.number(k["lambda"][i], f"$.kinetics.lambda[{i}]", positive=True)
        self.number(k["genTime"], "$.kinetics.genTime", positive=True)
        self.number(k["extSource"], "$.kinetics.extSource", lo=0.0)

        if not isinstance(p["rods"], list):
            self.fail("$.rods", "must be a list")
        rod_ids = self.ids([r.get("id") if isinstance(r, dict) else None for r in p["rods"]], "$.rods[*].id")
        for i, r in enumerate(p["rods"]):
            path = f"$.rods[{i}]"
            self.obj(r, path, ("id", "speed", "pulseCapable", "worth", "scram"), ("fireTime", "name", "travelCm"))
            self.number(r["speed"], f"{path}.speed", positive=True)
            if not isinstance(r["pulseCapable"], bool):
                self.fail(f"{path}.pulseCapable", "must be true or false")
            if r["pulseCapable"] != ("fireTime" in r):
                self.fail(f"{path}.fireTime", "pulse-capable rods need fireTime, and only they may have it")
            if "fireTime" in r:
                self.number(r["fireTime"], f"{path}.fireTime", positive=True)
            if "name" in r:
                self.str_(r["name"], f"{path}.name")
            if "travelCm" in r:
                self.number(r["travelCm"], f"{path}.travelCm", positive=True)
            self.table(r["worth"], f"{path}.worth")
            s = self.obj(r["scram"], f"{path}.scram", ("t", "x"))
            self.numbers(s["t"], f"{path}.scram.t", min_len=2)
            self.numbers(s["x"], f"{path}.scram.x", n=len(s["t"]))
            self.increasing(s["t"], f"{path}.scram.t")
            if s["t"][0] != 0.0:
                self.fail(f"{path}.scram.t", "must start at 0")
            for j in range(len(s["x"])):
                if not 0.0 <= s["x"][j] <= 1.0:
                    self.fail(f"{path}.scram.x[{j}]", "must be in [0, 1]")
            for j in range(len(s["x"]) - 1):
                if s["x"][j] < s["x"][j + 1]:
                    self.fail(f"{path}.scram.x", "must be non-increasing")
            if s["x"][-1] != 0.0:
                self.fail(f"{path}.scram.x", "must end at 0 (fully inserted)")

        ref = self.obj(p["reference"], "$.reference", ("rods", "Tfuel", "Tcoolant", "rho"), ("calibration",))
        self.obj(ref["rods"], "$.reference.rods", rod_ids)
        for rid in rod_ids:
            x = self.number(ref["rods"][rid], f"$.reference.rods.{rid}")
            if not 0.0 <= x <= 1.0:
                self.fail(f"$.reference.rods.{rid}", "must be in [0, 1]")
        for key in ("Tfuel", "Tcoolant", "rho", "calibration"):
            if key in ref:
                self.number(ref[key], f"$.reference.{key}")

        fb = self.obj(p["feedback"], "$.feedback", ("fuelTemp", "coolantTemp", "xenon"))
        for key in ("fuelTemp", "coolantTemp", "xenon"):
            self.table(fb[key], f"$.feedback.{key}")

        pl = self.obj(p["plant"], "$.plant", ("modes", "initialMode", "pumps", "instruments", "trips", "interlocks"))
        modes = self.ids(pl["modes"], "$.plant.modes")
        if pl["initialMode"] not in modes:
            self.fail("$.plant.initialMode", "must be one of modes")
        pumps = self.ids(pl["pumps"], "$.plant.pumps")

        t = self.obj(p["thermal"], "$.thermal", ("fuelMass", "fuelCp", "coolantMass", "coolantCp", "hA", "UA",
                                                 "sinkTemp", "hxPump", "fuelFraction"))
        for key in ("fuelMass", "coolantMass", "coolantCp"):
            self.number(t[key], f"$.thermal.{key}", positive=True)
        for key in ("hA", "UA"):
            self.number(t[key], f"$.thermal.{key}", lo=0.0)
        self.number(t["sinkTemp"], "$.thermal.sinkTemp")
        self.table(t["fuelCp"], "$.thermal.fuelCp")
        for i, c in enumerate(t["fuelCp"]["y"]):
            if not c > 0:
                self.fail(f"$.thermal.fuelCp.y[{i}]", "must be > 0")
        if t["hxPump"] is not None and t["hxPump"] not in pumps:
            self.fail("$.thermal.hxPump", "must be a pump id or null")
        f = self.number(t["fuelFraction"], "$.thermal.fuelFraction")
        if not 0.0 <= f <= 1.0:
            self.fail("$.thermal.fuelFraction", "must be in [0, 1]")

        po = self.obj(p["poisons"], "$.poisons", ("fluxPerWatt", "sigmaF", "gammaI", "gammaXe", "lambdaI",
                                                  "lambdaXe", "sigmaXe"))
        for key in po:
            self.number(po[key], f"$.poisons.{key}", lo=0.0)
        for key in ("lambdaI", "lambdaXe"):
            self.number(po[key], f"$.poisons.{key}", positive=True)

        if not isinstance(pl["instruments"], list):
            self.fail("$.plant.instruments", "must be a list")
        inst_ids = self.ids([x.get("id") if isinstance(x, dict) else None for x in pl["instruments"]],
                            "$.plant.instruments[*].id")
        for i, ins in enumerate(pl["instruments"]):
            path = f"$.plant.instruments[{i}]"
            self.obj(ins, path, ("id", "signal", "scale", "range", "lag", "noise"))
            sig = ins["signal"]
            if not self.signal_ok(sig, rod_ids, ()) or not sig.startswith("truth.") or sig == "truth.mode":
                self.fail(f"{path}.signal", "must be a numeric truth signal")
            if ins["scale"] not in ("linear", "log"):
                self.fail(f"{path}.scale", "must be linear or log")
            self.interval(ins["range"], f"{path}.range")
            self.number(ins["lag"], f"{path}.lag", lo=0.0)
            self.number(ins["noise"], f"{path}.noise", lo=0.0)

        if not isinstance(pl["trips"], list):
            self.fail("$.plant.trips", "must be a list")
        self.ids([x.get("id") if isinstance(x, dict) else None for x in pl["trips"]], "$.plant.trips[*].id")
        for i, tr in enumerate(pl["trips"]):
            path = f"$.plant.trips[{i}]"
            self.obj(tr, path, ("id", "input", "predicate", "latching"), ("modes",))
            if not self.signal_ok(tr["input"], rod_ids, inst_ids):
                self.fail(f"{path}.input", f"unknown signal {tr['input']!r}")
            self.predicate(tr["predicate"], f"{path}.predicate", tr["input"], rod_ids, inst_ids)
            if not isinstance(tr["latching"], bool):
                self.fail(f"{path}.latching", "must be true or false")
            if "modes" in tr:
                for j, m in enumerate(self.ids(tr["modes"], f"{path}.modes")):
                    if m not in modes:
                        self.fail(f"{path}.modes[{j}]", f"unknown mode {m!r}")

        if not isinstance(pl["interlocks"], list):
            self.fail("$.plant.interlocks", "must be a list")
        self.ids([x.get("id") if isinstance(x, dict) else None for x in pl["interlocks"]],
                 "$.plant.interlocks[*].id")
        for i, il in enumerate(pl["interlocks"]):
            path = f"$.plant.interlocks[{i}]"
            self.obj(il, path, ("id", "when", "blocks", "reason"))
            self.predicate(il["when"], f"{path}.when", None, rod_ids, inst_ids)
            for j, c in enumerate(self.ids(il["blocks"], f"{path}.blocks")):
                if c not in COMMAND_TYPES:
                    self.fail(f"{path}.blocks[{j}]", f"unknown command type {c!r}")
            self.str_(il["reason"], f"{path}.reason")

        if "validity" in p:
            v = self.obj(p["validity"], "$.validity", ("status", "rods", "Tfuel", "Tcoolant", "xenon", "jointChecked"))
            if v["status"] not in STATUSES:
                self.fail("$.validity.status", f"must be one of {', '.join(STATUSES)}")
            self.obj(v["rods"], "$.validity.rods", rod_ids)
            for rid in rod_ids:
                self.interval(v["rods"][rid], f"$.validity.rods.{rid}")
            for key in ("Tfuel", "Tcoolant", "xenon"):
                self.interval(v[key], f"$.validity.{key}")
            if not isinstance(v["jointChecked"], list):
                self.fail("$.validity.jointChecked", "must be a list")
            for i, jc in enumerate(v["jointChecked"]):
                self.obj(jc, f"$.validity.jointChecked[{i}]", ("rods",))
                self.obj(jc["rods"], f"$.validity.jointChecked[{i}].rods", (), rod_ids)
                for rid, x in jc["rods"].items():
                    self.number(x, f"$.validity.jointChecked[{i}].rods.{rid}")

        if "shape" in p:
            s = self.obj(p["shape"], "$.shape", ("elements", "axialEdgesCm", "base", "rodDeltas", "tempDelta"))
            self.ids(s["elements"], "$.shape.elements")
            self.numbers(s["axialEdgesCm"], "$.shape.axialEdgesCm", min_len=2)
            self.increasing(s["axialEdgesCm"], "$.shape.axialEdgesCm")
            n = len(s["elements"]) * (len(s["axialEdgesCm"]) - 1)
            self.numbers(s["base"], "$.shape.base", n=n)
            self.obj(s["rodDeltas"], "$.shape.rodDeltas", (), rod_ids)
            deltas = [(f"$.shape.rodDeltas.{rid}", d) for rid, d in s["rodDeltas"].items()]
            for path, d in deltas + [("$.shape.tempDelta", s["tempDelta"])]:
                self.obj(d, path, ("x", "values"))
                self.numbers(d["x"], f"{path}.x", min_len=2)
                self.increasing(d["x"], f"{path}.x")
                self.numbers(d["values"], f"{path}.values", n=len(d["x"]) * n)


def check_params(p: ReactorParams) -> None:
    """Raise ParamsError (with a JSON path) at the first structural problem in p."""
    _Checker().run(p)


# ---------------------------------------------------------------- digest

def _canon(v: Any, out: list[str]) -> None:
    """Canonical text: sorted keys, no whitespace, ASCII-only strings, numbers as float64 big-endian bits."""
    if v is None:
        out.append("null")
    elif v is True:
        out.append("true")
    elif v is False:
        out.append("false")
    elif isinstance(v, (int, float)):
        out.append("f" + struct.pack(">d", float(v)).hex())
    elif isinstance(v, str):
        out.append(_json_string(v))
    elif isinstance(v, (list, tuple)):
        out.append("[")
        for i, x in enumerate(v):
            if i:
                out.append(",")
            _canon(x, out)
        out.append("]")
    elif isinstance(v, dict):
        out.append("{")
        for i, k in enumerate(sorted(v)):
            if i:
                out.append(",")
            out.append(_json_string(k))
            out.append(":")
            _canon(v[k], out)
        out.append("}")
    else:
        raise TypeError(f"params can't hold {type(v).__name__}")


def _json_string(s: str) -> str:
    return json.dumps(s, ensure_ascii=True)


def params_digest(p: ReactorParams) -> str:
    out: list[str] = [DIGEST_PREFIX]
    _canon(p, out)
    return hashlib.sha256("".join(out).encode("ascii")).hexdigest()


# ---------------------------------------------------------------- compiled form

class Table:
    """Piecewise-linear table with declared out-of-range behaviour.

    value(x) returns (y, flag) where flag is None inside the table, else "below"/"above".
    "clamp-and-flag" holds the end value; "extrapolate-and-flag" extends the end segment;
    "reject" still clamps here, and the engine turns the flag into a rejected state.
    """

    def __init__(self, xs, ys, out_of_range="clamp-and-flag"):
        if len(xs) != len(ys) or len(xs) < 2:
            raise ValueError("table needs two equal-length columns of at least 2 points")
        self.xs, self.ys, self.out_of_range = list(xs), list(ys), out_of_range

    @classmethod
    def of(cls, t: TableParams) -> "Table":
        return cls(t["x"], t["y"], t.get("outOfRange", "clamp-and-flag"))

    def value(self, x):
        xs, ys = self.xs, self.ys
        if x < xs[0]:
            if self.out_of_range == "extrapolate-and-flag":
                return ys[0] + (x - xs[0]) * (ys[1] - ys[0]) / (xs[1] - xs[0]), "below"
            return ys[0], "below"
        if x > xs[-1]:
            if self.out_of_range == "extrapolate-and-flag":
                return ys[-1] + (x - xs[-1]) * (ys[-1] - ys[-2]) / (xs[-1] - xs[-2]), "above"
            return ys[-1], "above"
        i = min(bisect.bisect_right(xs, x) - 1, len(xs) - 2)
        t = (x - xs[i]) / (xs[i + 1] - xs[i])
        return ys[i] + t * (ys[i + 1] - ys[i]), None

    def __call__(self, x):
        return self.value(x)[0]

    def integral(self, a, b):
        """Exact integral of the piecewise-linear table from a to b (clamped ends held constant)."""
        if b < a:
            return -self.integral(b, a)
        pts = [a] + [x for x in self.xs if a < x < b] + [b]
        total = 0.0             # explicit loop, not sum(): see numerics.py
        for p, q in zip(pts, pts[1:]):
            total += 0.5 * (self(p) + self(q)) * (q - p)
        return total


class Rod:
    def __init__(self, d: RodParams):
        self.id = d["id"]
        self.name = d.get("name", d["id"])
        self.travel_cm = d.get("travelCm")
        self.speed = d["speed"]
        self.pulse_capable = d["pulseCapable"]
        self.fire_time = d.get("fireTime")
        self.worth = Table.of(d["worth"])
        self.scram_t = list(d["scram"]["t"])
        self.scram_x = list(d["scram"]["x"])
        self._scram_table = Table(self.scram_t, self.scram_x)

    def scram_position(self, tau):
        """Position tau seconds along the scram profile."""
        return self._scram_table(tau)

    def scram_tau(self, x):
        """Time along the scram profile where the profile first reaches position x (profile is non-increasing)."""
        ts, xs = self.scram_t, self.scram_x
        if x >= xs[0]:
            return 0.0
        for i in range(len(xs) - 1):
            if xs[i] >= x >= xs[i + 1]:
                if xs[i] == xs[i + 1]:
                    return ts[i]
                return ts[i] + (xs[i] - x) / (xs[i] - xs[i + 1]) * (ts[i + 1] - ts[i])
        return ts[-1]


class Model:
    """Read-only compiled view of checked params, in the form the engine's hot path reads."""

    def __init__(self, p: ReactorParams):
        self.id = p["id"]

        ref = p["reference"]
        self.ref_rods = dict(ref["rods"])
        self.ref_tfuel = ref["Tfuel"]
        self.ref_tcool = ref["Tcoolant"]
        self.ref_rho = ref["rho"]
        self.calibration = ref.get("calibration", 0.0)

        k = p["kinetics"]
        self.beta = list(k["beta"])
        self.lam = list(k["lambda"])
        self.beta_total = 0.0
        for b in self.beta:     # explicit loop, not sum(): see numerics.py
            self.beta_total += b
        self.gen_time = k["genTime"]
        self.ext_source = k["extSource"]

        self.rods = [Rod(d) for d in p["rods"]]
        self.rod_by_id = {rod.id: rod for rod in self.rods}
        fb = p["feedback"]
        self.fuel_temp = Table.of(fb["fuelTemp"])
        self.cool_temp = Table.of(fb["coolantTemp"])
        self.xenon = Table.of(fb["xenon"])

        t = p["thermal"]
        self.fuel_mass = t["fuelMass"]
        self.fuel_cp = Table.of(t["fuelCp"])
        self.cool_mass = t["coolantMass"]
        self.cool_cp = t["coolantCp"]
        self.hA = t["hA"]
        self.UA = t["UA"]
        self.sink_temp = t["sinkTemp"]
        self.hx_pump = t["hxPump"]
        self.fuel_fraction = t["fuelFraction"]

        po = p["poisons"]
        self.flux_per_watt = po["fluxPerWatt"]
        self.sigma_f = po["sigmaF"]
        self.gamma_i = po["gammaI"]
        self.gamma_x = po["gammaXe"]
        self.lambda_i = po["lambdaI"]
        self.lambda_x = po["lambdaXe"]
        self.sigma_x = po["sigmaXe"]

        pl = p["plant"]
        self.modes = list(pl["modes"])
        self.initial_mode = pl["initialMode"]
        self.pumps = list(pl["pumps"])
        self.instruments = [dict(i) for i in pl["instruments"]]
        self.trips = [dict(tr) for tr in pl["trips"]]
        self.interlocks = [dict(i) for i in pl["interlocks"]]

        self.validity = p.get("validity")
        self.shape = p.get("shape")
