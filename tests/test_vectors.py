"""Tests for reference engine golden vectors and generator.

Standard library only.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from kirk import ENGINE_VERSION, params_digest
from kirk.libformat import load_params
from kirk import vectors

REPO_ROOT = Path(__file__).resolve().parents[1]
VECTORS_DIR = REPO_ROOT / "schema" / "engine-vectors"
SYNTHETIC_CORE = REPO_ROOT / "schema" / "vectors" / "synthetic-core"


_CATEGORY = {"power": "power", "precursors": "power", "energy": "power", "peakPower": "power",
             "fuelTemp": "temperature", "coolantTemp": "temperature",
             "iodine": "poisons", "xenon": "poisons", "t": "eventTime", "peakTime": "eventTime"}
_DEFAULT_TOL = {"rel": 1e-9, "abs": 1e-12}


def _compare(a, b, tol, path, problems, key=None):
    """Recursively compare two vector documents; floats within tolerance, everything else exactly."""
    if isinstance(a, dict) and isinstance(b, dict):
        if sorted(a) != sorted(b):
            problems.append(f"{path}: keys differ")
            return
        for k in a:
            _compare(a[k], b[k], tol, f"{path}.{k}", problems, k)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            problems.append(f"{path}: length {len(a)} != {len(b)}")
            return
        for i, (x, y) in enumerate(zip(a, b)):
            _compare(x, y, tol, f"{path}[{i}]", problems, key)
    elif isinstance(a, float) or isinstance(b, float):
        if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
            problems.append(f"{path}: type differs")
            return
        t = tol.get(_CATEGORY.get(key, ""), _DEFAULT_TOL)
        limit = t.get("abs", 0.0) + t.get("rel", 0.0) * max(abs(a), abs(b))
        if abs(a - b) > limit:
            problems.append(f"{path}: {a!r} vs {b!r} (limit {limit:.3g})")
    elif a != b or type(a) is not type(b):
        problems.append(f"{path}: {a!r} != {b!r}")


class TestEngineVectors(unittest.TestCase):
    def test_committed_vectors_match_generator(self):
        """Committed vectors must match a fresh run within their declared tolerances.

        Not byte-for-byte: platform math libraries (exp, log, sin) differ in the last bit, and a pulse amplifies
        that to ~1e-12 relative between Linux and Windows. Strings, integers, booleans, event types, ids and
        reasons must still match exactly; floats must agree within the file's own tolerances."""
        with tempfile.TemporaryDirectory() as tmp:
            vectors.generate(Path(tmp))
            fresh = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in Path(tmp).glob("*.json")}
        committed = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in VECTORS_DIR.glob("*.json")}
        self.assertEqual(sorted(fresh), sorted(committed))
        for name in sorted(fresh):
            with self.subTest(file=name):
                problems = []
                _compare(committed[name], fresh[name], committed[name]["tolerances"], "$", problems)
                self.assertEqual(problems[:10], [], "regenerate with `python -m kirk.vectors` and review the diff")

    def test_comparison_catches_real_differences(self):
        """The tolerant comparison must still fail on a changed value, reason or event."""
        doc = json.loads((VECTORS_DIR / "scram.json").read_text(encoding="utf-8"))
        tol = doc["tolerances"]
        for mutate in (lambda d: d["samples"][3].__setitem__("power", d["samples"][3]["power"] * (1 + 1e-6)),
                       lambda d: d["samples"][3].__setitem__("fuelTemp", d["samples"][3]["fuelTemp"] + 1e-6),
                       lambda d: d["events"][-1].__setitem__("reason", "REJ_SOMETHING_ELSE"),
                       lambda d: d["events"].pop()):
            other = json.loads(json.dumps(doc))
            mutate(other)
            problems = []
            _compare(doc, other, tol, "$", problems)
            self.assertTrue(problems)

    def test_vectors_are_valid_json_without_nonfinite(self):
        def _forbid_constant(c):
            raise ValueError(f"non-finite constant in JSON: {c}")

        files = sorted(VECTORS_DIR.glob("*.json"))
        self.assertEqual(len(files), 6)
        for p in files:
            with self.subTest(file=p.name):
                content = p.read_text(encoding="utf-8")
                doc = json.loads(content, parse_constant=_forbid_constant)
                self.assertIsInstance(doc, dict)

    def test_expected_behaviour_is_present(self):
        def load(name: str) -> dict:
            return json.loads((VECTORS_DIR / f"{name}.json").read_text(encoding="utf-8"))

        # pulse: max sampled power > 1e7 W and the last sample < max/100
        pulse = load("pulse")
        powers = [s["power"] for s in pulse["samples"]]
        max_p = max(powers)
        self.assertGreater(max_p, 1e7)
        self.assertLess(pulse["samples"][-1]["power"], max_p / 100)

        # scram: the command at step 260 has reason REJ_TRIPPED and all rods are 0 in the last sample
        scram = load("scram")
        cmd260 = next(ev for ev in scram["events"] if ev.get("type") == "command" and abs(ev.get("t", 0.0) - 2.6) < 1e-9)
        self.assertEqual(cmd260["reason"], "REJ_TRIPPED")
        self.assertEqual(scram["samples"][-1]["rods"], {"safety": 0.0, "regulating": 0.0, "transient": 0.0})

        # rejections: four reasons are REJ_INTERLOCK:fire-needs-pulse-mode, REJ_NOT_PULSE_CAPABLE, REJ_UNKNOWN_ROD, REJ_UNKNOWN_COMMAND,
        # and indicated.linear is null in the last sample
        rejections = load("rejections")
        cmd_events = [ev for ev in rejections["events"] if ev.get("type") == "command"]
        self.assertEqual(
            [ev["reason"] for ev in cmd_events[:4]],
            [
                "REJ_INTERLOCK:fire-needs-pulse-mode",
                "REJ_NOT_PULSE_CAPABLE",
                "REJ_UNKNOWN_ROD",
                "REJ_UNKNOWN_COMMAND",
            ],
        )
        self.assertIsNone(rejections["samples"][-1]["indicated"]["linear"])

        # period-trip: a trip event with id period-short exists and its time is not a multiple of outerDt (|t/dt − round(t/dt)| > 1e-3)
        period_trip = load("period-trip")
        trip_ev = next(ev for ev in period_trip["events"] if ev.get("type") == "trip" and ev.get("id") == "period-short")
        dt = period_trip["config"]["outerDt"]
        steps = trip_ev["t"] / dt
        self.assertGreater(abs(steps - round(steps)), 1e-3)

        # source-level: first and last sampled power agree within 1e-8 relative
        source_level = load("source-level")
        p_first = source_level["samples"][0]["power"]
        p_last = source_level["samples"][-1]["power"]
        self.assertLess(abs(p_last / p_first - 1.0), 1e-8)

    def test_pins_match_current_engine(self):
        digest = params_digest(load_params(SYNTHETIC_CORE))
        files = sorted(VECTORS_DIR.glob("*.json"))
        self.assertEqual(len(files), 6)
        for p in files:
            with self.subTest(file=p.name):
                doc = json.loads(p.read_text(encoding="utf-8"))
                self.assertEqual(doc["pins"]["engineVersion"], ENGINE_VERSION)
                self.assertEqual(doc["pins"]["paramsDigest"], digest)


if __name__ == "__main__":
    unittest.main()
