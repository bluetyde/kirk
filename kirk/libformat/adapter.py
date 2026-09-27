"""Build engine params (kirk.params) from a validated library folder.

The library format carries provenance ({value, source} wrappers), binary arrays and
validation metadata. load_params() validates the folder, then keeps only what the
engine reads: wrappers are removed and shape arrays are loaded inline.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

from kirk.params import CAPABILITY, ReactorParams


class LibraryError(Exception):
    def __init__(self, issues):
        self.issues = issues
        super().__init__("; ".join(f"{i.code} {i.path}" for i in issues[:5]))


def library_digest(folder) -> str:
    """SHA-256 over the manifest bytes and each array's sha256 in name order: the folder's identity.

    Engine pins use the params digest instead (kirk.params.params_digest)."""
    folder = Path(folder)
    m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    h = hashlib.sha256((folder / "manifest.json").read_bytes())
    for name in sorted(m["arrays"]):
        h.update(m["arrays"][name]["sha256"].encode())
    return h.hexdigest()


def _table(t: dict, axis: str, value: str) -> dict:
    return {"x": list(t[axis]), "y": list(t[value]), "outOfRange": t["outOfRange"]}


def _load_array(folder: Path, d: dict) -> list[float]:
    data = (folder / d["file"]).read_bytes()
    n = int(d["byteLength"]) // 4        # integral floats (0.0) are valid JSON integers
    return list(struct.unpack_from(f"<{n}f", data, int(d["offset"])))


def params_from_manifest(m: dict, arrays: dict[str, list[float]]) -> ReactorParams:
    """Params from a parsed manifest and its loaded arrays (the folder must already be valid)."""
    if CAPABILITY not in m["capabilities"]:
        raise ValueError(f"library doesn't declare {CAPABILITY}")
    ref, k, r, t, po, pl = (m["reference"], m["kinetics"], m["reactivity"], m["thermal"], m["poisons"], m["plant"])
    rods = []
    for d in r["rods"]:
        rod = {"id": d["id"], "name": d["name"], "travelCm": d["travelCm"], "speed": d["speed"],
               "pulseCapable": d["pulseCapable"], "worth": _table(d["worth"], "x", "rho"),
               "scram": {"t": list(d["scram"]["t"]), "x": list(d["scram"]["x"])}}
        if "fireTime" in d:
            rod["fireTime"] = d["fireTime"]
        rods.append(rod)
    dom, sh = m["domain"], m["shapes"]
    return {
        "id": m["id"],
        "kinetics": {"beta": list(k["beta"]["values"]), "lambda": list(k["lambda"]["values"]),
                     "genTime": k["genTime"]["value"], "extSource": k["extSource"]["value"]},
        "reference": {"rods": dict(ref["rods"]), "Tfuel": ref["Tfuel"]["value"], "Tcoolant": ref["Tcoolant"]["value"],
                      "rho": ref["rho"]["value"],
                      "calibration": ref["calibration"]["deltaRho"] if ref["calibration"] else 0.0},
        "rods": rods,
        "feedback": {"fuelTemp": _table(r["fuelTemp"], "T", "rho"),
                     "coolantTemp": _table(r["coolantTemp"], "T", "rho"),
                     "xenon": _table(r["xenon"], "N", "rho")},
        "thermal": {"fuelMass": t["fuel"]["mass"]["value"], "fuelCp": _table(t["fuel"]["cp"], "T", "c"),
                    "coolantMass": t["coolant"]["mass"]["value"], "coolantCp": t["coolant"]["cp"]["value"],
                    "hA": t["hA"]["value"], "UA": t["heatExchanger"]["UA"]["value"],
                    "sinkTemp": t["heatExchanger"]["sinkTemp"]["value"], "hxPump": t["heatExchanger"]["pump"],
                    "fuelFraction": t["deposition"]["fuelFraction"]["value"]},
        "poisons": {key: po[key]["value"] for key in
                    ("fluxPerWatt", "sigmaF", "gammaI", "gammaXe", "lambdaI", "lambdaXe", "sigmaXe")},
        "plant": {"modes": list(pl["modes"]), "initialMode": pl["initialMode"],
                  "pumps": [x["id"] for x in pl["pumps"]],
                  "instruments": [dict(i) for i in pl["instruments"]],
                  "trips": [dict(tr) for tr in pl["trips"]],
                  "interlocks": [dict(i) for i in pl["interlocks"]]},
        "validity": {"status": m["status"], "rods": {rid: list(v) for rid, v in dom["rods"].items()},
                     "Tfuel": list(dom["Tfuel"]), "Tcoolant": list(dom["Tcoolant"]), "xenon": list(dom["xenon"]),
                     "jointChecked": [{"rods": dict(jc["rods"])} for jc in dom["jointChecked"]]},
        "shape": {"elements": list(sh["bins"]["elements"]), "axialEdgesCm": list(sh["bins"]["axialEdgesCm"]),
                  "base": arrays[sh["base"]],
                  "rodDeltas": {rid: {"x": list(d["x"]), "values": arrays[d["array"]]}
                                for rid, d in sh["rodDeltas"].items()},
                  "tempDelta": {"x": list(sh["tempDelta"]["T"]), "values": arrays[sh["tempDelta"]["array"]]}},
    }


def load_params(folder) -> ReactorParams:
    """Validate a library folder and return engine params. Raises LibraryError on any validation issue."""
    from kirk.libformat.validate import validate_library   # here, so `python -m kirk.libformat.validate` imports it once

    folder = Path(folder)
    issues = validate_library(folder)
    if issues:
        raise LibraryError(issues)
    m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    arrays = {name: _load_array(folder, d) for name, d in m["arrays"].items()}
    return params_from_manifest(m, arrays)
