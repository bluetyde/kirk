# kirk-kinetics (TypeScript)

TypeScript port of the KIRK reference engine (`../kirk/`), plus the library and contract validators. Node 24.

```
npm ci --ignore-scripts
npm test            # vitest run (the parity test runs Python: set VR_PYTHON if `python` isn't on PATH)
npm run typecheck
```

The port must reproduce every golden vector in `../schema/engine-vectors/` within its declared tolerances and give the same `(code, path)` results as the
Python validator on every fixture. Parity rules (JSON equality, code-point string lengths, BOM handling, `Object.hasOwn` lookups, float32 via DataView,
explicit sums) are listed in the virtual-reactor `web/README.md` at the seed commit. The params digest (`src/sim/params.ts`) must give the same
bytes as `kirk/params.py`: keys sorted by code point, strings escaped to ASCII, numbers as float64 bit patterns, `undefined` properties left out.
SHA-256 is synchronous (`src/sim/sha256.ts`) so the `Engine` constructor stays synchronous.
