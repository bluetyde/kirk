/**
 * Build engine params (../sim/params) from a validated library folder.
 *
 * Ported from kirk/libformat/adapter.py. The library format carries provenance ({value, source}
 * wrappers), binary arrays and validation metadata; loadParams() validates the folder, then keeps
 * only what the engine reads: wrappers are removed and shape arrays are loaded inline.
 */

import { CAPABILITY, type ReactorParams, type TableParams } from "../sim/params.js";
import type { LibraryReader } from "./platform.js";
import { sha256Hex } from "./platform.js";
import type { Issue } from "./validate.js";
import { validateLibrary } from "./validate.js";

export class LibraryError extends Error {
  issues: Issue[];

  constructor(issues: Issue[]) {
    const summary = issues.slice(0, 5).map((i) => `${i.code} ${i.path}`).join("; ");
    super(summary);
    this.name = "LibraryError";
    this.issues = issues;
  }
}

async function readManifest(reader: LibraryReader): Promise<[Uint8Array, any]> {
  const raw = await reader.read("manifest.json");
  if (raw === null) {
    throw new Error("manifest.json not found");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  return [raw, JSON.parse(text)];
}

/**
 * SHA-256 over the manifest bytes and each array's sha256 in name order: the folder's identity.
 * Engine pins use the params digest instead (paramsDigest in ../sim/params).
 */
export async function libraryDigest(reader: LibraryReader): Promise<string> {
  const [raw, m] = await readManifest(reader);
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [raw];
  for (const name of Object.keys(m.arrays).sort()) {
    chunks.push(encoder.encode(m.arrays[name].sha256));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    concat.set(c, offset);
    offset += c.length;
  }
  return await sha256Hex(concat);
}

function table(t: any, axis: string, value: string): TableParams {
  return { x: [...t[axis]], y: [...t[value]], outOfRange: t.outOfRange };
}

/** Params from a parsed manifest and its loaded arrays (the folder must already be valid). */
export function paramsFromManifest(m: any, arrays: Record<string, number[]>): ReactorParams {
  if (!m.capabilities.includes(CAPABILITY)) {
    throw new Error(`library doesn't declare ${CAPABILITY}`);
  }
  const ref = m.reference;
  const k = m.kinetics;
  const r = m.reactivity;
  const t = m.thermal;
  const po = m.poisons;
  const pl = m.plant;
  const dom = m.domain;
  const sh = m.shapes;
  const rods = r.rods.map((d: any) => {
    const rod: any = {
      id: d.id,
      name: d.name,
      travelCm: d.travelCm,
      speed: d.speed,
      pulseCapable: d.pulseCapable,
      worth: table(d.worth, "x", "rho"),
      scram: { t: [...d.scram.t], x: [...d.scram.x] },
    };
    if (Object.hasOwn(d, "fireTime")) {
      rod.fireTime = d.fireTime;
    }
    return rod;
  });
  const rodDeltas: Record<string, { x: number[]; values: number[] }> = {};
  for (const [rid, d] of Object.entries<any>(sh.rodDeltas)) {
    rodDeltas[rid] = { x: [...d.x], values: arrays[d.array]! };
  }
  const domRods: Record<string, number[]> = {};
  for (const [rid, v] of Object.entries<any>(dom.rods)) {
    domRods[rid] = [...v];
  }
  const poisons: any = {};
  for (const key of ["fluxPerWatt", "sigmaF", "gammaI", "gammaXe", "lambdaI", "lambdaXe", "sigmaXe"]) {
    poisons[key] = po[key].value;
  }
  return {
    id: m.id,
    kinetics: {
      beta: [...k.beta.values],
      lambda: [...k.lambda.values],
      genTime: k.genTime.value,
      extSource: k.extSource.value,
    },
    reference: {
      rods: { ...ref.rods },
      Tfuel: ref.Tfuel.value,
      Tcoolant: ref.Tcoolant.value,
      rho: ref.rho.value,
      calibration: ref.calibration ? ref.calibration.deltaRho : 0.0,
    },
    rods,
    feedback: {
      fuelTemp: table(r.fuelTemp, "T", "rho"),
      coolantTemp: table(r.coolantTemp, "T", "rho"),
      xenon: table(r.xenon, "N", "rho"),
    },
    thermal: {
      fuelMass: t.fuel.mass.value,
      fuelCp: table(t.fuel.cp, "T", "c"),
      coolantMass: t.coolant.mass.value,
      coolantCp: t.coolant.cp.value,
      hA: t.hA.value,
      UA: t.heatExchanger.UA.value,
      sinkTemp: t.heatExchanger.sinkTemp.value,
      hxPump: t.heatExchanger.pump,
      fuelFraction: t.deposition.fuelFraction.value,
    },
    poisons,
    plant: {
      modes: [...pl.modes],
      initialMode: pl.initialMode,
      pumps: pl.pumps.map((x: any) => x.id),
      instruments: pl.instruments.map((i: any) => ({ ...i })),
      trips: pl.trips.map((tr: any) => ({ ...tr })),
      interlocks: pl.interlocks.map((i: any) => ({ ...i })),
    },
    validity: {
      status: m.status,
      rods: domRods,
      Tfuel: [...dom.Tfuel],
      Tcoolant: [...dom.Tcoolant],
      xenon: [...dom.xenon],
      jointChecked: dom.jointChecked.map((jc: any) => ({ rods: { ...jc.rods } })),
    },
    shape: {
      elements: [...sh.bins.elements],
      axialEdgesCm: [...sh.bins.axialEdgesCm],
      base: arrays[sh.base]!,
      rodDeltas,
      tempDelta: { x: [...sh.tempDelta.T], values: arrays[sh.tempDelta.array]! },
    },
  };
}

/** Validate a library folder and return engine params. Throws LibraryError on any validation issue. */
export async function loadParams(reader: LibraryReader): Promise<ReactorParams> {
  const issues = await validateLibrary(reader);
  if (issues.length > 0) {
    throw new LibraryError(issues);
  }
  const [, m] = await readManifest(reader);
  const arrays: Record<string, number[]> = {};
  for (const [name, d] of Object.entries<any>(m.arrays)) {
    const data = await reader.read(d.file);
    if (data === null) {
      throw new Error(`Array file ${d.file} not found`);
    }
    const n = Math.floor(d.byteLength / 4);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const arr = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      arr[i] = view.getFloat32(d.offset + 4 * i, true);
    }
    arrays[name] = arr;
  }
  return paramsFromManifest(m, arrays);
}
