import { describe, expect, it } from "vitest";
// @ts-expect-error: plain .mjs build script without type declarations
import { render } from "../scripts/gen-schemas.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("generated schemas", () => {
  it("src/schemas.ts matches kirk/schemas (run `npm run gen:schemas` after changing a schema)", () => {
    const current = readFileSync(fileURLToPath(new URL("./schemas.ts", import.meta.url)), "utf-8");
    expect(current).toBe(render());
  });
});
