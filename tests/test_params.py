"""Tests for the plain parameter API (kirk.params): running without a library, checks, digest.

Run from the repo root:  python -m unittest
"""
from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from kirk import CheckpointError, Engine, ParamsError, check_params, params_digest
from kirk.engine import IP
from kirk.params import _canon

# Shared with js/src/sim/params.test.ts: the base core, check cases and digests both languages must agree on.
CHECKS = json.loads((Path(__file__).resolve().parents[1] / "schema" / "params-vectors" / "checks.json")
                    .read_text(encoding="utf-8"))


def tiny_core():
    """A made-up one-rod core, written by hand: no library folder, no validity or shape sections."""
    return copy.deepcopy(CHECKS["base"])


def apply_edits(p, edits):
    for ed in edits:
        *head, last = ed["path"]
        node = p
        for k in head:
            node = node[k]
        if "value" in ed:
            node[last] = copy.deepcopy(ed["value"])
        elif ed.get("delete"):
            del node[last]
        elif "append" in ed:
            node[last].append(copy.deepcopy(ed["append"]))
        else:
            node[last] = float(ed["nonfinite"])
    return p


class TestPlainParams(unittest.TestCase):
    def test_hand_built_core_runs(self):
        e = Engine(tiny_core())
        p0 = e.y[IP]
        self.assertAlmostEqual(p0, 1.0 * 5e-5 / 0.02, delta=1e-15)     # P = -S * Lambda / rho
        e.advance(5.0)
        self.assertLess(abs(e.y[IP] / p0 - 1.0), 1e-8)
        e.submit({"type": "rod.move", "rod": "control", "direction": "out"})
        e.advance(5.0)
        self.assertGreater(e.y[IP], 2 * p0)
        self.assertEqual(e.validity(), {"status": "unvalidated", "reasons": ["R_PARAMS_UNVALIDATED"]})
        with self.assertRaises(ValueError):
            e.shape()

    def test_hand_built_core_replays(self):
        e = Engine(tiny_core(), seed=7)
        e.submit({"type": "rod.move", "rod": "control", "direction": "out"})
        e.advance(1.0)
        r = Engine.replay(tiny_core(), json.loads(json.dumps(e.session())), e.step_index)
        self.assertEqual(r.checkpoint(), e.checkpoint() | {"eventCount": r.checkpoint()["eventCount"]})

    def test_engine_keeps_its_own_copy(self):
        p = tiny_core()
        e = Engine(p)
        digest = e.digest
        p["kinetics"]["genTime"] = 1.0
        e.advance(0.1)
        self.assertEqual(e.digest, digest)
        self.assertEqual(e.model.gen_time, 5e-5)


def run_shared_script():
    """The fixture's run: base core with sections, scripted for a fixed number of outer steps."""
    run = CHECKS["run"]
    e = Engine(tiny_core() | CHECKS["sections"], run["init"], run["seed"], run["config"])
    for k in range(run["steps"]):
        for item in run["script"]:
            if item["step"] == k:
                e.submit(item["cmd"])
        e.step()
    return e


class TestSharedRun(unittest.TestCase):
    def test_matches_the_pinned_values(self):
        """Regression check here; js/src/sim/params.test.ts checks the same values, so this is also a parity check."""
        e = run_shared_script()
        s = e.snapshot(include_shape=True)
        want = CHECKS["run"]["expect"]
        got = {"power": s["truth"]["power"], "fuelTemp": s["truth"]["fuelTemp"], "peakPower": e.peak_power,
               "indicated": s["indicated"]["nm"]}
        for key, value in got.items():
            self.assertLess(abs(value - want[key]), 1e-9 * abs(want[key]), key)
        for x, w in zip(s["truth"]["shape"], want["shape"], strict=True):
            self.assertLess(abs(x - w), 1e-9 * abs(w))
        self.assertEqual(s["validity"], want["validity"])
        self.assertEqual(s["trips"]["latched"], want["latched"])


class TestChecks(unittest.TestCase):
    def test_valid_cores_pass(self):
        check_params(tiny_core())
        check_params(tiny_core() | CHECKS["sections"])

    def test_shared_cases_report_the_expected_path(self):
        self.assertGreaterEqual(len(CHECKS["cases"]), 50)
        for case in CHECKS["cases"]:
            with self.subTest(case=case["name"]):
                p = tiny_core() | (copy.deepcopy(CHECKS["sections"]) if case["withSections"] else {})
                apply_edits(p, case["edits"])
                with self.assertRaises(ParamsError) as cm:
                    check_params(p)
                self.assertEqual(cm.exception.path, case["expect"], str(cm.exception))

    def test_engine_checks_before_running(self):
        p = tiny_core()
        p["kinetics"]["lambda"] = [1.0] * 5
        with self.assertRaises(ParamsError):
            Engine(p)


class TestDigest(unittest.TestCase):
    def test_canonical_text(self):
        out = []
        _canon({"b": [1, -0.0], "a": "é"}, out)
        self.assertEqual("".join(out), '{"a":"\\u00e9","b":[f3ff0000000000000,f8000000000000000]}')

    def test_shared_digests(self):
        d = CHECKS["digests"]
        self.assertEqual(params_digest(tiny_core()), d["base"])
        self.assertEqual(params_digest(tiny_core() | CHECKS["sections"]), d["baseWithSections"])
        self.assertEqual(params_digest(d["mixed"]["value"]), d["mixed"]["digest"])

    def test_follows_content_not_key_order(self):
        p = tiny_core()
        q = {k: p[k] for k in reversed(list(p))}
        self.assertEqual(params_digest(p), params_digest(q))
        r = copy.deepcopy(p)
        r["thermal"]["UA"] = 5000.000000001
        self.assertNotEqual(params_digest(p), params_digest(r))
        self.assertEqual(params_digest({"x": 1}), params_digest({"x": 1.0}))

    def test_restore_rejects_edited_params(self):
        e = Engine(tiny_core())
        e.advance(0.1)
        cp = json.loads(json.dumps(e.checkpoint()))
        Engine.restore(tiny_core(), cp)
        edited = tiny_core()
        edited["thermal"]["UA"] = 5001.0
        with self.assertRaises(CheckpointError):
            Engine.restore(edited, cp)
        with self.assertRaises(CheckpointError):
            Engine.replay(edited, e.session(), 1)


if __name__ == "__main__":
    unittest.main()
