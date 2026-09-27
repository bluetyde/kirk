# KIRK: notes and next steps

Working notes for whoever picks this up (including cloud sessions, which can't see the virtual-reactor machine's logs). Add dated entries at the bottom.

## Next

1. **Plain parameter API.** Today `Engine` needs a `Library` loaded from a validated folder. Define engine inputs as plain data (kinetics, feedback tables,
   thermal, rods, plant) so anyone can drive it without the file format; make `kirk.libformat` an adapter that produces those inputs. Keep the golden vectors passing.
2. **Trip-locator cost.** The in-step crossing search (M1 review fix, virtual-reactor `41a503c`) bisects every leaf whose sign changes. At steady state
   the period swings between ±∞, so a period threshold "crosses" every step and costs a wasted bisection: about +28% right-hand-side calls over the first
   10 steps of the synthetic core (318 → 408). Skip crossings through a pole (both ends beyond a large magnitude with opposite signs), and keep test 2
   of `TestM1ReviewRegressions` passing.
3. **Packaging.** Python: build and install check of `kirk-kinetics` (PyPI `kirk` is taken). npm: emit JS + `.d.ts` (currently `tsc --noEmit` only), package name `kirk-kinetics`.
4. **CI.** GitHub Actions: Python 3.11 and 3.13 (`python -m unittest`), Node 24 (`npm ci --ignore-scripts && npm test && npm run typecheck`).
5. **Codex review of the TS port** (open since virtual-reactor A6-1).
6. **Source of truth.** Until virtual-reactor switches to depending on KIRK, engine changes must be made in one place. Proposed: new engine work happens here,
   and virtual-reactor pulls it; decide before the first engine change.

## Log

- 2026-09-27: seeded from virtual-reactor `1534780` (Claude Code). Imports renamed (`physics_ref` → `kirk`, `pipeline.library` → `kirk.libformat`,
  `pipeline.contracts` → `kirk.contracts`). The synthetic core was regenerated (its manifest names the generator module), so its digest and the golden
  vectors' `libraryDigest` pins differ from virtual-reactor's; the vector data are otherwise identical. Vectors and contract fixtures regenerated on Linux
  Python 3.11.15. 69 Python and 77 TypeScript tests pass.
- 2026-09-27: `python -m kirk.libformat.validate` prints a RuntimeWarning because `kirk/__init__` imports the validator before runpy executes it; harmless, fix with a small `kirk/libformat/__main__`-style entry point or a console script.
