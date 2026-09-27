# KIRK: notes and next steps

Working notes for whoever picks this up (including cloud sessions, which can't see the virtual-reactor machine's logs). Add dated entries at the bottom.

## Next

1. **Plain parameter API.** Today `Engine` needs a `Library` loaded from a validated folder. Define engine inputs as plain data (kinetics, feedback tables,
   thermal, rods, plant) so anyone can drive it without the file format; make `kirk.libformat` an adapter that produces those inputs. Keep the golden vectors passing.
2. ~~Trip-locator cost~~ (checked 2026-09-27, nothing to fix). The contract fixtures' `rhsCalls` went from 318 to 408 after the in-step crossing search
   (virtual-reactor `41a503c`), which first looked like a +28% steady-state cost. Instrumented over 1000 steady-state steps there is exactly one bisection
   (the `period > 0` leaf of `period-short`, when power turns from slowly falling to slowly rising: a genuine boundary of the trip condition), about 0.06% of the
   right-hand-side calls. Testing period crossings on the inverse period (continuous through the pole) was prototyped and saved almost nothing, so it wasn't kept.
3. **Packaging.** Python: build and install check of `kirk-kinetics` (PyPI `kirk` is taken). npm: emit JS + `.d.ts` (currently `tsc --noEmit` only), package name `kirk-kinetics`.
4. **CI.** GitHub Actions: Python 3.11 and 3.13 (`python -m unittest`), Node 24 (`npm ci --ignore-scripts && npm test && npm run typecheck`).
5. **Codex review of the TS port** (open since virtual-reactor A6-1).
6. **Independence (decided 2026-09-27 by the user).** KIRK is an independent project. virtual-reactor keeps and develops its own engine;
   neither repo depends on the other. Porting a change across is a deliberate choice, not an obligation, so KIRK can change its API freely.

## Log

- 2026-09-27: seeded from virtual-reactor `1534780` (Claude Code). Imports renamed (`physics_ref` → `kirk`, `pipeline.library` → `kirk.libformat`,
  `pipeline.contracts` → `kirk.contracts`). The synthetic core was regenerated (its manifest names the generator module), so its digest and the golden
  vectors' `libraryDigest` pins differ from virtual-reactor's; the vector data are otherwise identical. Vectors and contract fixtures regenerated on Linux
  Python 3.11.15. 69 Python and 77 TypeScript tests pass.
- 2026-09-27: `python -m kirk.libformat.validate` prints a RuntimeWarning because `kirk/__init__` imports the validator before runpy executes it; harmless, fix with a small `kirk/libformat/__main__`-style entry point or a console script.
