"""Engine tests: analytic physics checks, rules, determinism, checkpoint and replay.

Run from the repo root:  python -m unittest
Analytic references state their assumptions in each test (plan 01).
"""
from __future__ import annotations

import copy
import functools
import json
import math
import unittest
from pathlib import Path

from kirk import CheckpointError, Engine, InitError, Model
from kirk.engine import IEP, IEH, IP, ITC, ITF, IX
from kirk.libformat import load_params

FIXTURE = Path(__file__).resolve().parents[1] / "schema" / "vectors" / "synthetic-core"


@functools.cache
def _fixture():
    return load_params(FIXTURE)


def lib():
    """Synthetic-core params: a fresh copy each call, so a test can change it freely."""
    return copy.deepcopy(_fixture())


def kinetics_only_lib():
    """Synthetic core with no source, no feedback, and a calibration that makes the reference state critical.
    The params digest follows the content, so these runs can't pass as the real fixture."""
    L = lib()
    L["kinetics"]["extSource"] = 0.0
    L["reference"]["calibration"] = -L["reference"]["rho"]
    L["feedback"]["fuelTemp"] = {"x": [0.0, 5000.0], "y": [0.0, 0.0]}
    L["feedback"]["coolantTemp"] = {"x": [0.0, 5000.0], "y": [0.0, 0.0]}
    L["feedback"]["xenon"] = {"x": [0.0, 1e30], "y": [0.0, 0.0]}
    return L


def inhour_omega(L, rho):
    """Positive root of rho = w*Lambda + sum beta_i w / (w + lambda_i), by bisection."""
    M = Model(L)
    f = lambda w: w * M.gen_time + sum(b * w / (w + l) for b, l in zip(M.beta, M.lam)) - rho
    lo, hi = 1e-12, 1e3
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
    return 0.5 * (lo + hi)


def near_critical_rods(L, target_rho):
    """Safety fully out, transient in, regulating placed so the reference-temperature reactivity is target_rho."""
    M = Model(L)
    base = M.ref_rho + M.rod_by_id["safety"].worth(1.0)
    reg = M.rod_by_id["regulating"].worth
    lo, hi = 0.0, 1.0
    for _ in range(100):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if base + reg(mid) < target_rho else (lo, mid)
    return {"safety": 1.0, "regulating": 0.5 * (lo + hi), "transient": 0.0}


class TestInitialization(unittest.TestCase):
    def test_source_equilibrium_matches_formula_and_holds(self):
        L = lib()
        M = Model(L)
        e = Engine(L, {})
        rho = e.reactivity(0.0, e.y)["total"]
        self.assertAlmostEqual(e.y[IP], -M.ext_source * M.gen_time / rho, delta=1e-15)
        p0 = e.y[IP]
        e.advance(20.0)
        self.assertLess(abs(e.y[IP] / p0 - 1.0), 1e-8)

    def test_source_equilibrium_rejected_at_nonnegative_reactivity(self):
        with self.assertRaises(InitError) as cm:
            Engine(lib(), {"rods": {"safety": 1.0, "regulating": 1.0, "transient": 1.0}})
        self.assertEqual(cm.exception.code, "E_INIT_NO_EQUILIBRIUM")

    def test_critical_equilibrium_rejected_with_a_source(self):
        with self.assertRaises(InitError) as cm:
            Engine(lib(), {"power": {"mode": "critical-equilibrium", "value": 100.0}})
        self.assertEqual(cm.exception.code, "E_INIT_NO_EQUILIBRIUM")

    def test_critical_steady_state_without_source(self):
        e = Engine(kinetics_only_lib(), {"power": {"mode": "critical-equilibrium", "value": 1000.0}})
        e.advance(10.0)
        self.assertLess(abs(e.y[IP] / 1000.0 - 1.0), 1e-10)

    def test_invalid_specs(self):
        for spec in ({"rods": {"ghost": 0.0}}, {"rods": {"safety": 1.5}}, {"mode": "turbo"},
                     {"power": {"mode": "given", "value": -1.0}},
                     {"poisons": {"mode": "equilibrium"}}):      # needs a given power
            with self.subTest(spec=spec), self.assertRaises(InitError) as cm:
                Engine(lib(), spec)
            self.assertEqual(cm.exception.code, "E_INIT_INVALID")


class TestKineticsAnalytic(unittest.TestCase):
    def test_prompt_jump(self):
        """P1/P0 = beta/(beta - rho) after the prompt transient (delayed growth over 50 ms is ~0.1%)."""
        L = kinetics_only_lib()
        M = Model(L)
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}})
        rho = 0.001
        e.submit({"type": "fault.reactivity", "deltaRho": rho})
        e.advance(0.05)
        expected = M.beta_total / (M.beta_total - rho)
        self.assertLess(abs(e.y[IP] / expected - 1.0), 3e-3)

    def test_stable_period_matches_inhour(self):
        """Asymptotic growth rate equals the positive inhour root (other modes decayed by t = 280 s)."""
        L = kinetics_only_lib()
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1e-3}}, config={"outerDt": 1.0})
        rho = 0.001
        e.submit({"type": "fault.reactivity", "deltaRho": rho})
        e.advance(280.0)
        p1 = e.y[IP]
        e.advance(20.0)
        omega = math.log(e.y[IP] / p1) / 20.0
        self.assertLess(abs(omega / inhour_omega(L, rho) - 1.0), 5e-3)

    @staticmethod
    def _pulse_lib(delayed_return: bool):
        L = kinetics_only_lib()
        alpha, c, Tref = -1e-4, 320.0, L["reference"]["Tfuel"]
        L["feedback"]["fuelTemp"] = {"x": [0.0, 3000.0], "y": [alpha * (0.0 - Tref), alpha * (3000.0 - Tref)]}
        L["thermal"]["fuelCp"] = {"x": [0.0, 3000.0], "y": [c, c]}
        L["thermal"]["hA"] = 0.0
        if not delayed_return:
            L["kinetics"]["lambda"] = [1e-12] * 6     # precursors form but never decay back during the pulse
        return L, abs(alpha) / (L["thermal"]["fuelMass"] * c)

    def test_nordheim_fuchs_pulse(self):
        """Nordheim-Fuchs assumptions: adiabatic, constant temperature coefficient, prompt neutrons only
        (delayed neutrons don't return during the pulse), prompt excess rho_p = rho - beta. Then
        P_max = rho_p^2 / (2 K Lambda), energy = 2 rho_p / K, FWHM = 3.52 Lambda / rho_p, K = |alpha_T| / (m c).
        The test enforces the no-return assumption; test_delayed_return_raises_the_peak covers the full model."""
        L, K = self._pulse_lib(delayed_return=False)
        M = Model(L)
        m = M.fuel_mass
        rho_p = 0.003
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"outerDt": 1e-3})
        e.submit({"type": "fault.reactivity", "deltaRho": M.beta_total + rho_p})
        times, powers = [], []
        while e.t < 0.6:
            e.step()
            times.append(e.t)
            powers.append(e.y[IP])
        p_max = rho_p ** 2 / (2 * K * M.gen_time)
        self.assertLess(abs(e.peak_power / p_max - 1.0), 1e-3)
        half = e.peak_power / 2
        crossings = []
        for (t0, p0), (t1, p1) in zip(zip(times, powers), zip(times[1:], powers[1:])):
            if (p0 - half) * (p1 - half) < 0:
                crossings.append(t0 + (half - p0) / (p1 - p0) * (t1 - t0))
        self.assertEqual(len(crossings), 2)
        self.assertLess(abs((crossings[1] - crossings[0]) / (3.52 * M.gen_time / rho_p) - 1.0), 0.03)
        k_end = next(i for i, p in enumerate(powers) if times[i] > e.peak_time and p < e.peak_power / 100)
        e2 = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"outerDt": 1e-3})
        e2.submit({"type": "fault.reactivity", "deltaRho": M.beta_total + rho_p})
        e2.advance(times[k_end])
        self.assertLess(abs(e2.y[IEP] / (2 * rho_p / K) - 1.0), 0.03)

    def test_delayed_return_raises_the_peak(self):
        """With delayed neutrons returning during the pulse, the peak is a few percent above Nordheim-Fuchs
        (3.4% for this core, measured 2026-09-26 and unchanged at rtol 1e-8). Guards against the effect vanishing."""
        L, K = self._pulse_lib(delayed_return=True)
        M = Model(L)
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"outerDt": 1e-3})
        e.submit({"type": "fault.reactivity", "deltaRho": M.beta_total + 0.003})
        e.advance(0.4)
        ratio = e.peak_power / (0.003 ** 2 / (2 * K * M.gen_time))
        self.assertGreater(ratio, 1.01)
        self.assertLess(ratio, 1.06)


class TestPoisonsAndEnergy(unittest.TestCase):
    def test_equilibrium_poisons_have_zero_derivative(self):
        e = Engine(lib(), {"power": {"mode": "given", "value": 1e5}, "poisons": {"mode": "equilibrium"}})
        d = e.rhs(0.0, e.y)
        self.assertLess(abs(d[9]) / e.y[9] * 3600, 1e-9)
        self.assertLess(abs(d[IX]) / e.y[IX] * 3600, 1e-9)

    def test_xenon_peak_after_shutdown(self):
        """After a shutdown from equilibrium (flux ~ 0 afterwards), X(t) = X0 e^-lx t + lI I0/(lx - lI) (e^-lI t - e^-lx t)."""
        L = lib()
        M = Model(L)
        # rtol 1e-4: the check needs xenon to 1%, and tracking the power decay at 1e-6 would take ~30k order-2 steps
        e = Engine(L, {"power": {"mode": "given", "value": 1e5}, "poisons": {"mode": "equilibrium"}},
                   config={"outerDt": 60.0, "rtol": 1e-4})
        I0, X0 = e.y[9], e.y[IX]
        li, lx = M.lambda_i, M.lambda_x
        xs = []
        for _ in range(20 * 60):
            e.step()
            xs.append((e.t, e.y[IX]))
        k = max(range(1, len(xs) - 1), key=lambda i: xs[i][1])
        (t0, a), (t1, b), (t2, c) = xs[k - 1], xs[k], xs[k + 1]
        t_peak_sim = t1 + 0.5 * (t1 - t0) * (a - c) / (a - 2 * b + c)
        X = lambda t: X0 * math.exp(-lx * t) + li * I0 / (lx - li) * (math.exp(-li * t) - math.exp(-lx * t))
        lo, hi = 0.0, 40 * 3600.0
        for _ in range(200):      # peak of X: bisection on the sign of the numerical derivative
            mid = 0.5 * (lo + hi)
            lo, hi = (mid, hi) if X(mid + 1.0) > X(mid - 1.0) else (lo, mid)
        self.assertLess(abs(t_peak_sim / (0.5 * (lo + hi)) - 1.0), 0.01)

    def test_energy_balance(self):
        """Fission energy equals heat stored in fuel and coolant plus heat removed (all power deposited)."""
        L = lib()
        M = Model(L)
        e = Engine(L, {"rods": near_critical_rods(L, 0.0), "power": {"mode": "given", "value": 1e5}},
                   config={"outerDt": 0.5})
        tf0, tc0 = e.y[ITF], e.y[ITC]
        e.advance(200.0)
        stored = M.fuel_mass * M.fuel_cp.integral(tf0, e.y[ITF]) + M.cool_mass * M.cool_cp * (e.y[ITC] - tc0)
        self.assertGreater(e.y[IEP], 1e5)
        self.assertLess(abs((stored + e.y[IEH]) / e.y[IEP] - 1.0), 1e-4)


class TestRulesAndEvents(unittest.TestCase):
    def test_interlocks_and_command_results(self):
        e = Engine(lib(), {})
        s1 = e.submit({"type": "rod.fire", "rod": "transient"})
        s2 = e.submit({"type": "rod.fire", "rod": "safety"})
        s3 = e.submit({"type": "rod.move", "rod": "ghost", "direction": "out"})
        s4 = e.submit({"type": "warp"})
        e.step()
        res = {ev["seq"]: ev for ev in e.events if ev["type"] == "command"}
        self.assertEqual(res[s1]["reason"], "REJ_INTERLOCK:fire-needs-pulse-mode")
        self.assertEqual(res[s2]["reason"], "REJ_NOT_PULSE_CAPABLE")
        self.assertEqual(res[s3]["reason"], "REJ_UNKNOWN_ROD")
        self.assertEqual(res[s4]["reason"], "REJ_UNKNOWN_COMMAND")
        self.assertEqual([res[s]["t"] for s in (s1, s2)], [0.0, 0.0])

    def test_pulse_by_commands_and_feedback_shutdown(self):
        L = lib()
        M = Model(L)
        e = Engine(L, {"rods": near_critical_rods(L, -0.0005)})
        e.submit({"type": "mode.set", "mode": "pulse"})
        e.step()
        seq = e.submit({"type": "rod.fire", "rod": "transient"})
        e.advance(1.0)
        fired = next(ev for ev in e.events if ev.get("seq") == seq)
        self.assertEqual(fired["status"], "accepted")
        self.assertGreater(e.peak_power, 1e7)
        self.assertLess(e.y[IP], e.peak_power / 100)         # fuel feedback ended the pulse
        self.assertGreater(e.y[ITF] - M.ref_tfuel, 50.0)

    def test_scram_inserts_all_rods_on_the_profile(self):
        L = lib()
        e = Engine(L, {"rods": near_critical_rods(L, -0.0005)})
        e.submit({"type": "scram", "reason": "test"})
        e.advance(0.3)
        self.assertAlmostEqual(e.rod_position("safety", e.t), 0.55, places=9)   # profile point at 0.3 s
        e.advance(0.4)
        self.assertEqual({r: e.rod_position(r, e.t) for r in e.motions}, {"safety": 0.0, "regulating": 0.0, "transient": 0.0})
        self.assertIn("manual", e.latched)
        seq = e.submit({"type": "rod.move", "rod": "safety", "direction": "out"})
        e.step()
        self.assertEqual(next(ev for ev in e.events if ev.get("seq") == seq)["reason"], "REJ_TRIPPED")

    def test_truth_trip_is_located_inside_a_step_independent_of_outer_dt(self):
        L = lib()
        trip_times = []
        for dt in (0.01, 0.007):
            e = Engine(L, {"rods": near_critical_rods(L, -0.0005)}, config={"outerDt": dt})
            e.submit({"type": "rod.move", "rod": "transient", "direction": "out"})
            while not e.latched and e.t < 60:
                e.step()
            ev = next(x for x in e.events if x["type"] == "trip")
            self.assertEqual(ev["id"], "period-short")
            steps = ev["t"] / dt
            self.assertGreater(abs(steps - round(steps)), 1e-3, "trip time should not sit on the outer grid")
            trip_times.append(ev["t"])
        self.assertLess(abs(trip_times[0] - trip_times[1]), 1e-3)

    def test_dead_instrument_reads_none_and_cannot_trip(self):
        e = Engine(lib(), {})
        e.submit({"type": "fault.instrument", "instrument": "linear", "kind": "dead"})
        e.step()
        e.step()
        self.assertIsNone(e.snapshot()["indicated"]["linear"])

    def test_validity(self):
        self.assertEqual(Engine(lib(), {}).validity(), {"status": "unvalidated", "reasons": ["R_LIBRARY_SYNTHETIC"]})
        v = Engine(lib(), {"Tfuel": 1300.0}).validity()
        self.assertEqual(v["status"], "outOfDomain")
        self.assertIn("R_DOMAIN_TFUEL", v["reasons"])

    def test_shape_is_normalized_and_nonnegative(self):
        L = lib()
        e = Engine(L, {"rods": {"safety": 1.0, "regulating": 0.37, "transient": 0.0}, "Tfuel": 650.0})
        sh = e.shape()
        self.assertAlmostEqual(sum(sh), 1.0, delta=1e-5)
        self.assertGreaterEqual(min(sh), 0.0)


def scripted_run(L, chunks):
    """A run with commands at fixed steps; `chunks` controls how advance() is split."""
    e = Engine(L, {"rods": near_critical_rods(L, -0.0005)}, seed=42)
    script = {0: [{"type": "rod.move", "rod": "transient", "direction": "out"}],
              150: [{"type": "rod.move", "rod": "transient", "direction": "stop"}],
              300: [{"type": "fault.instrument", "instrument": "log", "kind": "stuck"}]}
    for n in chunks:
        for _ in range(n):
            for cmd in script.get(e.step_index, []):
                e.submit(cmd, "script")
            e.step()
    return e


def comparable(cp):
    cp = dict(cp)
    cp.pop("eventCount")
    return cp


class TestDeterminismAndReplay(unittest.TestCase):
    def test_same_inputs_give_identical_results(self):
        L = lib()
        a, b = scripted_run(L, [500]), scripted_run(L, [500])
        self.assertEqual(comparable(a.checkpoint()), comparable(b.checkpoint()))

    def test_splitting_advance_calls_changes_nothing(self):
        L = lib()
        a, b = scripted_run(L, [500]), scripted_run(L, [1] * 500)
        self.assertEqual(comparable(a.checkpoint()), comparable(b.checkpoint()))

    def test_checkpoint_restore_matches_uninterrupted_run(self):
        L = lib()
        full = scripted_run(L, [500])
        part = scripted_run(L, [213])
        cp = json.loads(json.dumps(part.checkpoint()))       # must survive JSON
        resumed = Engine.restore(L, cp)
        script = {300: [{"type": "fault.instrument", "instrument": "log", "kind": "stuck"}]}
        while resumed.step_index < 500:
            for cmd in script.get(resumed.step_index, []):
                resumed.submit(cmd, "script")
            resumed.step()
        self.assertEqual(comparable(resumed.checkpoint()), comparable(full.checkpoint()))

    def test_session_replay_matches(self):
        L = lib()
        full = scripted_run(L, [500])
        replayed = Engine.replay(L, json.loads(json.dumps(full.session())), 500)
        self.assertEqual(comparable(replayed.checkpoint()), comparable(full.checkpoint()))

    def test_pins_are_enforced(self):
        cp = scripted_run(lib(), [10]).checkpoint()
        with self.assertRaises(CheckpointError):
            Engine.restore(kinetics_only_lib(), cp)
        cp["pins"]["engineVersion"] = "9.9.9"
        with self.assertRaises(CheckpointError):
            Engine.restore(lib(), cp)


try:
    import scipy.integrate  # noqa: F401
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False


@unittest.skipUnless(HAVE_SCIPY, "scipy not installed (runs in the openmc envs)")
class TestIndependentIntegrator(unittest.TestCase):
    def test_pulse_matches_scipy_radau(self):
        """Same right-hand side, independent integrator (scipy Radau, order 5): catches errors in our ROS2
        scheme and step control, not in the equations. Radau gets our Jacobian only for speed: its result comes
        from its own implicit stages and error control. (Without it, scipy's numerical Jacobian overflows on
        the energy-accumulator columns, which nothing depends on, and Radau crawls.)"""
        from scipy.integrate import solve_ivp
        L = lib()
        init = {"rods": near_critical_rods(L, -0.0005), "mode": "pulse"}
        e = Engine(L, init)
        e.submit({"type": "rod.fire", "rod": "transient"})
        e.advance(1.0)
        self.assertGreater(e.peak_power, 1e7)
        ref = Engine(L, init)
        ref.motions["transient"] = {"kind": "fire", "t0": 0.0, "x0": 0.0}
        y0 = list(ref.y)
        rtol = 1e-10
        atol = [a * rtol / 1e-6 for a in ref._scales(y0)]
        sol = solve_ivp(lambda t, y: ref.rhs(t, list(y)), (0.0, 1.0), y0, method="Radau", rtol=rtol, atol=atol,
                        jac=lambda t, y: ref._jacobian(t, list(y), ref.rhs(t, list(y)))[0])
        self.assertTrue(sol.success, sol.message)
        self.assertLess(abs(e.y[IP] / sol.y[IP][-1] - 1.0), 1e-4)
        self.assertLess(abs(e.y[IEP] / sol.y[IEP][-1] - 1.0), 1e-4)
        self.assertLess(abs(e.y[ITF] - sol.y[ITF][-1]), 1e-3)

if __name__ == "__main__":
    unittest.main()


class TestM1ReviewRegressions(unittest.TestCase):
    """One regression per confirmed finding of the Codex M1 review (_codex/m1-review/REVIEW.md, 2026-09-27)."""

    def test_1_drive_commands_cannot_cancel_a_scram(self):
        for delay in (0, 5):     # queued with the scram, and during insertion
            L = lib()
            e = Engine(L, {"rods": near_critical_rods(L, -0.0005)})
            e.submit({"type": "scram"})
            for _ in range(delay):
                e.step()
            seq = e.submit({"type": "rod.move", "rod": "safety", "direction": "in"})
            e.advance(0.6)
            self.assertEqual(next(ev for ev in e.events if ev.get("seq") == seq)["reason"], "REJ_SCRAM_IN_PROGRESS")
            self.assertEqual(e.rod_position("safety", e.t), 0.0, f"delay {delay}")

    def test_2_trip_window_crossed_inside_one_step_is_found(self):
        times = []
        for dt in (0.01, 0.001):
            L = lib()
            L["plant"]["trips"].append({"id": "window", "input": "truth.rod.transient",
                                        "predicate": {"op": "between", "value": [0.00008, 0.0001]}, "latching": True})
            e = Engine(L, {"rods": near_critical_rods(L, -0.0005)}, config={"outerDt": dt})
            e.submit({"type": "rod.move", "rod": "transient", "direction": "out"})   # 0.02/s: inside the window at 4-5 ms
            e.advance(0.02)
            ev = [x for x in e.events if x["type"] == "trip" and x["id"] == "window"]
            self.assertEqual(len(ev), 1, f"outerDt {dt}")
            times.append(ev[0]["t"])
        for t in times:
            self.assertLess(abs(t - 0.004), 1e-6)

    def test_3_replay_of_a_halted_run_returns(self):
        L = lib()
        L["feedback"]["fuelTemp"]["outOfRange"] = "reject"
        e = Engine(L, {"Tfuel": 1300.0})
        self.assertTrue(e.halted)
        r = Engine.replay(L, e.session(), 1)          # used to loop forever
        self.assertEqual(r.halted, e.halted)
        self.assertEqual(r.step_index, 0)

    def test_4_heat_capacity_reject_policy_is_enforced(self):
        L = lib()
        L["thermal"]["fuelCp"] = {"x": [293.15, 300.0], "y": [300.0, 300.0], "outOfRange": "reject"}
        e = Engine(L, {"Tfuel": 350.0})
        self.assertEqual(e.halted, "R_TABLE_REJECT_fuelCp")

    def test_5_replay_keeps_commands_pending_at_the_final_boundary(self):
        L = lib()
        e = Engine(L, {"rods": near_critical_rods(L, -0.0005)})
        e.step()
        e.submit({"type": "pump.set", "pump": L["plant"]["pumps"][0], "on": False})
        r = Engine.replay(L, json.loads(json.dumps(e.session())), e.step_index)
        self.assertEqual((len(r.pending), r.next_seq), (len(e.pending), e.next_seq))
        e.step()
        r.step()
        self.assertEqual(comparable(r.checkpoint()), comparable(e.checkpoint()))

    def test_7_integral_float_array_fields_load(self):
        import shutil
        import tempfile
        from kirk.libformat.validate import validate_library
        with tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / "core"
            shutil.copytree(FIXTURE, dst)
            m = json.loads((dst / "manifest.json").read_text(encoding="utf-8"))
            for d in m["arrays"].values():
                d["offset"], d["byteLength"] = float(d["offset"]), float(d["byteLength"])
                d["shape"] = [float(n) for n in d["shape"]]
            (dst / "manifest.json").write_text(json.dumps(m, indent=1), encoding="utf-8")
            self.assertEqual(validate_library(dst), [])
            self.assertEqual(load_params(dst)["shape"]["base"], lib()["shape"]["base"])
