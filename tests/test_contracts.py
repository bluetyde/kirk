"""Tests for engine contracts: command and snapshot schemas, validators, and fixtures.

Standard library only.
"""
from __future__ import annotations

import copy
import json
import math
import unittest
from pathlib import Path

from kirk.engine import Engine
from kirk.library import Library
from kirk.vectors import _scenarios
from kirk.contracts.validate import (
    COMMAND_SCHEMA_PATH,
    SNAPSHOT_SCHEMA_PATH,
    json_form,
    validate_command,
    validate_snapshot,
)
from kirk.libformat.minischema import Validator, check_schema

REPO_ROOT = Path(__file__).resolve().parents[1]
SYNTHETIC_CORE = REPO_ROOT / "schema" / "vectors" / "synthetic-core"
CONTRACT_VECTORS = REPO_ROOT / "schema" / "contract-vectors"


class TestContractSchemas(unittest.TestCase):
    def test_schemas_pass_check_schema(self):
        """Both schemas use only keywords supported by minischema."""
        cmd_schema = json.loads(COMMAND_SCHEMA_PATH.read_text(encoding="utf-8"))
        snap_schema = json.loads(SNAPSHOT_SCHEMA_PATH.read_text(encoding="utf-8"))
        check_schema(cmd_schema)
        check_schema(snap_schema)


class TestEngineOracle(unittest.TestCase):
    def test_all_scenarios_validate(self):
        """Validate engine snapshots and scripted commands across all reference scenarios."""
        lib = Library(SYNTHETIC_CORE)
        for sc in _scenarios(lib):
            with self.subTest(scenario=sc["name"]):
                e = Engine(lib, init=sc["init"], seed=sc["seed"], config=sc["config"])
                script_by_step: dict[int, list[dict]] = {}
                for item in sc["script"]:
                    script_by_step.setdefault(item["step"], []).append(item["cmd"])

                # Initial snapshot is valid
                self.assertEqual(validate_snapshot(json_form(e.snapshot())), [])

                for k in range(sc["steps"]):
                    for cmd in script_by_step.get(k, []):
                        issues = validate_command(cmd)
                        if cmd.get("type") == "warp":
                            self.assertEqual({i.code for i in issues}, {"E_SCHEMA"})
                        else:
                            self.assertEqual(
                                issues,
                                [],
                                f"scenario {sc['name']} step {k} command {cmd} failed: {issues}",
                            )
                        e.submit(cmd)
                    e.step()
                    issues = validate_snapshot(json_form(e.snapshot()))
                    self.assertEqual(
                        issues,
                        [],
                        f"scenario {sc['name']} step {k} snapshot failed: {issues}",
                    )

                shape_issues = validate_snapshot(json_form(e.snapshot(include_shape=True)))
                self.assertEqual(
                    shape_issues,
                    [],
                    f"scenario {sc['name']} final snapshot with shape failed: {shape_issues}",
                )


class TestSnapshotJsonFormAndNonfinite(unittest.TestCase):
    def test_steady_state_snapshot_and_nonfinite(self):
        """Non-finite float in snapshot produces E_NONFINITE; json_form replaces with null and serializes."""
        lib = Library(SYNTHETIC_CORE)
        e = Engine(lib, {}, seed=1)
        raw_snap = e.snapshot()
        raw_snap["truth"]["period"] = math.inf

        # Raw snapshot with period = inf fails with exactly E_NONFINITE
        issues = validate_snapshot(raw_snap)
        self.assertEqual({i.code for i in issues}, {"E_NONFINITE"})
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0].path, "$.truth.period")

        # Converted json_form has null period, serializes without NaN/inf error, and validates cleanly
        jf = json_form(raw_snap)
        self.assertIsNone(jf["truth"]["period"])
        serialized = json.dumps(jf, allow_nan=False)
        self.assertIsInstance(serialized, str)
        self.assertEqual(validate_snapshot(jf), [])

    def test_json_form_deep_copy(self):
        """json_form produces an independent deep copy."""
        orig = {"a": [1.0, {"b": 2.0}]}
        copied = json_form(orig)
        copied["a"][1]["b"] = 99.0
        self.assertEqual(orig["a"][1]["b"], 2.0)

    def test_command_nonfinite(self):
        """Non-finite float in command produces E_NONFINITE."""
        issues = validate_command({"type": "fault.reactivity", "deltaRho": float("nan")})
        self.assertEqual({i.code for i in issues}, {"E_NONFINITE"})
        self.assertEqual(issues[0].path, "$.deltaRho")


class TestStructuralCommands(unittest.TestCase):
    def test_ghost_rod_command_is_schema_valid(self):
        """Unknown rod id is structurally valid per schema (engine's job to reject)."""
        cmd = {"type": "rod.move", "rod": "ghost", "direction": "out"}
        self.assertEqual(validate_command(cmd), [])


class TestInvalidFixtures(unittest.TestCase):
    def test_every_invalid_fixture_fails_with_expected_codes(self):
        """Every invalid fixture under schema/contract-vectors/invalid/ fails with expectedCodes."""
        cmd_dir = CONTRACT_VECTORS / "invalid" / "commands"
        snap_dir = CONTRACT_VECTORS / "invalid" / "snapshots"

        cmd_files = sorted(cmd_dir.glob("*.json"))
        self.assertGreaterEqual(len(cmd_files), 8)
        for p in cmd_files:
            with self.subTest(command_fixture=p.name):
                data = json.loads(p.read_text(encoding="utf-8"))
                issues = validate_command(data["document"])
                self.assertEqual({i.code for i in issues}, set(data["expectedCodes"]))

        snap_files = sorted(snap_dir.glob("*.json"))
        self.assertGreaterEqual(len(snap_files), 9)
        for p in snap_files:
            with self.subTest(snapshot_fixture=p.name):
                data = json.loads(p.read_text(encoding="utf-8"))
                issues = validate_snapshot(data["document"])
                self.assertEqual({i.code for i in issues}, set(data["expectedCodes"]))

    def test_catch_too_loose_schema(self):
        """Removing additionalProperties: false causes extra-top-level-key to pass."""
        schema = json.loads(SNAPSHOT_SCHEMA_PATH.read_text(encoding="utf-8"))
        loose_schema = copy.deepcopy(schema)
        del loose_schema["additionalProperties"]
        loose_validator = Validator(loose_schema)

        fixture_path = CONTRACT_VECTORS / "invalid" / "snapshots" / "extra-top-level-key.json"
        doc = json.loads(fixture_path.read_text(encoding="utf-8"))["document"]

        # Passes with loose schema
        self.assertEqual(loose_validator.errors(doc), [])

        # Fails with real schema
        self.assertEqual({i.code for i in validate_snapshot(doc)}, {"E_SCHEMA"})


class TestFalsificationAndEdgeCases(unittest.TestCase):
    def test_scram_immediate_snapshot_and_motion(self):
        """Snapshot right after scram and during scram insertion validates with shape included."""
        lib = Library(SYNTHETIC_CORE)
        e = Engine(lib, {"rods": {"safety": 1.0}}, seed=42)
        # Trigger scram
        e.submit({"type": "scram", "reason": "operator-drill"})
        # Step during scram
        e.step()
        snap = e.snapshot(include_shape=True)
        # Verify rod is actually in scram motion
        self.assertEqual(snap["truth"]["rods"]["safety"]["moving"], "in")
        self.assertTrue(snap["tripped"])
        self.assertIn("manual", snap["trips"]["latched"])
        # Validate snapshot
        issues = validate_snapshot(json_form(snap))
        self.assertEqual(issues, [])

    def test_nested_nonfinite_detected_at_exact_paths(self):
        """Non-finite floats nested in snapshot arrays or sub-objects are flagged with E_NONFINITE and correct path."""
        lib = Library(SYNTHETIC_CORE)
        e = Engine(lib, {}, seed=1)
        base = json_form(e.snapshot())

        test_cases = [
            ("$.truth.reactivity.total", ("truth", "reactivity", "total")),
            ("$.truth.precursors[3]", ("truth", "precursors", 3)),
            ("$.truth.rods.safety.position", ("truth", "rods", "safety", "position")),
            ("$.diagnostics.h", ("diagnostics", "h")),
        ]

        for expected_path, keys in test_cases:
            with self.subTest(path=expected_path):
                snap = copy.deepcopy(base)
                node = snap
                for k in keys[:-1]:
                    node = node[k]
                node[keys[-1]] = float("nan")

                issues = validate_snapshot(snap)
                self.assertEqual({i.code for i in issues}, {"E_NONFINITE"})
                self.assertEqual(issues[0].path, expected_path)

    def test_all_eight_commands_reject_additional_properties(self):
        """Every command schema strictly rejects extra keys."""
        valid_samples = [
            {"type": "rod.move", "rod": "safety", "direction": "in"},
            {"type": "rod.fire", "rod": "transient"},
            {"type": "mode.set", "mode": "pulse"},
            {"type": "pump.set", "pump": "primary", "on": True},
            {"type": "scram", "reason": "test"},
            {"type": "trip.reset"},
            {"type": "fault.reactivity", "deltaRho": 0.001},
            {"type": "fault.instrument", "instrument": "linear", "kind": "dead"},
        ]
        for cmd in valid_samples:
            with self.subTest(cmd_type=cmd["type"]):
                self.assertEqual(validate_command(cmd), [])
                bad_cmd = dict(cmd, unexpectedField="bad")
                issues = validate_command(bad_cmd)
                self.assertEqual({i.code for i in issues}, {"E_SCHEMA"})


if __name__ == "__main__":
    unittest.main()
