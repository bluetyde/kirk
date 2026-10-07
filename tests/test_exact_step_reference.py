"""The engine's response to a step in reactivity against the exact solution of the point-kinetics equations.

For a constant reactivity the six-group equations are linear with constant coefficients,
    dn/dt   = ((rho - beta) / Lambda) n + sum_i lambda_i c_i
    dc_i/dt = (beta_i / Lambda) n - lambda_i c_i
so y(t) = expm(A t) y(0) exactly. The reference below builds A, takes its matrix exponential by scaling and squaring
(pure Python, no dependencies, like the rest of this package) and starts from the critical equilibrium
n = 1, c_i = beta_i / (Lambda lambda_i). It does not use a root finder, so it covers the early transient as well as the
asymptotic period, which test_third_party_constants checks through the inhour roots.

The reference is checked first against cases with known answers (a rotation, a diagonal matrix, and the equilibrium
that must not move at rho = 0), so a mistake in the reference cannot pass as agreement.
"""
from __future__ import annotations

import math
import unittest

from kirk import Engine
from kirk.engine import IP

from tests.test_engine import kinetics_only_lib

SIX_GROUP = {
    "beta": [0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273],
    "lambda": [0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01],
    "genTime": 2e-5,
}


def mat_mul(a, b):
    n, m, p = len(a), len(b), len(b[0])
    return [[math.fsum(a[i][k] * b[k][j] for k in range(m)) for j in range(p)] for i in range(n)]


def mat_exp(a, t):
    """expm(a * t) by scaling and squaring with a Taylor series (30 terms) on the scaled matrix."""
    n = len(a)
    norm = max(math.fsum(abs(x) for x in row) for row in a) * abs(t)
    squarings = max(0, int(math.ceil(math.log2(norm / 0.25))) if norm > 0.25 else 0)
    scale = t / (2 ** squarings)
    b = [[x * scale for x in row] for row in a]
    result = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]
    term = [row[:] for row in result]
    for k in range(1, 31):
        term = mat_mul(term, b)
        term = [[x / k for x in row] for row in term]
        result = [[result[i][j] + term[i][j] for j in range(n)] for i in range(n)]
    for _ in range(squarings):
        result = mat_mul(result, result)
    return result


def kinetics_matrix(beta, lam, gen_time, rho):
    g = len(beta)
    beta_total = math.fsum(beta)
    a = [[0.0] * (g + 1) for _ in range(g + 1)]
    a[0][0] = (rho - beta_total) / gen_time
    for i in range(g):
        a[0][i + 1] = lam[i]
        a[i + 1][0] = beta[i] / gen_time
        a[i + 1][i + 1] = -lam[i]
    return a


def exact_power(constants, rho, t):
    """n(t) / n(0) for a step rho at t = 0 from critical equilibrium."""
    beta, lam, gen = constants["beta"], constants["lambda"], constants["genTime"]
    y0 = [1.0] + [beta[i] / (gen * lam[i]) for i in range(len(beta))]
    e = mat_exp(kinetics_matrix(beta, lam, gen, rho), t)
    return math.fsum(e[0][j] * y0[j] for j in range(len(y0)))


def engine_power(constants, rho, t):
    L = kinetics_only_lib()
    L["kinetics"].update({"beta": list(constants["beta"]), "lambda": list(constants["lambda"]), "genTime": constants["genTime"]})
    e = Engine(L, {"power": {"mode": "critical-equilibrium", "value": 1.0}})
    e.submit({"type": "fault.reactivity", "deltaRho": rho})
    e.advance(t)
    return e.y[IP]


class TestReferenceItself(unittest.TestCase):
    def test_rotation(self):
        """expm of [[0, 1], [-1, 0]] t is a rotation by t."""
        for t in (0.3, 2.0, 25.0):
            e = mat_exp([[0.0, 1.0], [-1.0, 0.0]], t)
            self.assertAlmostEqual(e[0][0], math.cos(t), places=9)
            self.assertAlmostEqual(e[0][1], math.sin(t), places=9)
            self.assertAlmostEqual(e[1][0], -math.sin(t), places=9)
            self.assertAlmostEqual(e[1][1], math.cos(t), places=9)

    def test_diagonal(self):
        e = mat_exp([[-2.0, 0.0], [0.0, 0.5]], 3.0)
        self.assertAlmostEqual(e[0][0], math.exp(-6.0), places=12)
        self.assertAlmostEqual(e[1][1], math.exp(1.5), places=9)
        self.assertEqual(e[0][1], 0.0)

    def test_equilibrium_does_not_move_at_zero_reactivity(self):
        for t in (0.05, 10.0, 500.0):
            self.assertAlmostEqual(exact_power(SIX_GROUP, 0.0, t), 1.0, places=9)

    def test_prompt_jump_and_period(self):
        """Just after a step the power is near beta / (beta - rho); long after, it grows at the inhour rate."""
        rho = 100e-5
        beta_total = math.fsum(SIX_GROUP["beta"])
        self.assertAlmostEqual(exact_power(SIX_GROUP, rho, 0.02) / (beta_total / (beta_total - rho)), 1.0, delta=3e-3)
        t1, t2 = 400.0, 420.0
        omega = math.log(exact_power(SIX_GROUP, rho, t2) / exact_power(SIX_GROUP, rho, t1)) / (t2 - t1)
        self.assertAlmostEqual(1.0 / omega, 54.92, delta=0.05)


# Measured agreement is 7e-6 or better at every time and step below (ROS2, outerDt 0.01 s); the tolerance leaves a
# margin of about seven; a 1 % error in one decay constant moves the 60 s value by about 4e-4, eight times the tolerance
# (see the last test).
TOLERANCE = 5e-5


class TestEngineAgainstExactStep(unittest.TestCase):
    TIMES = (0.02, 0.1, 1.0, 10.0, 60.0)

    def check(self, rho, tolerance):
        for t in self.TIMES:
            want = exact_power(SIX_GROUP, rho, t)
            got = engine_power(SIX_GROUP, rho, t)
            self.assertLess(abs(got / want - 1.0), tolerance, f"rho={rho} t={t}: engine {got}, exact {want}")

    def test_plus_100_pcm(self):
        self.check(100e-5, TOLERANCE)

    def test_minus_500_pcm(self):
        self.check(-500e-5, TOLERANCE)

    def test_plus_300_pcm(self):
        self.check(300e-5, TOLERANCE)

    def test_the_tolerance_is_tight_enough_to_see_a_one_percent_constant_error(self):
        """The engine run with lambda_1 raised by 1 % must disagree with the exact solution (original constants) by
        more than the tolerance at some time; otherwise the agreement above would prove little."""
        changed = dict(SIX_GROUP, **{"lambda": [SIX_GROUP["lambda"][0] * 1.01] + SIX_GROUP["lambda"][1:]})
        worst = max(abs(engine_power(changed, 100e-5, t) / exact_power(SIX_GROUP, 100e-5, t) - 1.0) for t in self.TIMES)
        self.assertGreater(worst, 5 * TOLERANCE)


if __name__ == "__main__":
    unittest.main()
