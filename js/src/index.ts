/**
 * kirk-kinetics: the TypeScript port of the KIRK point-kinetics engine (reference: the Python package kirk).
 *
 * Nothing imported from here uses Node APIs, so it also runs in browsers. For reading library folders
 * from disk in Node, see "kirk-kinetics/node".
 */

export { CheckpointError, Engine, ENGINE_VERSION, InitError, SolverError, type EngineConfig } from "./sim/engine.js";
export {
  CAPABILITY,
  Model,
  ParamsError,
  checkParams,
  paramsDigest,
  type FeedbackParams,
  type KineticsParams,
  type PlantParams,
  type PoisonParams,
  type ReactorParams,
  type ReferenceParams,
  type RodParams,
  type ShapeParams,
  type TableParams,
  type ThermalParams,
  type ValidityParams,
} from "./sim/params.js";
export { LibraryError, libraryDigest, loadParams, paramsFromManifest } from "./library/adapter.js";
export { validateLibrary, type Issue } from "./library/validate.js";
export type { LibraryReader } from "./library/platform.js";
export { jsonForm, validateCommand, validateSnapshot } from "./contracts/validate.js";
export { commandSchema, librarySchema, snapshotSchema } from "./schemas.js";
