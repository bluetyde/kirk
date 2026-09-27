// Type-checked against the installed package's .d.ts files by CI's packaging job (not part of the build).
import { Engine, checkParams, loadParams, type ReactorParams } from "kirk-kinetics";
import { nodeReader } from "kirk-kinetics/node";

export async function run(folder: string): Promise<number> {
  const params: ReactorParams = await loadParams(nodeReader(folder));
  checkParams(params);
  const e = new Engine(params, { power: { mode: "source-equilibrium" } });
  e.advance(1.0);
  return e.snapshot().truth.power as number;
}
