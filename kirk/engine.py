"""Reference engine for capability point-kinetics/lumped-thermal-v1.

Readable Python is the source of truth; the browser engine is a port of this file.
Inputs are plain params (kirk/params.py); kirk.libformat builds them from a library folder
(meaning of each quantity: docs/library-format.md).

Time is advanced in fixed outer steps (config.outerDt). Inside each outer step an
adaptive ROS2 Rosenbrock method (order 2, L-stable) integrates the stiff system.

Order of work at an outer-step boundary t_k (the same for every run and frame rate):
  1. rod motions are rebased and instruments are sampled (noise from the seeded generator),
  2. trips whose inputs are instrument readings are evaluated; a new trip scrams all rods,
  3. commands submitted while the engine rests at t_k are applied in sequence-number order
     when the next step() starts, still at time t_k and before any integration.
Trips whose inputs are all truth signals are located inside solver steps, to config.eventTol.
"""
from __future__ import annotations

import copy
import math

from .params import Model, ReactorParams, check_params, params_digest
from .numerics import SplitMix64, lu_factor, lu_solve

ENGINE_VERSION = "0.2.0"

DEFAULT_CONFIG = {
    "outerDt": 0.01,     # s, fixed scheduling interval
    "rtol": 1e-6,
    "hInit": 1e-5,       # s, first solver step
    "hMin": 1e-12,       # s, below this the solver gives up
    "eventTol": 1e-7,    # s, truth-trip location
    "method": "ros2",
}

# ROS3P coefficients: J. Lang and J. Verwer, "ROS3P—An accurate third-order
# Rosenbrock solver designed for parabolic problems", BIT Numerical Mathematics
# 41 (2001) 731–738, Table 5.1 (p. 735), transformed form (5.2).
gamma = 7.886751345948129e-01
a21 = 1.267949192431123e+00
a31 = 1.267949192431123e+00
a32 = 0.0
c21 = -1.607695154586736e+00
c31 = -3.464101615137755e+00
c32 = -1.732050807568877e+00
alpha1 = 0.0
alpha2 = 1.0
alpha3 = 1.0
gamma1 = 7.886751345948129e-01
gamma2 = -2.113248654051871e-01
gamma3 = -1.077350269189626e+00
m1 = 2.0
m2 = 5.773502691896258e-01
m3 = 4.226497308103742e-01
mhat1 = 2.113248654051871e+00
mhat2 = 1.0
mhat3 = 4.226497308103742e-01

GAMMA = 1.0 + 1.0 / math.sqrt(2.0)
IP, IC0, ITF, ITC, II, IX, IEP, IEH = 0, 1, 7, 8, 9, 10, 11, 12
NBASE = 13
LAGGABLE = ("power", "fuelTemp", "coolantTemp", "xenon")


class InitError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f"{code}: {message}")


class CheckpointError(ValueError):
    pass


class SolverError(RuntimeError):
    pass


# ---------------------------------------------------------------- predicates

def _pred_signals(p, default):
    for key in ("all", "any"):
        if key in p:
            out = []
            for sub in p[key]:
                out += _pred_signals(sub, default)
            return out
    if "not" in p:
        return _pred_signals(p["not"], default)
    return [p.get("signal", default)]


def _pred_leaves(p, default):
    """Numeric threshold comparisons in a predicate, as (signal, use_abs, threshold). `between` gives both edges."""
    for key in ("all", "any"):
        if key in p:
            out = []
            for sub in p[key]:
                out += _pred_leaves(sub, default)
            return out
    if "not" in p:
        return _pred_leaves(p["not"], default)
    sig, op, ref = p.get("signal", default), p["op"], p["value"]
    if op == "between":
        return [(sig, False, ref[0]), (sig, False, ref[1])]
    if isinstance(ref, str):
        return []
    return [(sig, op == "absGt", ref)]


def _sign(x: float) -> int:
    return (x > 0.0) - (x < 0.0)


def eval_predicate(p, get, default=None) -> bool:
    if "all" in p:
        return all(eval_predicate(s, get, default) for s in p["all"])
    if "any" in p:
        return any(eval_predicate(s, get, default) for s in p["any"])
    if "not" in p:
        return not eval_predicate(p["not"], get, default)
    v = get(p.get("signal", default))
    if v is None:            # a dead instrument never satisfies a condition
        return False
    op, ref = p["op"], p["value"]
    if op == "eq":
        return v == ref
    if op == "ne":
        return v != ref
    if op == "between":
        return ref[0] <= v <= ref[1]
    if op == "gt":
        return v > ref
    if op == "ge":
        return v >= ref
    if op == "lt":
        return v < ref
    if op == "le":
        return v <= ref
    if op == "absGt":
        return abs(v) > ref
    raise ValueError(f"unknown operator {op!r}")


# ---------------------------------------------------------------- engine

class Engine:
    def __init__(self, params: ReactorParams, init: dict | None = None, seed: int = 1, config: dict | None = None):
        self.params = copy.deepcopy(params)      # the caller may change its dict later; this run keeps its inputs
        check_params(self.params)
        self.digest = params_digest(self.params)
        self.model = mdl = Model(self.params)
        self.config = dict(DEFAULT_CONFIG, **(config or {}))
        method = self.config.get("method")
        if method == "ros2":
            self._stepper = self._ros2
            self._step_exp = -0.5
            self._step_fac = lambda err: 0.9 / math.sqrt(err)
        elif method == "ros3p":
            self._stepper = self._ros3p
            self._step_exp = -1.0 / 3.0
            self._step_fac = lambda err: 0.9 * (err ** self._step_exp)
        else:
            raise InitError("E_INIT_INVALID", f"unknown method {method!r}")
        self.init_spec = copy.deepcopy(init or {})
        self.seed = seed
        self.rng = SplitMix64(seed)

        self.lagged = [i for i in mdl.instruments if i["lag"] > 0 and i["signal"][6:] in LAGGABLE]
        self.lag_index = {ins["id"]: NBASE + k for k, ins in enumerate(self.lagged)}
        self.located_trips, self.boundary_trips = [], []
        for trip in mdl.trips:
            sigs = _pred_signals(trip["predicate"], trip["input"])
            (self.located_trips if all(s.startswith("truth.") for s in sigs) else self.boundary_trips).append(trip)

        self.step_index = 0
        self.extra_rho = 0.0
        self.h = self.config["hInit"]
        self.latched: list[str] = []
        self.active_trips: list[str] = []
        self.faults: dict[str, str] = {}
        self.indicated: dict[str, float | None] = {}
        self.pending: list[dict] = []
        self.next_seq = 1
        self.command_log: list[dict] = []
        self.events: list[dict] = []
        self.halted: str | None = None
        self.diag = {"steps": 0, "rejected": 0, "rhsCalls": 0}
        self._init_state(self.init_spec)
        self.peak_power, self.peak_time = self.y[IP], 0.0
        self._boundary(first=True)

    # ------------------------------------------------ initial state
    def _init_state(self, init):
        mdl = self.model
        unknown = set(init.get("rods", {})) - set(mdl.rod_by_id)
        if unknown:
            raise InitError("E_INIT_INVALID", f"unknown rods {sorted(unknown)}")
        self.motions = {r.id: {"kind": "still", "t0": 0.0, "x0": float(init.get("rods", {}).get(r.id, mdl.ref_rods[r.id]))}
                        for r in mdl.rods}
        for rid, m in self.motions.items():
            if not 0.0 <= m["x0"] <= 1.0:
                raise InitError("E_INIT_INVALID", f"rod {rid} position must be in [0, 1]")
        self.mode = init.get("mode", mdl.initial_mode)
        if self.mode not in mdl.modes:
            raise InitError("E_INIT_INVALID", f"unknown mode {self.mode!r}")
        self.pumps = {p: bool(init.get("pumps", {}).get(p, True)) for p in mdl.pumps}
        tf = float(init.get("Tfuel", mdl.ref_tfuel))
        tc = float(init.get("Tcoolant", mdl.ref_tcool))

        poisons = init.get("poisons", {"mode": "zero"})
        power = init.get("power", {"mode": "source-equilibrium"})
        if poisons["mode"] == "equilibrium" and power["mode"] == "source-equilibrium":
            raise InitError("E_INIT_INVALID", "equilibrium poisons need a given power")

        y = [0.0] * (NBASE + len(self.lagged))
        y[ITF], y[ITC] = tf, tc
        if power["mode"] in ("given", "critical-equilibrium"):
            p0 = float(power["value"])
            if p0 < 0:
                raise InitError("E_INIT_INVALID", "power must be >= 0")
        else:
            p0 = None
        if poisons["mode"] == "zero":
            i0 = x0 = 0.0
        elif poisons["mode"] == "given":
            i0, x0 = float(poisons["I"]), float(poisons["X"])
        elif poisons["mode"] == "equilibrium":
            phi = mdl.flux_per_watt * p0
            i0 = mdl.gamma_i * mdl.sigma_f * phi / mdl.lambda_i
            x0 = (mdl.gamma_i + mdl.gamma_x) * mdl.sigma_f * phi / (mdl.lambda_x + mdl.sigma_x * phi)
        else:
            raise InitError("E_INIT_INVALID", f"unknown poisons mode {poisons['mode']!r}")
        y[II], y[IX] = i0, x0

        self.y = y
        rho = self.reactivity(0.0, y)["total"]
        S, L = mdl.ext_source, mdl.gen_time
        if power["mode"] == "source-equilibrium":
            if S <= 0.0:
                raise InitError("E_INIT_NO_EQUILIBRIUM", "source equilibrium needs a positive neutron source")
            if rho >= 0.0:
                raise InitError("E_INIT_NO_EQUILIBRIUM", f"source equilibrium needs negative reactivity (rho = {rho:.6g})")
            p0 = -S * L / rho
        elif power["mode"] == "critical-equilibrium":
            if S != 0.0:
                raise InitError("E_INIT_NO_EQUILIBRIUM", "constant power at criticality needs zero source (P = -S*Lambda/rho)")
            if abs(rho) > 1e-12:
                raise InitError("E_INIT_NO_EQUILIBRIUM", f"critical equilibrium needs rho = 0 (rho = {rho:.6g})")
        elif power["mode"] != "given":
            raise InitError("E_INIT_INVALID", f"unknown power mode {power['mode']!r}")
        y[IP] = p0

        prec = init.get("precursors", "equilibrium")
        if prec == "equilibrium":
            for i in range(6):
                y[IC0 + i] = mdl.beta[i] * p0 / (L * mdl.lam[i])
        else:
            if len(prec) != 6 or any(c < 0 for c in prec):
                raise InitError("E_INIT_INVALID", "precursors must be 'equilibrium' or six values >= 0")
            for i in range(6):
                y[IC0 + i] = float(prec[i])
        for ins in self.lagged:
            y[self.lag_index[ins["id"]]] = self._truth_signal(ins["signal"], 0.0, y)

    # ------------------------------------------------ rods
    def rod_position(self, rid: str, t: float) -> float:
        m = self.motions[rid]
        k = m["kind"]
        if k == "still":
            return m["x0"]
        if k == "move":
            return min(1.0, max(0.0, m["x0"] + m["v"] * (t - m["t0"])))
        rod = self.model.rod_by_id[rid]
        if k == "fire":
            return min(1.0, m["x0"] + (t - m["t0"]) / rod.fire_time)
        if k == "scram":
            return rod.scram_position(m["tau0"] + (t - m["t0"]))
        raise ValueError(k)

    def _rebase_rods(self, t: float) -> None:
        for rid, m in self.motions.items():
            if m["kind"] == "still":
                continue
            rod = self.model.rod_by_id[rid]
            x = self.rod_position(rid, t)
            if m["kind"] == "scram":
                tau = m["tau0"] + (t - m["t0"])
                self.motions[rid] = ({"kind": "still", "t0": t, "x0": 0.0} if tau >= rod.scram_t[-1]
                                     else {"kind": "scram", "t0": t, "tau0": tau})
            elif (m["kind"] == "move" and (x <= 0.0 or x >= 1.0)) or (m["kind"] == "fire" and x >= 1.0):
                self.motions[rid] = {"kind": "still", "t0": t, "x0": x}
            else:
                self.motions[rid] = dict(m, t0=t, x0=x)

    def _scram_all(self, t: float) -> None:
        for rid in self.motions:
            x = self.rod_position(rid, t)
            if x <= 0.0:
                self.motions[rid] = {"kind": "still", "t0": t, "x0": 0.0}
            else:
                self.motions[rid] = {"kind": "scram", "t0": t, "tau0": self.model.rod_by_id[rid].scram_tau(x)}

    # ------------------------------------------------ physics
    def reactivity(self, t, y) -> dict:
        mdl = self.model
        rods = 0.0
        for r in mdl.rods:      # explicit loop, not sum(): see numerics.py
            rods += r.worth(self.rod_position(r.id, t))
        fuel = mdl.fuel_temp(y[ITF])
        cool = mdl.cool_temp(y[ITC])
        xe = mdl.xenon(y[IX])
        base = mdl.ref_rho + mdl.calibration
        return {"total": base + self.extra_rho + rods + fuel + cool + xe, "reference": mdl.ref_rho,
                "calibration": mdl.calibration, "fault": self.extra_rho,
                "rods": rods, "fuel": fuel, "coolant": cool, "xenon": xe}

    def rhs(self, t, y) -> list[float]:
        self.diag["rhsCalls"] += 1
        mdl = self.model
        P, tf, tc, i_, x_ = y[IP], y[ITF], y[ITC], y[II], y[IX]
        rho = mdl.ref_rho + mdl.calibration + self.extra_rho
        for r in mdl.rods:
            rho += r.worth(self.rod_position(r.id, t))
        rho += mdl.fuel_temp(tf) + mdl.cool_temp(tc) + mdl.xenon(x_)
        L = mdl.gen_time
        d = [0.0] * len(y)
        d[IP] = (rho - mdl.beta_total) / L * P + mdl.ext_source
        for k in range(6):
            c = y[IC0 + k]
            d[IP] += mdl.lam[k] * c
            d[IC0 + k] = mdl.beta[k] / L * P - mdl.lam[k] * c
        q_hx = mdl.UA * (tc - mdl.sink_temp) if self.pumps.get(mdl.hx_pump, False) else 0.0
        q_fc = mdl.hA * (tf - tc)
        d[ITF] = (mdl.fuel_fraction * P - q_fc) / (mdl.fuel_mass * mdl.fuel_cp(tf))
        d[ITC] = ((1.0 - mdl.fuel_fraction) * P + q_fc - q_hx) / (mdl.cool_mass * mdl.cool_cp)
        phi = mdl.flux_per_watt * P
        d[II] = mdl.gamma_i * mdl.sigma_f * phi - mdl.lambda_i * i_
        d[IX] = mdl.gamma_x * mdl.sigma_f * phi + mdl.lambda_i * i_ - mdl.lambda_x * x_ - mdl.sigma_x * phi * x_
        d[IEP] = P
        d[IEH] = q_hx
        for ins in self.lagged:
            j = self.lag_index[ins["id"]]
            d[j] = (self._truth_signal(ins["signal"], t, y) - y[j]) / ins["lag"]
        return d

    def _truth_signal(self, sig: str, t: float, y: list[float]):
        name = sig[len("truth."):]
        if name == "power":
            return y[IP]
        if name == "fuelTemp":
            return y[ITF]
        if name == "coolantTemp":
            return y[ITC]
        if name == "xenon":
            return y[IX]
        if name == "mode":
            return self.mode
        if name == "period":
            dp = self.rhs(t, y)[IP]
            return math.inf if dp == 0.0 else y[IP] / dp
        if name.startswith("rod."):
            return self.rod_position(name[4:], t)
        raise KeyError(sig)

    def _signal(self, sig: str, t: float, y: list[float]):
        if sig.startswith("indicated."):
            return self.indicated.get(sig[len("indicated."):])
        return self._truth_signal(sig, t, y)

    # ------------------------------------------------ solver
    def _scales(self, y):
        """Absolute tolerances and finite-difference floors per component."""
        s = [1e-12] * len(y)
        s[ITF] = s[ITC] = 1e-6
        s[II] = s[IX] = 1e8
        s[IEP] = s[IEH] = 1e-6
        for ins in self.lagged:
            name = ins["signal"][6:]
            s[self.lag_index[ins["id"]]] = {"power": 1e-12, "fuelTemp": 1e-6, "coolantTemp": 1e-6, "xenon": 1e8}[name]
        return s

    def _jacobian(self, t, y, f0):
        n = len(y)
        floor = [1e-6] * n
        floor[ITF] = floor[ITC] = 1.0
        floor[II] = floor[IX] = 1e12
        floor[IEP] = floor[IEH] = 1.0
        cols = []
        for j in range(n):
            dj = 1e-7 * max(abs(y[j]), floor[j])
            yj = y[:]
            yj[j] += dj
            fj = self.rhs(t, yj)
            cols.append([(a - b) / dj for a, b in zip(fj, f0)])
        J = [[cols[j][i] for j in range(n)] for i in range(n)]
        dt = 1e-7 * max(1.0, abs(t))
        ft = [(a - b) / dt for a, b in zip(self.rhs(t + dt, y), f0)]
        return J, ft

    def _ros2(self, t, y, h, J, f0, ft):
        n = len(y)
        M = [[(1.0 if i == j else 0.0) - GAMMA * h * J[i][j] for j in range(n)] for i in range(n)]
        lu = lu_factor(M)
        k1 = lu_solve(lu, [f0[i] + GAMMA * h * ft[i] for i in range(n)])
        y1 = [y[i] + h * k1[i] for i in range(n)]
        f1 = self.rhs(t + h, y1)
        k2 = lu_solve(lu, [f1[i] - GAMMA * h * ft[i] - 2.0 * k1[i] for i in range(n)])
        y_new = [y[i] + 1.5 * h * k1[i] + 0.5 * h * k2[i] for i in range(n)]
        atol = self._scales(y)
        rtol = self.config["rtol"]
        acc = 0.0
        for i in range(n):
            e = 0.5 * h * (k1[i] + k2[i])
            sc = atol[i] + rtol * max(abs(y[i]), abs(y_new[i]))
            acc += (e / sc) ** 2
        return y_new, math.sqrt(acc / n)

    def _ros3p(self, t, y, h, J, f0, ft):
        n = len(y)
        inv_h_gamma = 1.0 / (h * gamma)
        M = [[(inv_h_gamma if i == j else 0.0) - J[i][j] for j in range(n)] for i in range(n)]
        lu = lu_factor(M)

        # Stage 1: alpha1 = 0.0, no prior stages
        rhs1 = [f0[i] + h * gamma1 * ft[i] for i in range(n)]
        u1 = lu_solve(lu, rhs1)

        # Stage 2: alpha2 = 1.0
        y_stage2 = [y[i] + a21 * u1[i] for i in range(n)]
        f_stage2 = self.rhs(t + h, y_stage2)
        rhs2 = [f_stage2[i] + (c21 / h) * u1[i] + h * gamma2 * ft[i] for i in range(n)]
        u2 = lu_solve(lu, rhs2)

        # Stage 3: alpha3 = 1.0, a31 = a21, a32 = 0.0 (evaluates F at the same point as stage 2)
        rhs3 = [f_stage2[i] + (c31 / h) * u1[i] + (c32 / h) * u2[i] + h * gamma3 * ft[i] for i in range(n)]
        u3 = lu_solve(lu, rhs3)

        y_new = [y[i] + m1 * u1[i] + m2 * u2[i] + m3 * u3[i] for i in range(n)]
        y_hat = [y[i] + mhat1 * u1[i] + mhat2 * u2[i] + mhat3 * u3[i] for i in range(n)]

        atol = self._scales(y)
        rtol = self.config["rtol"]
        acc = 0.0
        for i in range(n):
            e = y_new[i] - y_hat[i]
            sc = atol[i] + rtol * max(abs(y[i]), abs(y_new[i]))
            acc += (e / sc) ** 2
        return y_new, math.sqrt(acc / n)

    def _integrate(self, t0: float, t1: float) -> None:
        y, h = self.y, self.h
        t = t0
        while t1 - t > 1e-12 * self.config["outerDt"]:
            f0 = self.rhs(t, y)
            J, ft = self._jacobian(t, y, f0)
            truncated = h >= t1 - t
            hs = t1 - t if truncated else h
            while True:
                y_new, err = self._stepper(t, y, hs, J, f0, ft)
                if err <= 1.0 and y_new[IP] >= 0.0:
                    break
                self.diag["rejected"] += 1
                hs *= 0.25 if y_new[IP] < 0.0 else max(0.2, self._step_fac(err))
                truncated = False
                if hs < self.config["hMin"]:
                    raise SolverError(f"step size underflow at t = {t:.9g}")
            fac = min(4.0, max(0.2, self._step_fac(max(err, 1e-10))))
            t_new = t1 if truncated else t + hs
            t_new, y_new = self._locate_trips(t, y, hs, t_new, y_new, J, f0, ft)
            h = max(h, hs * fac) if truncated else hs * fac
            t, y = t_new, y_new
            self.diag["steps"] += 1
            if y[IP] > self.peak_power:
                self.peak_power, self.peak_time = y[IP], t
        self.y, self.h = y, h

    def _leaf_g(self, leaf, t, y):
        sig, use_abs, ref = leaf
        v = self._truth_signal(sig, t, y)
        if v is None or isinstance(v, str):
            return None
        return (abs(v) if use_abs else v) - ref

    def _bisect(self, t, y, hs, J, f0, ft, crossed, y_end):
        """Smallest step s in (0, hs] (to eventTol) at which crossed(s, y_s) holds; crossed(hs) is known to hold."""
        lo, hi, y_hi = 0.0, hs, y_end
        while hi - lo > self.config["eventTol"]:
            mid = 0.5 * (lo + hi)
            y_mid, _ = self._stepper(t, y, mid, J, f0, ft)
            if crossed(mid, y_mid):
                hi, y_hi = mid, y_mid
            else:
                lo = mid
        return hi, y_hi

    def _locate_trips(self, t, y, hs, t_new, y_new, J, f0, ft):
        """If a truth-signal trip condition holds anywhere in this step, shorten the step to the earliest such point and trip there.

        A condition can be entered and left within one step (a `between` window crossed in one step), so besides the end point
        every threshold crossing inside the step is located and the predicate checked just after it (M1 review finding 2)."""
        cands = [tr for tr in self.located_trips
                 if tr["id"] not in self.latched and tr["id"] not in self.active_trips and self._trip_mode_ok(tr)]
        if not cands:
            return t_new, y_new
        best = None      # (s, y_s)
        for tr in cands:
            pred, inp = tr["predicate"], tr["input"]
            holds = lambda s, ys, pred=pred, inp=inp: eval_predicate(pred, lambda sig: self._truth_signal(sig, t + s, ys), inp)
            hits = []
            for leaf in _pred_leaves(pred, inp):
                g0, g1 = self._leaf_g(leaf, t, y), self._leaf_g(leaf, t_new, y_new)
                if g0 is None or g1 is None or _sign(g0) == _sign(g1):
                    continue
                s0 = _sign(g0)
                s, ys = self._bisect(t, y, hs, J, f0, ft,
                                     lambda s, ys, leaf=leaf, s0=s0: _sign(self._leaf_g(leaf, t + s, ys)) != s0, y_new)
                if holds(s, ys):
                    hits.append((s, ys))
            if not hits and holds(hs, y_new):
                hits.append(self._bisect(t, y, hs, J, f0, ft, holds, y_new))
            for h in hits:
                if best is None or h[0] < best[0]:
                    best = h
        if best is None:
            return t_new, y_new
        s_ev, y_ev = best
        t_ev = t + s_ev
        get_ev = lambda sig: self._truth_signal(sig, t_ev, y_ev)
        for tr in cands:
            if eval_predicate(tr["predicate"], get_ev, tr["input"]):
                self._trip(tr, t_ev)
        return t_ev, y_ev

    # ------------------------------------------------ trips, instruments, commands
    def _trip_mode_ok(self, trip) -> bool:
        return "modes" not in trip or self.mode in trip["modes"]

    def _trip(self, trip, t) -> None:
        self.events.append({"type": "trip", "id": trip["id"], "t": t})
        (self.latched if trip["latching"] else self.active_trips).append(trip["id"])
        self._scram_all(t)

    def _sample_instruments(self, t) -> None:
        for ins in self.model.instruments:
            z = self.rng.normal()      # always drawn, so faults don't shift the random stream
            iid = ins["id"]
            if iid in self.lag_index:
                v = self.y[self.lag_index[iid]]
            else:
                v = self._truth_signal(ins["signal"], t, self.y)
            fault = self.faults.get(iid)
            if fault == "dead":
                self.indicated[iid] = None
                continue
            if fault == "stuck" and iid in self.indicated:
                continue
            v = v * (1.0 + ins["noise"] * z)
            lo, hi = ins["range"]
            self.indicated[iid] = min(hi, max(lo, v))

    def _boundary(self, first=False) -> None:
        t = self.t
        self._rebase_rods(t)
        self._sample_instruments(t)
        get = lambda s: self._signal(s, t, self.y)
        # non-latching trips clear when their condition clears
        for tid in list(self.active_trips):
            tr = next(x for x in self.model.trips if x["id"] == tid)
            if not eval_predicate(tr["predicate"], get, tr["input"]):
                self.active_trips.remove(tid)
        for tr in self.boundary_trips + ([] if not first else self.located_trips):
            if tr["id"] in self.latched or tr["id"] in self.active_trips or not self._trip_mode_ok(tr):
                continue
            if eval_predicate(tr["predicate"], get, tr["input"]):
                self._trip(tr, t)
        self._check_reject_tables()

    def _check_reject_tables(self) -> None:
        mdl = self.model
        checks = [(mdl.fuel_temp, self.y[ITF], "fuelTemp"), (mdl.cool_temp, self.y[ITC], "coolantTemp"),
                  (mdl.xenon, self.y[IX], "xenon"), (mdl.fuel_cp, self.y[ITF], "fuelCp")]
        checks += [(r.worth, self.rod_position(r.id, self.t), f"rod.{r.id}") for r in mdl.rods]
        for table, x, name in checks:
            if table.out_of_range == "reject" and table.value(x)[1]:
                self.halted = f"R_TABLE_REJECT_{name}"
                self.events.append({"type": "halt", "t": self.t, "reason": self.halted})

    def submit(self, cmd: dict, client_id: str = "local") -> int:
        """Queue a command. It takes effect at the current boundary, before the next outer step."""
        seq = self.next_seq
        self.next_seq += 1
        entry = {"seq": seq, "step": self.step_index, "t": self.t, "clientId": client_id, "cmd": copy.deepcopy(cmd)}
        self.command_log.append(entry)
        self.pending.append(entry)
        return seq

    def _interlock_block(self, ctype: str):
        get = lambda s: self._signal(s, self.t, self.y)
        for il in self.model.interlocks:
            if ctype in il["blocks"] and eval_predicate(il["when"], get):
                return il
        return None

    def _apply(self, entry) -> None:
        cmd, t = entry["cmd"], self.t
        status, reason = "accepted", None
        ctype = cmd.get("type")
        tripped = bool(self.latched or self.active_trips)
        il = self._interlock_block(ctype) if isinstance(ctype, str) else None
        if ctype == "rod.move":
            rid, direction = cmd.get("rod"), cmd.get("direction")
            if rid not in self.motions:
                status, reason = "rejected", "REJ_UNKNOWN_ROD"
            elif direction not in ("in", "out", "stop"):
                status, reason = "rejected", "REJ_BAD_ARGUMENT"
            elif il:
                status, reason = "rejected", f"REJ_INTERLOCK:{il['id']}"
            elif direction == "out" and tripped:
                status, reason = "rejected", "REJ_TRIPPED"
            elif self.motions[rid]["kind"] == "scram":
                # any drive command, even "in", would replace the scram profile with the slower drive (M1 review finding 1)
                status, reason = "rejected", "REJ_SCRAM_IN_PROGRESS"
            else:
                x = self.rod_position(rid, t)
                if direction == "stop":
                    self.motions[rid] = {"kind": "still", "t0": t, "x0": x}
                else:
                    v = self.model.rod_by_id[rid].speed * (1.0 if direction == "out" else -1.0)
                    self.motions[rid] = {"kind": "move", "t0": t, "x0": x, "v": v}
        elif ctype == "rod.fire":
            rid = cmd.get("rod")
            if rid not in self.motions:
                status, reason = "rejected", "REJ_UNKNOWN_ROD"
            elif not self.model.rod_by_id[rid].pulse_capable:
                status, reason = "rejected", "REJ_NOT_PULSE_CAPABLE"
            elif il:
                status, reason = "rejected", f"REJ_INTERLOCK:{il['id']}"
            elif tripped:
                status, reason = "rejected", "REJ_TRIPPED"
            else:
                self.motions[rid] = {"kind": "fire", "t0": t, "x0": self.rod_position(rid, t)}
        elif ctype == "mode.set":
            mode = cmd.get("mode")
            if mode not in self.model.modes:
                status, reason = "rejected", "REJ_UNKNOWN_MODE"
            elif il:
                status, reason = "rejected", f"REJ_INTERLOCK:{il['id']}"
            else:
                self.mode = mode
        elif ctype == "pump.set":
            pump = cmd.get("pump")
            if pump not in self.pumps:
                status, reason = "rejected", "REJ_UNKNOWN_PUMP"
            elif il:
                status, reason = "rejected", f"REJ_INTERLOCK:{il['id']}"
            else:
                self.pumps[pump] = bool(cmd.get("on"))
        elif ctype == "scram":
            if "manual" not in self.latched:
                self.latched.append("manual")
            self._scram_all(t)
            self.events.append({"type": "trip", "id": "manual", "t": t})
        elif ctype == "trip.reset":
            get = lambda s: self._signal(s, t, self.y)
            still = [tid for tid in self.latched if tid != "manual" and eval_predicate(
                next(x for x in self.model.trips if x["id"] == tid)["predicate"], get,
                next(x for x in self.model.trips if x["id"] == tid)["input"])]
            if still:
                status, reason = "rejected", "REJ_TRIP_ACTIVE:" + ",".join(still)
            else:
                self.latched = []
        elif ctype == "fault.reactivity":
            self.extra_rho += float(cmd.get("deltaRho", 0.0))
        elif ctype == "fault.instrument":
            iid, kind = cmd.get("instrument"), cmd.get("kind")
            if iid not in {i["id"] for i in self.model.instruments}:
                status, reason = "rejected", "REJ_UNKNOWN_INSTRUMENT"
            elif kind == "clear":
                self.faults.pop(iid, None)
            elif kind in ("stuck", "dead"):
                self.faults[iid] = kind
            else:
                status, reason = "rejected", "REJ_BAD_ARGUMENT"
        else:
            status, reason = "rejected", "REJ_UNKNOWN_COMMAND"
        self.events.append({"type": "command", "seq": entry["seq"], "clientId": entry["clientId"],
                            "t": t, "status": status, "reason": reason})

    # ------------------------------------------------ public API
    @property
    def t(self) -> float:
        return self.step_index * self.config["outerDt"]

    def step(self) -> None:
        """Advance exactly one outer step."""
        if self.halted:
            return
        # commands queued at this boundary apply now: after this boundary's trip checks, before integrating
        queue, self.pending = sorted(self.pending, key=lambda c: c["seq"]), []
        for c in queue:
            self._apply(c)
        t0 = self.t
        t1 = (self.step_index + 1) * self.config["outerDt"]
        self._integrate(t0, t1)
        self.step_index += 1
        self._boundary()

    def advance(self, seconds: float) -> None:
        """Advance a whole number of outer steps. Splitting a span into several calls gives identical results."""
        n = round(seconds / self.config["outerDt"])
        for _ in range(n):
            self.step()

    def validity(self) -> dict:
        mdl, dom = self.model, self.model.validity
        out, reasons = [], []
        if dom is None:         # params without a validity section claim no domain
            reasons.append("R_PARAMS_UNVALIDATED")
        else:
            if dom["status"] != "validated-for-domain":
                reasons.append("R_LIBRARY_" + dom["status"].upper().replace("-", "_"))
            for r in mdl.rods:
                lo, hi = dom["rods"][r.id]
                if not lo <= self.rod_position(r.id, self.t) <= hi:
                    out.append(f"R_DOMAIN_ROD_{r.id}")
            for name, val in (("TFUEL", self.y[ITF]), ("TCOOLANT", self.y[ITC]), ("XENON", self.y[IX])):
                lo, hi = dom[{"TFUEL": "Tfuel", "TCOOLANT": "Tcoolant", "XENON": "xenon"}[name]]
                if not lo <= val <= hi:
                    out.append(f"R_DOMAIN_{name}")
            moved = {r.id: self.rod_position(r.id, self.t) for r in mdl.rods
                     if abs(self.rod_position(r.id, self.t) - mdl.ref_rods[r.id]) > 1e-9}
            if len(moved) >= 2:
                covered = any(all(abs(jc["rods"].get(rid, mdl.ref_rods[rid]) - self.rod_position(rid, self.t)) <= 0.05
                                  for rid in mdl.rod_by_id) for jc in dom["jointChecked"])
                if not covered:
                    reasons.append("R_JOINT_UNCHECKED")
        if self.halted:
            out.append(self.halted)
        status = "outOfDomain" if out else ("unvalidated" if reasons else "supported")
        return {"status": status, "reasons": out + reasons}

    def shape(self) -> list[float]:
        """Current power shape (fractions of total power), base + rod deltas + temperature delta."""
        s = self.model.shape
        if s is None:
            raise ValueError("these params have no shape section")
        n = len(s["elements"]) * (len(s["axialEdgesCm"]) - 1)
        out = list(s["base"])

        def add(grid, arr, x):
            x = min(grid[-1], max(grid[0], x))
            k = 0
            while k < len(grid) - 2 and x > grid[k + 1]:
                k += 1
            w = (x - grid[k]) / (grid[k + 1] - grid[k])
            a, b = arr[k * n:(k + 1) * n], arr[(k + 1) * n:(k + 2) * n]
            for j in range(n):
                out[j] += (1 - w) * a[j] + w * b[j]

        for rid, d in s["rodDeltas"].items():
            add(d["x"], d["values"], self.rod_position(rid, self.t))
        add(s["tempDelta"]["x"], s["tempDelta"]["values"], self.y[ITF])
        return out

    def snapshot(self, include_shape: bool = False) -> dict:
        t, y = self.t, self.y
        snap = {
            "t": t,
            "truth": {
                "power": y[IP], "precursors": y[IC0:IC0 + 6], "reactivity": self.reactivity(t, y),
                "period": self._truth_signal("truth.period", t, y),
                "fuelTemp": y[ITF], "coolantTemp": y[ITC], "iodine": y[II], "xenon": y[IX],
                "energy": y[IEP], "heatRemoved": y[IEH], "peakPower": self.peak_power, "peakTime": self.peak_time,
                "rods": {rid: {"position": self.rod_position(rid, t),
                               "moving": {"move": "out" if m.get("v", 0) > 0 else "in", "fire": "out",
                                          "scram": "in"}.get(m["kind"])}
                         for rid, m in self.motions.items()},
                "mode": self.mode, "pumps": dict(self.pumps),
            },
            "indicated": dict(self.indicated),
            "trips": {"latched": list(self.latched), "active": list(self.active_trips)},
            "tripped": bool(self.latched or self.active_trips),
            "validity": self.validity(),
            "diagnostics": dict(self.diag, events=len(self.events), h=self.h),
        }
        if include_shape:
            snap["truth"]["shape"] = self.shape()
        return snap

    def pins(self) -> dict:
        cfg = dict(self.config)  # always includes "method": the solver is part of what a replay must reproduce
        return {"engineVersion": ENGINE_VERSION, "paramsDigest": self.digest, "config": cfg}

    def checkpoint(self) -> dict:
        return {
            "pins": self.pins(), "seed": self.seed, "init": copy.deepcopy(self.init_spec),
            "stepIndex": self.step_index, "y": list(self.y), "h": self.h, "motions": copy.deepcopy(self.motions),
            "mode": self.mode, "pumps": dict(self.pumps), "latched": list(self.latched),
            "activeTrips": list(self.active_trips), "faults": dict(self.faults), "indicated": dict(self.indicated),
            "rng": format(self.rng.state, "016x"), "extraRho": self.extra_rho,
            "pending": copy.deepcopy(self.pending), "nextSeq": self.next_seq,
            "peak": [self.peak_power, self.peak_time], "halted": self.halted,
            "commandLog": copy.deepcopy(self.command_log), "eventCount": len(self.events),
        }

    @classmethod
    def restore(cls, params: ReactorParams, cp: dict) -> "Engine":
        pins = cp["pins"]
        if pins["engineVersion"] != ENGINE_VERSION:
            raise CheckpointError(f"checkpoint from engine {pins['engineVersion']}, this is {ENGINE_VERSION}")
        if pins["paramsDigest"] != params_digest(params):
            raise CheckpointError("params digest doesn't match the checkpoint")
        e = cls(params, cp["init"], cp["seed"], pins["config"])
        e.step_index, e.y, e.h = cp["stepIndex"], list(cp["y"]), cp["h"]
        e.motions, e.mode, e.pumps = copy.deepcopy(cp["motions"]), cp["mode"], dict(cp["pumps"])
        e.latched, e.active_trips, e.faults = list(cp["latched"]), list(cp["activeTrips"]), dict(cp["faults"])
        e.indicated, e.rng.state, e.extra_rho = dict(cp["indicated"]), int(cp["rng"], 16), cp["extraRho"]
        e.pending, e.next_seq = copy.deepcopy(cp["pending"]), cp["nextSeq"]
        e.peak_power, e.peak_time = cp["peak"]
        e.halted, e.command_log = cp["halted"], copy.deepcopy(cp["commandLog"])
        e.events = [{"type": "restored", "t": e.t, "eventCount": cp["eventCount"]}]
        e.diag = {"steps": 0, "rejected": 0, "rhsCalls": 0}
        return e

    def session(self) -> dict:
        """Everything needed to replay this run from the start."""
        return {"pins": self.pins(), "seed": self.seed, "init": copy.deepcopy(self.init_spec),
                "commands": copy.deepcopy(self.command_log)}

    @classmethod
    def replay(cls, params: ReactorParams, session: dict, until_step: int) -> "Engine":
        pins = session["pins"]
        if pins["engineVersion"] != ENGINE_VERSION or pins["paramsDigest"] != params_digest(params):
            raise CheckpointError("session pins don't match this engine and params")
        e = cls(params, session["init"], session["seed"], pins["config"])
        cmds = sorted(session["commands"], key=lambda c: c["seq"])
        k = 0
        while e.step_index < until_step:
            while k < len(cmds) and cmds[k]["step"] == e.step_index:
                e.submit(cmds[k]["cmd"], cmds[k]["clientId"])
                k += 1
            if e.halted:            # step() makes no progress once halted; the reason is in e.halted (M1 review finding 3)
                return e
            e.step()
        # commands logged at the final boundary are queued again, not applied, so continuing matches the original (finding 5)
        while k < len(cmds) and cmds[k]["step"] == e.step_index:
            e.submit(cmds[k]["cmd"], cmds[k]["clientId"])
            k += 1
        return e
