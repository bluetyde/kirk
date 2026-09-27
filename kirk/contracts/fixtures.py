from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
from typing import Any

from kirk.engine import Engine
from kirk.libformat import load_params
from kirk.contracts.validate import json_form

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "schema" / "contract-vectors"
SYNTHETIC_CORE = REPO_ROOT / "schema" / "vectors" / "synthetic-core"


def clean_folder(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for p in folder.glob("*.json"):
        p.unlink()


def command_cases() -> list[tuple[str, dict, list[str], str]]:
    """Return list of (name, document, expectedCodes, note) for invalid commands."""
    return [
        (
            "unknown-type",
            {"type": "warp"},
            ["E_SCHEMA"],
            "Unknown command type 'warp'",
        ),
        (
            "rod-move-missing-rod",
            {"type": "rod.move", "direction": "in"},
            ["E_SCHEMA"],
            "Command 'rod.move' missing required 'rod' field",
        ),
        (
            "rod-move-bad-direction",
            {"type": "rod.move", "rod": "transient", "direction": "sideways"},
            ["E_SCHEMA"],
            "Command 'rod.move' with invalid direction 'sideways'",
        ),
        (
            "pump-set-bad-on",
            {"type": "pump.set", "pump": "primary", "on": "yes"},
            ["E_SCHEMA"],
            "Command 'pump.set' with string instead of boolean for 'on'",
        ),
        (
            "fault-instrument-bad-kind",
            {"type": "fault.instrument", "instrument": "linear", "kind": "drift"},
            ["E_SCHEMA"],
            "Command 'fault.instrument' with invalid kind 'drift'",
        ),
        (
            "fault-reactivity-bad-delta",
            {"type": "fault.reactivity", "deltaRho": "0.1"},
            ["E_SCHEMA"],
            "Command 'fault.reactivity' with string deltaRho instead of number",
        ),
        (
            "mode-set-bad-mode",
            {"type": "mode.set", "mode": 5},
            ["E_SCHEMA"],
            "Command 'mode.set' with integer mode instead of string",
        ),
        (
            "trip-reset-extra-key",
            {"type": "trip.reset", "extra": True},
            ["E_SCHEMA"],
            "Command 'trip.reset' with unexpected extra key",
        ),
    ]


def snapshot_cases(base_snapshot: dict) -> list[tuple[str, dict, list[str], str]]:
    """Return list of (name, document, expectedCodes, note) for invalid snapshots."""
    cases = []

    # 1. truth.power removed
    snap = copy.deepcopy(base_snapshot)
    del snap["truth"]["power"]
    cases.append((
        "missing-truth-power",
        snap,
        ["E_SCHEMA"],
        "Snapshot with 'truth.power' field removed",
    ))

    # 2. a rod position 1.5
    snap = copy.deepcopy(base_snapshot)
    first_rod = next(iter(snap["truth"]["rods"]))
    snap["truth"]["rods"][first_rod]["position"] = 1.5
    cases.append((
        "rod-position-out-of-bounds",
        snap,
        ["E_SCHEMA"],
        f"Snapshot with rod {first_rod} position set to 1.5 (> 1.0)",
    ))

    # 3. a rod moving "up"
    snap = copy.deepcopy(base_snapshot)
    first_rod = next(iter(snap["truth"]["rods"]))
    snap["truth"]["rods"][first_rod]["moving"] = "up"
    cases.append((
        "rod-moving-bad-enum",
        snap,
        ["E_SCHEMA"],
        f"Snapshot with rod {first_rod} moving set to 'up'",
    ))

    # 4. validity.status "fine"
    snap = copy.deepcopy(base_snapshot)
    snap["validity"]["status"] = "fine"
    cases.append((
        "validity-status-bad-enum",
        snap,
        ["E_SCHEMA"],
        "Snapshot with validity.status set to 'fine'",
    ))

    # 5. an indicated value "high"
    snap = copy.deepcopy(base_snapshot)
    first_ind = next(iter(snap["indicated"]))
    snap["indicated"][first_ind] = "high"
    cases.append((
        "indicated-value-not-number",
        snap,
        ["E_SCHEMA"],
        f"Snapshot with indicated {first_ind} value set to 'high'",
    ))

    # 6. an extra top-level key
    snap = copy.deepcopy(base_snapshot)
    snap["extra"] = "unexpected"
    cases.append((
        "extra-top-level-key",
        snap,
        ["E_SCHEMA"],
        "Snapshot with extra top-level key 'extra'",
    ))

    # 7. precursors with 5 entries
    snap = copy.deepcopy(base_snapshot)
    snap["truth"]["precursors"] = snap["truth"]["precursors"][:5]
    cases.append((
        "precursors-wrong-length",
        snap,
        ["E_SCHEMA"],
        "Snapshot with 5 precursor concentrations instead of 6",
    ))

    # 8. diagnostics.h removed
    snap = copy.deepcopy(base_snapshot)
    del snap["diagnostics"]["h"]
    cases.append((
        "missing-diagnostics-h",
        snap,
        ["E_SCHEMA"],
        "Snapshot with diagnostics.h field removed",
    ))

    # 9. tripped as 1
    snap = copy.deepcopy(base_snapshot)
    snap["tripped"] = 1
    cases.append((
        "tripped-not-boolean",
        snap,
        ["E_SCHEMA"],
        "Snapshot with tripped set to integer 1 instead of boolean",
    ))

    return cases


def generate_fixtures(out: Path = DEFAULT_OUT) -> tuple[int, int]:
    cmd_dir = out / "invalid" / "commands"
    snap_dir = out / "invalid" / "snapshots"
    clean_folder(cmd_dir)
    clean_folder(snap_dir)

    cmds = command_cases()
    for name, doc, codes, note in cmds:
        content = {
            "document": doc,
            "expectedCodes": codes,
            "note": note,
        }
        (cmd_dir / f"{name}.json").write_text(
            json.dumps(content, indent=1, sort_keys=True, allow_nan=False) + "\n",
            encoding="utf-8", newline="\n",   # LF on Windows too
        )

    engine = Engine(load_params(SYNTHETIC_CORE), {}, seed=1)
    for _ in range(10):
        engine.step()
    base_snapshot = json_form(engine.snapshot())

    snaps = snapshot_cases(base_snapshot)
    for name, doc, codes, note in snaps:
        content = {
            "document": doc,
            "expectedCodes": codes,
            "note": note,
        }
        (snap_dir / f"{name}.json").write_text(
            json.dumps(content, indent=1, sort_keys=True, allow_nan=False) + "\n",
            encoding="utf-8", newline="\n",   # LF on Windows too
        )

    return len(cmds), len(snaps)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate contract test fixtures.")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output directory")
    args = parser.parse_args(argv)

    n_cmds, n_snaps = generate_fixtures(args.out)
    print(f"wrote {n_cmds} command and {n_snaps} snapshot fixtures to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
