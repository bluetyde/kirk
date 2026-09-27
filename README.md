# KIRK: Kernel for Independent Reactor Kinetics

A small, dependency-free point-kinetics engine for reactor simulators, teaching tools and regression testing, in **Python** (the reference) and **TypeScript** (a port that reproduces the same golden vectors).

- **Physics:** six-group point kinetics with an external source; lumped fuel and coolant temperatures with heat removal; table-driven fuel, coolant and xenon feedback; iodine/xenon; rods (drive, scram, pulse fire), instruments with lag, noise and faults, trips located inside solver steps, and interlocks.
- **Solvers:** ROS2 (default) and ROS3P (Lang & Verwer 2001), with adaptive steps.
- **Deterministic:** seeded SplitMix64 noise, explicit left-to-right sums, checkpoints and session replay that reproduce a run exactly.
- **Independent:** Python standard library only; no licensed codes or restricted data; MIT.

## Status

Seeded on 2026-09-27 from [bluetyde/virtual-reactor](https://github.com/bluetyde/virtual-reactor) at commit `1534780` (engine `physics_ref/`, library format and validator, TS port, golden vectors, tests). History before the split lives there. See [NOTES.md](NOTES.md) for what's next.

Validation there: analytic checks (Nordheim–Fuchs within 0.1%, inhour period, prompt jump, xenon peak time), a cross-check against scipy's Radau, and a comparison with measured pulses of the JSI TRIGA Mark II
(peak power within about 5% per core with cited inputs and no calibration, on a reactivity axis derived from the pulse traces).

## Layout

| Path | What |
|---|---|
| `kirk/` | Engine (`engine.py`), library loader (`library.py`), numerics (`numerics.py`), golden-vector generator (`vectors.py`) |
| `kirk/libformat/` | The reactor library format: validator, minimal JSON Schema checker, synthetic test core generator |
| `kirk/contracts/` | Command and snapshot schemas' validator and fixtures |
| `schema/` | JSON Schemas, the synthetic core and invalid fixtures, golden vectors, contract fixtures |
| `docs/library-format.md` | The normative library format (v0.1.0, 28 error codes) |
| `libraries/triga-jsi/` | An example library (experimental) |
| `js/` | TypeScript port (`src/sim`), validators (`src/library`, `src/contracts`), Vitest tests |

## Use

```
python -m unittest                      # all Python tests (about 1.5 min)
python -m kirk.libformat.validate libraries/triga-jsi
cd js && npm ci --ignore-scripts && npm test
```

```python
from kirk import Engine, Library
lib = Library("schema/vectors/synthetic-core")
e = Engine(lib, {"power": {"mode": "source-equilibrium"}})
e.submit({"type": "rod.move", "rod": "regulating", "direction": "out"})
e.advance(10.0)
print(e.snapshot()["truth"]["power"])
```

Regenerate golden vectors (`python -m kirk.vectors`) and fixtures on Linux Python 3.11: other platforms change the last bits of floats, which the tests tolerate but which adds noise to diffs.

## License

MIT. Nothing here is copied from copyleft or unlicensed projects (PyRK, openpointkinetics and others were used for reference only).
