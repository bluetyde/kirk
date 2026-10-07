"""Regression rows from a cross-check with two published constant sets (2026-10-07).

Two independent delayed-neutron sets, both with a 20 microsecond generation time:
  one group:  beta 0.0065, lambda 0.0767 per second (the one-group model of a teaching dashboard)
  six group:  the thermal U-235 set beta = 0.000215 ... 0.000273 (sum 0.006502), lambda = 0.0124 ... 3.01
              (used by two unrelated simulators)
The one-group set is run as six identical groups, which is the same equations. Core: the synthetic core with no source,
no feedback and a critical reference, as in test_engine. Each row compares the engine with the exact inhour root
(bisection on rho = w*Lambda + sum beta_i w / (w + lambda_i)), and the first two rows also pin the number.
"""
from __future__ import annotations

import math
import unittest

from kirk import Engine
from kirk.engine import IP

from tests.test_engine import kinetics_only_lib

ONE_GROUP = {"beta": [0.0065 / 6] * 6, "lambda": [0.0767] * 6, "genTime": 2e-5}
SIX_GROUP = {
    "beta": [0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273],
    "lambda": [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01],
    "genTime": 2e-5,
}


def core(constants):
    L = kinetics_only_lib()
    L["kinetics"].update({k: list(v) if isinstance(v, list) else v for k, v in constants.items()})
    return L


def inhour_residual(constants, w, rho):
    return w * constants["genTime"] + sum(b * w / (w + l) for b, l in zip(constants["beta"], constants["lambda"])) - rho


def positive_root(constants, rho):
    lo, hi = 1e-12, 1e3
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if inhour_residual(constants, mid, rho) < 0 else (lo, mid)
    return 0.5 * (lo + hi)


def slowest_decay_root(constants, rho):
    """Negative root closest to zero, in (-min lambda, 0), for rho < 0."""
    lo, hi = -min(constants["lambda"]) * (1 - 1e-12), -1e-15
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if inhour_residual(constants, mid, rho) < 0 else (lo, mid)
    return 0.5 * (lo + hi)


def measured_rate(e, start, window):
    """Run to `start`, then return the exponential rate of power over the next `window` seconds."""
    e.advance(start)
    p1 = e.y[IP]
    e.advance(window)
    return math.log(e.y[IP] / p1) / window


def step_engine(constants, rho, power, outer_dt):
    e = Engine(core(constants), {"power": {"mode": "critical-equilibrium", "value": power}}, config={"outerDt": outer_dt})
    e.submit({"type": "fault.reactivity", "deltaRho": rho})
    return e


class TestThirdPartyConstants(unittest.TestCase):
    def check_period(self, constants, expected_period_s):
        """+100 pcm step: the stable period equals the inhour root (other modes decayed by 280 s), and the pinned value."""
        rho = 100e-5
        omega = measured_rate(step_engine(constants, rho, 1e-3, 1.0), 280.0, 20.0)
        self.assertLess(abs(omega / positive_root(constants, rho) - 1.0), 5e-3)
        self.assertLess(abs(1.0 / omega / expected_period_s - 1.0), 1e-3)

    def test_one_group_constants_period_at_plus_100_pcm(self):
        """One-group model: +100 pcm gives a 71.73 s period (the one-group formula (beta - rho) / (lambda rho) gives 71.71 s)."""
        self.check_period(ONE_GROUP, 71.73)

    def test_six_group_constants_period_at_plus_100_pcm(self):
        """Six-group set: +100 pcm gives 54.92 s, about 30 % shorter than the one-group model with the same beta."""
        self.check_period(SIX_GROUP, 54.92)

    def test_negative_prompt_jump_at_minus_500_pcm(self):
        """P1/P0 = beta/(beta - rho) after the prompt transient, for a negative step. The prompt time constant is
        Lambda/(beta - rho), about 1.7 ms here, so the window is 20 ms (a multiple of outerDt = 10 ms; a shorter
        advance moves nothing). Delayed decay over 20 ms is about 0.3 %, hence the 1 % tolerance."""
        rho = -500e-5
        e = step_engine(SIX_GROUP, rho, 1.0, 0.01)
        e.advance(0.02)
        beta_total = sum(SIX_GROUP["beta"])
        expected = beta_total / (beta_total - rho)
        self.assertLess(abs(e.y[IP] / expected - 1.0), 1e-2)

    def test_negative_step_late_decay_matches_slowest_root(self):
        """Asymptotic decay rate after a -500 pcm step equals the negative inhour root closest to zero. The two slowest
        modes are close, so the window must start late: measured against the root, the rate is 9.6 % off in a window
        starting at 280 s, 0.24 % off at 600 s and within 1e-4 at 1200 s."""
        rho = -500e-5
        omega = measured_rate(step_engine(SIX_GROUP, rho, 1.0, 1.0), 1200.0, 20.0)
        root = slowest_decay_root(SIX_GROUP, rho)
        self.assertLess(root, 0.0)
        self.assertLess(abs(omega / root - 1.0), 1e-3)


if __name__ == "__main__":
    unittest.main()
