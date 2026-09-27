"""Deterministic golden-vector generator for the reference physics engine.

Usage (from repo root):
    python -m kirk.vectors
    python -m kirk.vectors --out DIR
"""
from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path

from .engine import Engine
from .libformat import load_params
from .params import Model, ReactorParams

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "schema" / "engine-vectors"
SYNTHETIC_CORE = REPO_ROOT / "schema" / "vectors" / "synthetic-core"

TOLERANCES = {
    "power": {"rel": 1e-9, "abs": 1e-15},
    "temperature": {"rel": 1e-9, "abs": 1e-9},   # rel added: abs alone was ~2e-12 relative at 500 K, tighter than platform libm noise
    "poisons": {"rel": 1e-9, "abs": 1.0},
    "eventTime": {"abs": 1e-9},
}


def near_critical_rods(params: ReactorParams, target_rho: float) -> dict[str, float]:
    """Safety fully out, transient in, regulating placed so the reference-temperature reactivity is target_rho."""
    m = Model(params)
    base = m.ref_rho + m.rod_by_id["safety"].worth(1.0)
    reg = m.rod_by_id["regulating"].worth
    lo, hi = 0.0, 1.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if base + reg(mid) < target_rho else (lo, mid)
    return {"safety": 1.0, "regulating": 0.5 * (lo + hi), "transient": 0.0}


def _scenarios(params: ReactorParams) -> list[dict]:
    """Scenario definitions. Built when generating, so importing this module has no side effects."""
    _near_crit = near_critical_rods(params, -0.0005)
    return [
        {
            "name": "source-level",
            "description": "Source-driven equilibrium with all rods fully inserted (reactivity -0.0325, subcritical).",
            "init": {},
            "seed": 1,
            "config": {"outerDt": 0.01},
            "steps": 100,
            "sampleEvery": 10,
            "script": [],
        },
        {
            "name": "rod-withdrawal",
            "description": "Transient rod withdrawal from near-critical state followed by stop.",
            "init": {"rods": copy.deepcopy(_near_crit)},
            "seed": 1,
            "config": {"outerDt": 0.01},
            "steps": 500,
            "sampleEvery": 25,
            "script": [
                {"step": 0, "cmd": {"type": "rod.move", "rod": "transient", "direction": "out"}},
                {"step": 300, "cmd": {"type": "rod.move", "rod": "transient", "direction": "stop"}},
            ],
        },
        {
            "name": "pulse",
            "description": "Prompt-critical pulse initiated by firing transient rod in pulse mode.",
            "init": {"rods": copy.deepcopy(_near_crit), "mode": "pulse"},
            "seed": 1,
            "config": {"outerDt": 0.001},
            "steps": 300,
            "sampleEvery": 5,
            "script": [
                {"step": 0, "cmd": {"type": "rod.fire", "rod": "transient"}},
            ],
        },
        {
            "name": "scram",
            "description": "Manual scram during rod withdrawal followed by rejected withdrawal attempt.",
            "init": {"rods": copy.deepcopy(_near_crit)},
            "seed": 1,
            "config": {"outerDt": 0.01},
            "steps": 400,
            "sampleEvery": 10,
            "script": [
                {"step": 0, "cmd": {"type": "rod.move", "rod": "transient", "direction": "out"}},
                {"step": 200, "cmd": {"type": "scram"}},
                {"step": 260, "cmd": {"type": "rod.move", "rod": "safety", "direction": "out"}},
            ],
        },
        {
            "name": "rejections",
            "description": "Command rejections from interlocks, rod capability, unknown targets, and instrument fault.",
            "init": {},
            "seed": 1,
            "config": {"outerDt": 0.01},
            "steps": 20,
            "sampleEvery": 5,
            "script": [
                {"step": 0, "cmd": {"type": "rod.fire", "rod": "transient"}},
                {"step": 0, "cmd": {"type": "rod.fire", "rod": "safety"}},
                {"step": 0, "cmd": {"type": "rod.move", "rod": "ghost", "direction": "out"}},
                {"step": 0, "cmd": {"type": "warp"}},
                {"step": 1, "cmd": {"type": "fault.instrument", "instrument": "linear", "kind": "dead"}},
            ],
        },
        {
            "name": "period-trip",
            "description": "Transient rod withdrawal triggering internal short-period trip.",
            "init": {"rods": copy.deepcopy(_near_crit)},
            "seed": 1,
            "config": {"outerDt": 0.01},
            "steps": 3000,
            "sampleEvery": 100,
            "script": [
                {"step": 0, "cmd": {"type": "rod.move", "rod": "transient", "direction": "out"}},
            ],
        },
    ]


def sample_from_engine(e: Engine) -> dict:
    snap = e.snapshot()
    truth = snap["truth"]
    return {
        "step": e.step_index,
        "t": snap["t"],
        "power": truth["power"],
        "precursors": list(truth["precursors"]),
        "fuelTemp": truth["fuelTemp"],
        "coolantTemp": truth["coolantTemp"],
        "iodine": truth["iodine"],
        "xenon": truth["xenon"],
        "energy": truth["energy"],
        "reactivityTotal": truth["reactivity"]["total"],
        "rods": {rid: r["position"] for rid, r in truth["rods"].items()},
        "mode": truth["mode"],
        "indicated": dict(snap["indicated"]),
        "tripped": snap["tripped"],
        "latched": list(snap["trips"]["latched"]),
        "validityStatus": snap["validity"]["status"],
    }


def run_scenario(params: ReactorParams, sc: dict) -> dict:
    e = Engine(params, init=sc["init"], seed=sc["seed"], config=sc["config"])
    sample_every = sc["sampleEvery"]
    total_steps = sc["steps"]

    script_by_step: dict[int, list[dict]] = {}
    for item in sc["script"]:
        script_by_step.setdefault(item["step"], []).append(item["cmd"])

    samples = [sample_from_engine(e)]
    sampled_steps = {0}

    for k in range(total_steps):
        for cmd in script_by_step.get(k, []):
            e.submit(cmd)
        e.step()
        if e.step_index % sample_every == 0 or e.step_index == total_steps:
            if e.step_index not in sampled_steps:
                samples.append(sample_from_engine(e))
                sampled_steps.add(e.step_index)

    return {
        "vectorFormat": 1,
        "name": sc["name"],
        "description": sc["description"],
        "init": copy.deepcopy(sc["init"]),
        "seed": sc["seed"],
        "config": copy.deepcopy(sc["config"]),
        "steps": sc["steps"],
        "sampleEvery": sc["sampleEvery"],
        "script": copy.deepcopy(sc["script"]),
        "libraryId": params["id"],
        "pins": e.pins(),
        "samples": samples,
        "events": copy.deepcopy(e.events),
        "final": {
            "peakPower": e.peak_power,
            "peakTime": e.peak_time,
        },
        "tolerances": copy.deepcopy(TOLERANCES),
    }


def generate(out: Path = DEFAULT_OUT) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    for p in out.glob("*.json"):
        p.unlink()

    params = load_params(SYNTHETIC_CORE)
    names = []
    for sc in _scenarios(params):
        doc = run_scenario(params, sc)
        content = json.dumps(doc, indent=1, sort_keys=True, allow_nan=False) + "\n"
        (out / f"{sc['name']}.json").write_bytes(content.encode("utf-8"))
        names.append(sc["name"])
    return names


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generate golden vectors for kirk engine.")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    names = generate(args.out)
    print(f"wrote {len(names)} engine vectors to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
