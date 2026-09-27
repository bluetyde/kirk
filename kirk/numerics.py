"""Small portable numerics: a seeded generator and a dense linear solver.

Both are written so the TypeScript port can reproduce them bit for bit
(64-bit integer arithmetic via BigInt there; IEEE doubles everywhere else).

Every sum is an explicit left-to-right loop. Python 3.12 changed the built-in sum() of floats to compensated
(Neumaier) summation, so sum() gives last-bit-different results on 3.11 and 3.12+, and JavaScript has no
equivalent. An explicit loop gives the same bits in every Python version and in the TypeScript port.
"""
from __future__ import annotations

import math

MASK64 = (1 << 64) - 1


class SplitMix64:
    """SplitMix64 generator. State is one 64-bit integer, so checkpoints are trivial."""

    def __init__(self, seed: int):
        self.state = seed & MASK64

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def uniform(self) -> float:
        """Uniform in (0, 1): 53 random bits, never exactly 0."""
        return ((self.next_u64() >> 11) + 0.5) / 9007199254740992.0

    def normal(self) -> float:
        """Standard normal by Box-Muller (no cached spare, so the state is just the integer)."""
        u1, u2 = self.uniform(), self.uniform()
        return math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Solve a x = b by Gaussian elimination with partial pivoting. Copies its inputs."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if m[piv][col] == 0.0:
            raise ZeroDivisionError("singular matrix")
        if piv != col:
            m[col], m[piv] = m[piv], m[col]
        pivot_row = m[col]
        inv = 1.0 / pivot_row[col]
        for r in range(col + 1, n):
            factor = m[r][col] * inv
            if factor != 0.0:
                row = m[r]
                for c in range(col, n + 1):
                    row[c] -= factor * pivot_row[c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = m[r][n]
        for c in range(r + 1, n):
            s -= m[r][c] * x[c]
        x[r] = s / m[r][r]
    return x


def lu_factor(a: list[list[float]]):
    """LU factorization with partial pivoting, reused for the two ROS2 stages."""
    n = len(a)
    lu = [row[:] for row in a]
    perm = list(range(n))
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(lu[r][col]))
        if lu[piv][col] == 0.0:
            raise ZeroDivisionError("singular matrix")
        if piv != col:
            lu[col], lu[piv] = lu[piv], lu[col]
            perm[col], perm[piv] = perm[piv], perm[col]
        inv = 1.0 / lu[col][col]
        for r in range(col + 1, n):
            lu[r][col] *= inv
            f = lu[r][col]
            if f != 0.0:
                rr, rc = lu[r], lu[col]
                for c in range(col + 1, n):
                    rr[c] -= f * rc[c]
    return lu, perm


def lu_solve(factored, b: list[float]) -> list[float]:
    lu, perm = factored
    n = len(b)
    y = [b[perm[i]] for i in range(n)]
    for i in range(n):
        row = lu[i]
        acc = 0.0
        for j in range(i):
            acc += row[j] * y[j]
        y[i] -= acc
    for i in range(n - 1, -1, -1):
        row = lu[i]
        acc = 0.0
        for j in range(i + 1, n):
            acc += row[j] * y[j]
        y[i] = (y[i] - acc) / row[i]
    return y
