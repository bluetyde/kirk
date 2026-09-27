# Reactor library format, v0.1.0 (normative)

This document and [`schema/library.schema.json`](../schema/library.schema.json) are the **only normative definition** of a reactor library.
The schema checks structure. This document defines meaning and the semantic checks the schema can't express.
Plans and code link here instead of restating fields. Design background: [plans/03](plans/03-library-format.md).

Status: **draft 0.1.0**, 2026-09-25. During 0.x, a runtime accepts only versions it explicitly lists (currently `0.1.0`).

## 1. Container

A library is a folder (or the same folder zipped, extension `.vrlib`):

```
<id>/
  manifest.json      required; UTF-8 JSON
  arrays/*.f32       binary arrays referenced by the manifest
  README.md          optional human description
```

- Every path in the manifest is **relative**, uses `/`, and must stay inside the library folder (no `..`, no absolute paths, no drive letters).
- Zipped libraries: at most 64 MiB uncompressed, and at most 256 entries (limits may rise in later versions).

## 2. Units

| Quantity | Unit | Notes |
|---|---|---|
| Time | s | |
| Power | W | |
| Neutron source (scaled) | W/s | `S` in the point-kinetics equation |
| Reactivity | Δk/k (absolute) | pcm and dollars are display units only |
| Temperature | K | |
| Mass | kg | |
| Heat capacity | J/(kg·K) | |
| Heat transfer | W/K | `hA`, `UA` |
| Number density | atoms/m³ | |
| Microscopic cross section | m² | 1 barn = 1e-28 m² |
| Macroscopic cross section | 1/m | |
| Flux | n/(m²·s) | |
| **Geometry lengths, volumes** | **cm, cm³** | Boundary exception: matches OpenMC and the renderer |
| Rod position | fraction withdrawn | 0 = fully inserted, 1 = fully withdrawn |

## 3. Provenance of values

Every scalar quantity is an object `{ "value": number, "unc"?: number, "source": Source }`.
Every table carries one `source` for the whole table. `Source` is one of:

| Source | Meaning |
|---|---|
| `"transport"` | Computed by the library's transport pipeline |
| `"cited:<id>"` | Taken from the publication with that id in `provenance.sources` |
| `"assumed"` | A modelling assumption with no source; the UI shows it as assumed |
| `"calibration"` | Adjusted to match measurements; the original value is kept elsewhere |
| `"synthetic"` | Invented; allowed only when `status` is `"synthetic"` |

`unc` is one standard deviation of **transport sampling uncertainty only**, unless a field says otherwise.

## 4. Top-level fields

| Field | Meaning |
|---|---|
| `schemaVersion` | `"0.1.0"` |
| `id` | Lowercase slug, also the folder name |
| `name` | Human-readable name |
| `status` | `"synthetic"`, `"experimental"` or `"validated-for-domain"` (see plan 07) |
| `capabilities` | Required model capabilities. v0 defines only `"point-kinetics/lumped-thermal-v1"` |
| `provenance` | Generator, codes, data, dates and a list of cited `sources` `{id, cite}` |
| `reference` | The reference state (section 5) |
| `kinetics`, `reactivity`, `thermal`, `poisons` | Physics inputs (sections 6–8) |
| `plant` | Modes, instruments, trips, interlocks (section 9) |
| `shapes`, `arrays` | Power shapes and binary array descriptors (sections 10–11) |
| `geometry` | Render geometry (section 12) |
| `domain` | Where the data was computed and checked (section 13) |

## 5. Reference state and reactivity

`reference` defines **one** state: every rod's position, `Tfuel`, `Tcoolant`, `xenon`, and `rho`, the reactivity at that state.

- `reference.rho.source` is `"transport"` for real libraries: the transport result, **not** a value forced to zero.
- `reference.calibration` is `null`, or `{ "deltaRho": number, "reason": string }`. It's always shown in the UI and never merged into `rho`.
- Total reactivity at runtime is

  `ρ = reference.rho + calibration.deltaRho + Σ_r rodWorth_r(x_r) + fuelTemp(T_f) + coolantTemp(T_c) + xenon(N)`

- **Every table is a delta from the reference** and must be **zero at the reference point**: within 1e-9 absolute for JSON tables and 1e-6 for float32 arrays (`E_REF_NONZERO`).
  The reference point must lie inside each table's axis range.
- Adding the rod tables assumes the rods act independently. That approximation is valid only where `domain.jointChecked` says it was checked (section 13).

## 6. Kinetics (`kinetics`)

| Field | Content |
|---|---|
| `beta` | `{ values: [6], unc?: [6], source }`: effective delayed fractions β_i |
| `lambda` | `{ values: [6], source }`: decay constants λ_i, 1/s, strictly positive |
| `genTime` | Scalar Λ, s |
| `extSource` | Scalar S, W/s (scaled neutron source; may be 0) |

Initialization rules that follow from these equations are in [plans/01](plans/01-physics-core.md#initialization-must-be-explicit):
critical equilibrium needs S = 0, and a source-driven equilibrium needs ρ < 0.

## 7. Reactivity tables (`reactivity`)

A **table** is `{ "<axis>": [...], "rho": [...], "unc"?: [...], "interp": Interp, "outOfRange": Range, "source": Source }`.
Axis values are strictly increasing (`E_TABLE_NOT_MONOTONIC`), and all arrays have equal length ≥ 2 (`E_TABLE_LENGTH`).

- `Interp`: `"linear"` (monotone splines are reserved for a later version).
- `Range`: `"clamp-and-flag"` (hold the end value and set the validity status), `"extrapolate-and-flag"` (linear from the last segment) or `"reject"` (the engine refuses the state).

| Field | Axis | Content |
|---|---|---|
| `rods[]` | `x` (fraction withdrawn) | `{ id, name, travelCm, speed (fraction/s), pulseCapable, worth: table, scram: { t: [...s], x: [...] }, fireTime? (s, pulse-capable rods only) }` |
| `fuelTemp` | `T` (K) | ρ change from the reference fuel temperature |
| `coolantTemp` | `T` (K) | ρ change from the reference coolant temperature |
| `xenon` | `N` (atoms/m³) | ρ change from the reference xenon density |

Rod ids are unique (`E_DUPLICATE_ID`), and `reference.rods` has exactly the same ids (`E_ROD_UNKNOWN`).
Scram `t` starts at 0 and is strictly increasing (`E_TABLE_NOT_MONOTONIC`). Scram `x` values are in [0, 1], never increase, and end at 0 (`E_SCRAM_PROFILE`).
Pulse-capable rods must have `fireTime`, and only they may have it (`E_SCHEMA`).

## 8. Thermal and poisons

`thermal`:
- `fuel`: `{ mass: scalar, cp: table over T with value column "c" }`
- `coolant`: `{ mass: scalar, cp: scalar }`
- `hA`: scalar, fuel-to-coolant, W/K
- `heatExchanger`: `{ UA: scalar (W/K), sinkTemp: scalar (K), pump: pump id (E_PUMP_UNKNOWN) }`. Removal is `UA·(T_c − sinkTemp)` while that pump runs, else 0.
- `deposition`: `{ fuelFraction: scalar }`, the fraction of P deposited in fuel; the rest goes to the coolant. There's no decay-heat inventory in this capability.

`poisons`: `fluxPerWatt` (n/(m²·s) per W), `sigmaF` (core-average macroscopic fission, 1/m), `gammaI`, `gammaXe`, `lambdaI`, `lambdaXe` (1/s), `sigmaXe` (microscopic, m²). All scalars.

## 9. Plant (`plant`)

- `modes`: operating modes, e.g. `["steady", "pulse"]`; `initialMode` is one of them.
- `pumps`: `[{ id }]`.
- `instruments`: `[{ id, signal, scale: "linear"|"log", range: [lo, hi], lag (s, first-order), noise (relative 1σ) }]`.
- `trips`: `[{ id, input, predicate, modes?, latching }]`.
  `input` names the channel the trip watches: a truth signal for an ideal modeled quantity, or an indicated signal for an instrument channel.
  `latching: true` means the trip stays until an explicit reset while the reactor is shut down.
- `interlocks`: `[{ id, when: predicate, blocks: [commandType, ...], reason }]`. While `when` is true, the listed command types are rejected with `reason`.

**Signals** are always written with a prefix:
- `truth.<name>`, where name is `power`, `period`, `fuelTemp`, `coolantTemp`, `xenon`, `mode` or `rod.<rodId>`
- `indicated.<instrumentId>`, an instrument's reading

An instrument's `signal` must be a truth signal. An unknown signal anywhere is an error (`E_SIGNAL_UNKNOWN`).
String values are allowed only with `eq`/`ne`, and `truth.mode` only supports `eq`/`ne` (`E_PREDICATE_TYPE`).
`initialMode` and every trip `modes` entry must be in `modes` (`E_MODE_UNKNOWN`).

**Predicates** (typed, no free text):

```
Predicate = { "signal": Signal, "op": "gt"|"ge"|"lt"|"le"|"absGt"|"eq"|"ne", "value": number|string }
          | { "signal": Signal, "op": "between", "value": [lo, hi] }
          | { "all": [Predicate, ...] } | { "any": [Predicate, ...] } | { "not": Predicate }
```

In a trip, a predicate's `signal` may be omitted, and it then means the trip's `input`. Interlock predicates must name their signals.

## 10. Shapes (`shapes`)

- `bins.elements`: element ids (unique, `E_DUPLICATE_ID`). `bins.axialEdgesCm`: strictly increasing, giving A = length − 1 axial bins.
  Arrays of per-bin values have dimensions `[E, A]`, element-major.
- `basis`: `"heating"` or `"fission"`, one per library.
- `normalization`: `"fraction-of-total-power"`. **Each entry is a dimensionless fraction of total power P.**
  Bin power is `P × fraction` (W). **Power density** is bin power ÷ bin volume (`volumes` array, cm³).
- `form`: `"separable"`. The shape at a state is

  `shape = base + Σ_r rodDelta_r(x_r) + tempDelta(T_f)`

  where each delta is linearly interpolated between its grid points.
- `base`: array name, dimensions `[E, A]`, entries sum to 1 within 1e-5 (`E_SHAPE_NORMALIZATION`). `baseUnc` (optional): relative uncertainty, same dimensions.
- `rodDeltas.<rodId>`: `{ x: [...], array }`, dimensions `[len(x), E, A]`. `tempDelta`: `{ T: [...], array }`, dimensions `[len(T), E, A]`.
  Each delta slice sums to 0 within 1e-5 (`E_DELTA_SUM`), is zero at the reference point (`E_REF_NONZERO`), and has grid values that are strictly increasing.
- **Reconstruction check:** for each rod-grid point alone and each temperature-grid point alone (others at reference),
  every entry of the reconstructed shape must be ≥ −1e-6 (`E_SHAPE_NEGATIVE`). Negative values are a failed approximation. They're reported, never clipped.
- `volumes`: array name, dimensions `[E, A]`, entries > 0.

## 11. Binary arrays (`arrays`)

`arrays` maps a name to a descriptor:

```json
{ "file": "arrays/base.f32", "dtype": "float32", "byteOrder": "little", "shape": [15, 10],
  "order": "C", "offset": 0, "byteLength": 600, "sha256": "<64 hex>" }
```

Checks:
- `file` exists (`E_FILE_MISSING`) and is contained (`E_PATH_UNSAFE`).
- `byteLength` equals 4 × the product of `shape`, and `offset + byteLength` ≤ the file size (`E_OFFSET_BOUNDS`).
- `sha256` matches the whole file (`E_DIGEST_MISMATCH`).
- Every value is finite (`E_NONFINITE`).
- Dimensions match their use (`E_SHAPE_DIMS`), and every array name referenced exists (`E_ARRAY_UNKNOWN`).

## 12. Geometry (`geometry`)

`{ units: "cm", up: "z", primitives: [...] }`. A primitive is:

- `{ "type": "cylinder", "center": [x,y,z], "radius", "height", "material" }` (axis along z)
- `{ "type": "annulus", "center", "rInner", "radius", "height", "material" }`
- `{ "type": "box", "center", "size": [dx,dy,dz], "material" }`

Optional: `element` (a `shapes.bins.elements` id; `E_GEOMETRY_ID` if unknown), and `rod` (a rod id; the primitive moves up by `x × travelCm`).
`material` is a free tag (`fuel`, `clad`, `graphite`, `water`, `b4c`, `steel`, `aluminum`, `void`, …). Styling belongs to the viewer.
Every shape element must have at least one primitive (`E_GEOMETRY_ID`).

## 13. Domain (`domain`)

- `rods`: `{ <rodId>: [lo, hi] }`, `Tfuel`, `Tcoolant`, `xenon`: `[lo, hi]`. This is where the tables have data.
- `jointChecked`: `[{ rods: {<id>: x}, Tfuel?, maxShapeErr, rhoErr }]`, the joint states where superposition was actually tested against full transport runs. It may be empty.

Runtime validity status: `outOfDomain` if any axis leaves `domain`, `unvalidated` if the state is inside the domain but no joint check covers the combination (or `status` isn't `validated-for-domain`), otherwise `supported`.
Reason codes (`R_*`) are defined with the engine, not in this format.

## 14. Error codes

| Code | Meaning |
|---|---|
| `E_JSON` | Manifest is missing or isn't valid JSON |
| `E_SCHEMA` | Fails the JSON Schema (message gives the path) |
| `E_VERSION_UNSUPPORTED` | `schemaVersion` isn't in the supported list |
| `E_CAPABILITY_UNSUPPORTED` | A required capability isn't implemented |
| `E_SOURCE_SYNTHETIC` | `"synthetic"` source used when `status` isn't `"synthetic"` |
| `E_TABLE_LENGTH` | Table columns have unequal lengths, or fewer than 2 points |
| `E_TABLE_NOT_MONOTONIC` | A table axis or scram time isn't strictly increasing |
| `E_REF_NONZERO` | A table or delta isn't zero at the reference point |
| `E_DUPLICATE_ID` | Duplicate rod, element, instrument, trip, interlock or pump id |
| `E_ROD_UNKNOWN` | Reference, domain or shape rods don't match the rod list |
| `E_SIGNAL_UNKNOWN` | A predicate, trip input or instrument uses an unknown signal |
| `E_PREDICATE_TYPE` | A predicate's operator doesn't fit its value or signal |
| `E_MODE_UNKNOWN` | `initialMode` or a trip mode isn't in `modes` |
| `E_PUMP_UNKNOWN` | The heat exchanger names an unknown pump |
| `E_SCRAM_PROFILE` | Scram positions are outside [0, 1], increase anywhere, or don't end at 0 |
| `E_PATH_UNSAFE` | A path is absolute or escapes the library |
| `E_FILE_MISSING` | A referenced file doesn't exist |
| `E_OFFSET_BOUNDS` | Byte length or offset is inconsistent with the shape or file size |
| `E_DIGEST_MISMATCH` | SHA-256 doesn't match |
| `E_NONFINITE` | An array contains NaN or infinity |
| `E_ARRAY_UNKNOWN` | A referenced array name isn't in `arrays` |
| `E_SHAPE_DIMS` | An array's dimensions don't match its use |
| `E_SHAPE_NORMALIZATION` | The base shape doesn't sum to 1 |
| `E_DELTA_SUM` | A delta slice doesn't sum to 0 |
| `E_SHAPE_NEGATIVE` | A reconstructed shape has negative entries |
| `E_VOLUME_NONPOSITIVE` | A bin volume is ≤ 0 |
| `E_GEOMETRY_ID` | Geometry names an unknown element or rod, or a shape element has no geometry |

Validators in every language report `{ code, path, message }` and must give the same codes for the fixtures in `schema/vectors/`.
