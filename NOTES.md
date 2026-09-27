# KIRK: notes and next steps

Working notes for whoever picks this up (including cloud sessions, which can't see the virtual-reactor machine's logs). Add dated entries at the bottom.

## Next

1. ~~Plain parameter API~~ (done 2026-09-27, see the Log). `Engine` runs from plain params (`kirk/params.py`, `js/src/sim/params.ts`);
   `kirk.libformat.load_params` / `loadParams` build them from a library folder. Possible follow-ups: a JSON Schema for params (so other languages
   can check them too), and a small CLI that dumps a library's params as JSON.
2. ~~Trip-locator cost~~ (checked 2026-09-27, nothing to fix). The contract fixtures' `rhsCalls` went from 318 to 408 after the in-step crossing search
   (virtual-reactor `41a503c`), which first looked like a +28% steady-state cost. Instrumented over 1000 steady-state steps there is exactly one bisection
   (the `period > 0` leaf of `period-short`, when power turns from slowly falling to slowly rising: a genuine boundary of the trip condition), about 0.06% of the
   right-hand-side calls. Testing period crossings on the inverse period (continuous through the pole) was prototyped and saved almost nothing, so it wasn't kept.
3. **Packaging.** Python: build and install check of `kirk-kinetics` (PyPI `kirk` is taken). npm: emit JS + `.d.ts` (currently `tsc --noEmit` only), package name `kirk-kinetics`.
4. ~~CI~~ (added 2026-09-27, see the Log). `.github/workflows/ci.yml` runs on pushes to main and on pull requests. The required-checks
   ruleset exists but is not enforced while the repository is private on a free plan (decided 2026-09-27, see the Log): check CI by hand before merging.
5. **Codex review of the TS port** (open since virtual-reactor A6-1).
6. **Independence (decided 2026-09-27 by the user).** KIRK is an independent project. virtual-reactor keeps and develops its own engine;
   neither repo depends on the other. Porting a change across is a deliberate choice, not an obligation, so KIRK can change its API freely.

## Log

- 2026-09-27: seeded from virtual-reactor `1534780` (Claude Code). Imports renamed (`physics_ref` → `kirk`, `pipeline.library` → `kirk.libformat`,
  `pipeline.contracts` → `kirk.contracts`). The synthetic core was regenerated (its manifest names the generator module), so its digest and the golden
  vectors' `libraryDigest` pins differ from virtual-reactor's; the vector data are otherwise identical. Vectors and contract fixtures regenerated on Linux
  Python 3.11.15. 69 Python and 77 TypeScript tests pass.
- 2026-09-27: `python -m kirk.libformat.validate` prints a RuntimeWarning because `kirk/__init__` imports the validator before runpy executes it; harmless, fix with a small `kirk/libformat/__main__`-style entry point or a console script.
- 2026-09-27: plain parameter API (NOTES item 1, Claude Code). The engine takes plain, JSON-shaped params (same camelCase keys in Python and
  TypeScript): kinetics, reference, rods, feedback tables, thermal, poisons, plant, and the optional validity and shape sections.
  `check_params` / `checkParams` reject a bad object with the JSON path of the first problem. `Model` compiles params into the tables and sums
  the engine reads, so the hot path and its arithmetic are unchanged. `kirk/library.py` and `js/src/sim/library.ts` are removed.
  `kirk.libformat.load_params` (`js/src/library/adapter.ts` `loadParams`) validates a folder and builds params (wrappers removed, arrays inline).
  Identity: pins now hold `paramsDigest`, a SHA-256 over a canonical encoding of the params (sorted keys, ASCII strings, numbers as float64 bits),
  identical in both languages (TypeScript uses a synchronous SHA-256 so the constructor stays synchronous). An edited copy of params gets a new
  digest automatically, so `mark_modified` / `markModified` are gone. `ENGINE_VERSION` is 0.2.0, so 0.1.0 checkpoints and sessions no longer load.
  The golden vectors were regenerated on Linux Python 3.11.15 only because of the pins (`libraryDigest` → `paramsDigest`, engine version):
  every sample, event and final value is exactly equal to the previous vectors (checked with JSON equality, not within tolerance), and the
  contract fixtures are byte-identical. Params without a validity section report `unvalidated` with `R_PARAMS_UNVALIDATED`.
  79 Python and 101 TypeScript tests pass (new: `tests/test_params.py`, `js/src/sim/params.test.ts`, including a cross-language digest case).
- 2026-09-27: the `python -m kirk.libformat.validate` RuntimeWarning (previous entry) is gone as a side effect: `kirk/__init__` no longer imports
  the validator, and the adapter imports it inside `load_params`. `python -W error -m kirk.libformat.validate libraries/triga-jsi` passes.
- 2026-09-27: params checks shared across languages (review follow-up, Claude Code). `schema/params-vectors/checks.json` holds the one-rod base core,
  optional validity and shape sections, 55 check cases (each with hand-written expected paths, confirmed against Python when authored), three
  digests and a pinned 5 s run. `tests/test_params.py` and `js/src/sim/params.test.ts` both read it, so the two checkers must report the same first
  path, and TypeScript must match the Python run within the golden-vector tolerance (rel 1e-9). The docs now say that params checks cover structure
  only: the library validator's physics conventions (tables zero at the reference point, shape sums) apply only to library folders.
  80 Python and 88 TypeScript tests pass (TypeScript counts fewer because the 15 per-case tests became one test over all 55 shared cases).
- 2026-09-27: merged the plain parameter API into main (bluetyde/kirk#1, merge commit `86a762c`, at the user's request).
- 2026-09-27: CI (NOTES item 4, Claude Code). `.github/workflows/ci.yml` has three jobs. Python: 3.11 with numpy and scipy (so the Radau
  cross-check runs) and 3.13 without them, each running `python -m unittest` and `python -W error -m kirk.libformat.validate libraries/triga-jsi`.
  TypeScript: Node 24 with Python 3.11 for the validator parity test (`npm ci --ignore-scripts`, `npm test`, `npm run typecheck`). Line endings:
  fails on CR bytes in tracked text files. Before pushing, the Python suite passed locally on 3.11.15 (80 tests) and 3.13.12 (80 tests, scipy
  test skipped). Node 24 was not available locally (the container has Node 22), so the first CI run is the first Node 24 run.
- 2026-09-27: merged CI into main (bluetyde/kirk#2, merge commit `27f0558`, at the user's request). The first run passed on all four jobs
  (Python 3.11 + scipy, Python 3.13, TypeScript on Node 24, LF line endings), which was also the first Node 24 run of the TypeScript suite.
- 2026-09-27: required checks (decided by the user). The user created a ruleset for main that requires the four CI jobs. GitHub does not enforce
  rulesets or branch protection on private repositories on a free plan, so for now nothing blocks a merge with red CI: check the PR's checks before
  merging. The ruleset takes effect when the repository becomes public (or the plan changes). If a job in `.github/workflows/ci.yml` is renamed,
  update the ruleset's required check names too, or every merge will wait for a check that never reports.
