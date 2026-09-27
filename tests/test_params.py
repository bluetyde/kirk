"""Tests for the plain parameter API (kirk.params): running without a library, checks, digest.

Run from the repo root:  python -m unittest
"""
from __future__ import annotations

import copy
import json
import unittest

from kirk import CheckpointError, Engine, ParamsError, check_params, params_digest
from kirk.engine import IP
from kirk.params import _canon

# Digest of DIGEST_CASE; js/src/sim/params.test.ts pins the same value, so both languages hash alike.
DIGEST_CASE = {"b": [1, 2.5, -0.0, 1e-300, True, None], "a": "Å\n\"x\"", "c": {"z": [], "y": {}}, "é": 3}
DIGEST_CASE_HEX = "85b44f7a31d2c68c407623a33be213a7563db02e7b9f035646408b27422da14a"


def tiny_core():
    """A made-up one-rod core, written by hand: no library folder, no validity or shape sections."""
    return {
        "id": "tiny",
        "kinetics": {"beta": [0.0002, 0.0012, 0.0011, 0.0024, 0.0007, 0.0003],
                     "lambda": [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01], "genTime": 5e-5, "extSource": 1.0},
        "reference": {"rods": {"control": 0.0}, "Tfuel": 300.0, "Tcoolant": 300.0, "rho": -0.02},
        "rods": [{"id": "control", "speed": 0.1, "pulseCapable": False,
                  "worth": {"x": [0.0, 1.0], "y": [0.0, 0.03]},
                  "scram": {"t": [0.0, 0.5], "x": [1.0, 0.0]}}],
        "feedback": {"fuelTemp": {"x": [300.0, 1300.0], "y": [0.0, -0.01]},
                     "coolantTemp": {"x": [270.0, 370.0], "y": [0.0003, -0.0007]},
                     "xenon": {"x": [0.0, 1e21], "y": [0.0, -0.03]}},
        "thermal": {"fuelMass": 100.0, "fuelCp": {"x": [300.0, 1300.0], "y": [300.0, 400.0]},
                    "coolantMass": 2e4, "coolantCp": 4180.0, "hA": 3000.0, "UA": 5000.0, "sinkTemp": 300.0,
                    "hxPump": "main", "fuelFraction": 0.97},
        "poisons": {"fluxPerWatt": 1e10, "sigmaF": 0.1, "gammaI": 0.064, "gammaXe": 0.0025, "lambdaI": 2.87e-5,
                    "lambdaXe": 2.09e-5, "sigmaXe": 2.6e-18},
        "plant": {"modes": ["run"], "initialMode": "run", "pumps": ["main"],
                  "instruments": [{"id": "nm", "signal": "truth.power", "scale": "log", "range": [1e-3, 1e7],
                                   "lag": 0.0, "noise": 0.0}],
                  "trips": [{"id": "high", "input": "indicated.nm", "predicate": {"op": "gt", "value": 1e6},
                             "latching": True}],
                  "interlocks": []},
    }


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


class TestChecks(unittest.TestCase):
    def assert_error(self, change, path):
        p = tiny_core()
        change(p)
        with self.assertRaises(ParamsError) as cm:
            check_params(p)
        self.assertEqual(cm.exception.path, path, str(cm.exception))

    def test_tiny_core_passes(self):
        check_params(tiny_core())

    def test_errors_name_the_path(self):
        cases = [
            (lambda p: p["kinetics"]["beta"].pop(), "$.kinetics.beta"),
            (lambda p: p["kinetics"].update(genTime=0.0), "$.kinetics.genTime"),
            (lambda p: p["kinetics"].update(genTIme=1.0), "$.kinetics.genTIme"),
            (lambda p: p.pop("poisons"), "$.poisons"),
            (lambda p: p["feedback"]["fuelTemp"].update(x=[300.0, 300.0]), "$.feedback.fuelTemp.x"),
            (lambda p: p["feedback"]["xenon"].update(outOfRange="wrap"), "$.feedback.xenon.outOfRange"),
            (lambda p: p["rods"][0].update(pulseCapable=True), "$.rods[0].fireTime"),
            (lambda p: p["rods"][0]["scram"].update(x=[1.0, 0.5]), "$.rods[0].scram.x"),
            (lambda p: p["reference"]["rods"].update(ghost=0.0), "$.reference.rods.ghost"),
            (lambda p: p["thermal"].update(hxPump="spare"), "$.thermal.hxPump"),
            (lambda p: p["kinetics"].update(extSource=float("nan")), "$.kinetics.extSource"),
            (lambda p: p["plant"]["instruments"][0].update(signal="truth.mode"), "$.plant.instruments[0].signal"),
            (lambda p: p["plant"]["trips"][0].update(input="indicated.ghost"), "$.plant.trips[0].input"),
            (lambda p: p["plant"]["trips"][0]["predicate"].update(op="gt", value="high"),
             "$.plant.trips[0].predicate.value"),
            (lambda p: p["plant"]["interlocks"].append(
                {"id": "x", "when": {"op": "gt", "value": 1.0}, "blocks": ["rod.move"], "reason": "r"}),
             "$.plant.interlocks[0].when"),
        ]
        for change, path in cases:
            with self.subTest(path=path):
                self.assert_error(change, path)

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

    def test_cross_language_case(self):
        self.assertEqual(params_digest(DIGEST_CASE), DIGEST_CASE_HEX)

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
