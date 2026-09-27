"""Tests for the third-order Rosenbrock solver ROS3P."""
from __future__ import annotations

import json
import math
import unittest
from unittest.mock import patch

from kirk import Engine, InitError, Model
import kirk.engine as engine
from kirk.engine import IP, IX
from tests import test_engine
from tests.test_engine import (
    comparable,
    inhour_omega,
    kinetics_only_lib,
    lib,
    near_critical_rods,
    scripted_run,
)


def _fixed_step_integration(method_name: str, h: float) -> float:
    L = kinetics_only_lib()
    e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"method": method_name})
    e.extra_rho = 0.002
    y = list(e.y)
    t = 0.0
    n_steps = round(0.2 / h)
    stepper = getattr(e, f"_{method_name}")
    for _ in range(n_steps):
        f0 = e.rhs(t, y)
        J, ft = e._jacobian(t, y, f0)
        y, _ = stepper(t, y, h, J, f0, ft)
        t += h
    return y[IP]


def scripted_run_ros3p(L, chunks):
    """Variant of scripted_run using ROS3P."""
    e = Engine(L, {"rods": near_critical_rods(L, -0.0005)}, seed=42, config={"method": "ros3p"})
    script = {0: [{"type": "rod.move", "rod": "transient", "direction": "out"}],
              150: [{"type": "rod.move", "rod": "transient", "direction": "stop"}],
              300: [{"type": "fault.instrument", "instrument": "log", "kind": "stuck"}]}
    for n in chunks:
        for _ in range(n):
            for cmd in script.get(e.step_index, []):
                e.submit(cmd, "script")
            e.step()
    return e


class TestROS3P(unittest.TestCase):
    def test_unknown_method_rejected(self):
        with self.assertRaises(InitError) as cm:
            Engine(lib(), config={"method": "rk4"})
        self.assertEqual(cm.exception.code, "E_INIT_INVALID")

    def test_observed_order(self):
        # Study order for ROS3P
        p_02 = _fixed_step_integration("ros3p", 0.02)
        p_01 = _fixed_step_integration("ros3p", 0.01)
        p_005 = _fixed_step_integration("ros3p", 0.005)
        p_0025 = _fixed_step_integration("ros3p", 0.0025)

        p1_ros3p = math.log2(abs(p_02 - p_01) / abs(p_01 - p_005))
        p2_ros3p = math.log2(abs(p_01 - p_005) / abs(p_005 - p_0025))

        self.assertGreaterEqual(p1_ros3p, 2.7)
        self.assertLessEqual(p1_ros3p, 3.3)
        self.assertGreaterEqual(p2_ros3p, 2.7)
        self.assertLessEqual(p2_ros3p, 3.3)

        # Study order for ROS2
        p_02 = _fixed_step_integration("ros2", 0.02)
        p_01 = _fixed_step_integration("ros2", 0.01)
        p_005 = _fixed_step_integration("ros2", 0.005)
        p_0025 = _fixed_step_integration("ros2", 0.0025)

        p1_ros2 = math.log2(abs(p_02 - p_01) / abs(p_01 - p_005))
        p2_ros2 = math.log2(abs(p_01 - p_005) / abs(p_005 - p_0025))

        self.assertGreaterEqual(p1_ros2, 1.7)
        self.assertLessEqual(p1_ros2, 2.3)
        self.assertGreaterEqual(p2_ros2, 1.7)
        self.assertLessEqual(p2_ros2, 2.3)

    def test_wrong_coefficient_breaks_order(self):
        with patch.object(engine, "c32", engine.c32 * 1.01):
            p_01 = _fixed_step_integration("ros3p", 0.01)
            p_005 = _fixed_step_integration("ros3p", 0.005)
            p_0025 = _fixed_step_integration("ros3p", 0.0025)
            p = math.log2(abs(p_01 - p_005) / abs(p_005 - p_0025))
            self.assertLess(p, 2.0)

    def test_analytic_checks_with_ros3p(self):
        # 1. source equilibrium matches formula and holds
        L = lib()
        M = Model(L)
        e = Engine(L, {}, config={"method": "ros3p"})
        rho = e.reactivity(0.0, e.y)["total"]
        self.assertAlmostEqual(e.y[IP], -M.ext_source * M.gen_time / rho, delta=1e-15)
        p0 = e.y[IP]
        e.advance(20.0)
        self.assertLess(abs(e.y[IP] / p0 - 1.0), 1e-8)

        # 2. prompt jump
        L = kinetics_only_lib()
        M = Model(L)
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"method": "ros3p"})
        rho = 0.001
        e.submit({"type": "fault.reactivity", "deltaRho": rho})
        e.advance(0.05)
        expected = M.beta_total / (M.beta_total - rho)
        self.assertLess(abs(e.y[IP] / expected - 1.0), 3e-3)

        # 3. stable period matches inhour
        L = kinetics_only_lib()
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1e-3}},
                   config={"method": "ros3p", "outerDt": 1.0})
        rho = 0.001
        e.submit({"type": "fault.reactivity", "deltaRho": rho})
        e.advance(280.0)
        p1 = e.y[IP]
        e.advance(20.0)
        omega = math.log(e.y[IP] / p1) / 20.0
        self.assertLess(abs(omega / inhour_omega(L, rho) - 1.0), 5e-3)

        # 4. Nordheim-Fuchs peak check
        L, K = test_engine.TestKineticsAnalytic._pulse_lib(delayed_return=False)
        M = Model(L)
        rho_p = 0.003
        e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}},
                   config={"method": "ros3p", "outerDt": 1e-3})
        e.submit({"type": "fault.reactivity", "deltaRho": M.beta_total + rho_p})
        while e.t < 0.6:
            e.step()
        p_max = rho_p ** 2 / (2 * K * M.gen_time)
        self.assertLess(abs(e.peak_power / p_max - 1.0), 1e-3)

    def test_ros3p_takes_fewer_steps(self):
        L = lib()
        init = {"power": {"mode": "given", "value": 1e5}, "poisons": {"mode": "equilibrium"}}
        e_ros2 = Engine(L, init, config={"outerDt": 60.0})
        e_ros3p = Engine(L, init, config={"method": "ros3p", "outerDt": 60.0})
        e_ros2.advance(3600.0)
        e_ros3p.advance(3600.0)

        self.assertLess(e_ros3p.diag["steps"], 0.5 * e_ros2.diag["steps"])
        rel_diff = abs(e_ros3p.y[IX] - e_ros2.y[IX]) / e_ros2.y[IX]
        self.assertLess(rel_diff, 1e-6)

    def test_determinism_and_checkpoint_with_ros3p(self):
        L = lib()
        a = scripted_run_ros3p(L, [500])
        b = scripted_run_ros3p(L, [500])
        self.assertEqual(comparable(a.checkpoint()), comparable(b.checkpoint()))

        part = scripted_run_ros3p(L, [213])
        cp = json.loads(json.dumps(part.checkpoint()))
        resumed = Engine.restore(L, cp)
        script = {300: [{"type": "fault.instrument", "instrument": "log", "kind": "stuck"}]}
        while resumed.step_index < 500:
            for cmd in script.get(resumed.step_index, []):
                resumed.submit(cmd, "script")
            resumed.step()
        self.assertEqual(comparable(resumed.checkpoint()), comparable(a.checkpoint()))

    def test_pins_always_name_the_method(self):
        # C5: the solver is part of what a replay must reproduce, so pins carry it for ROS2 too.
        L = lib()
        self.assertEqual(scripted_run(L, [3]).pins()["config"]["method"], "ros2")
        self.assertEqual(scripted_run_ros3p(L, [3]).pins()["config"]["method"], "ros3p")
        # A checkpoint written before C5 (no "method" in its pins) restores as ROS2.
        cp = json.loads(json.dumps(scripted_run(L, [3]).checkpoint()))
        del cp["pins"]["config"]["method"]
        self.assertEqual(Engine.restore(L, cp).config["method"], "ros2")

    def test_time_dependent_accuracy(self):
        """Added by the dispatcher (Claude Code), not agy: the order study above is autonomous (constant
        reactivity, no rod motion), so dF/dt = 0 there and the gamma_i coefficients never enter; a wrong gamma_i
        passes it. Here the regulating rod moves 0.4 -> 0.5 in 0.2 s (one worth-table segment, so reactivity rises
        linearly by ~$0.39) and fixed-step ROS3P at h = 0.0025 must match an independent reference.
        Reference P(0.2 s) = 1.61402354941325 W: scipy Radau with our Jacobian, rtol 1e-12 (rtol 1e-10 agrees to
        9e-13), openmc-vr env, 2026-09-26. Measured errors at h = 0.0025: correct coefficients 2.6e-7; gamma1 = 0.5
        1.4e-3; gamma2 = 0 1.2e-4; gamma3 = 0 2.7e-3; c32 x 1.01 5.3e-5; c21 x 1.01 2.5e-5; m2 = 0.583 5.8e-5.
        The 2e-6 threshold sits 8x above the correct error and 12x below the smallest wrong-coefficient error."""
        L = kinetics_only_lib()
        M = Model(L)
        L["reference"]["calibration"] = -(M.ref_rho + M.rod_by_id["regulating"].worth(0.4))
        e = Engine(L, {"rods": {"safety": 0.0, "regulating": 0.4, "transient": 0.0},
                       "power": {"mode": "critical-equilibrium", "value": 1.0}}, config={"method": "ros3p"})
        e.motions["regulating"] = {"kind": "move", "t0": 0.0, "x0": 0.4, "v": 0.5}
        t, y, h = 0.0, list(e.y), 0.0025
        for _ in range(round(0.2 / h)):
            f0 = e.rhs(t, y)
            J, ft = e._jacobian(t, y, f0)
            y, _ = e._ros3p(t, y, h, J, f0, ft)
            t += h
        self.assertLess(abs(y[IP] / 1.61402354941325 - 1.0), 2e-6)

    def test_time_dependent_accuracy_catches_wrong_gamma(self):
        """Added by the dispatcher: the check above fails when a gamma_i (dF/dt coefficient) is wrong."""
        for name, value in (("gamma2", 0.0), ("gamma3", 0.0)):
            with self.subTest(coefficient=name), patch.object(engine, name, value):
                with self.assertRaises(AssertionError):
                    self.test_time_dependent_accuracy()

    def test_ros2_unchanged(self):
        e = scripted_run(lib(), [500])
        self.assertEqual(repr(e.y[0]), "0.040326259713735685")
        self.assertEqual(repr(e.y[7]), "293.15001301044094")


if __name__ == "__main__":
    unittest.main()
