// A5-0 smoke test: the toolchain supports the pieces A5-1 builds on.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import librarySchema from "../../../schema/library.schema.json";
import { nodeReader } from "./node-reader";
import { sha256Hex } from "./platform";

const vectors = fileURLToPath(new URL("../../../schema/vectors/", import.meta.url));

describe("scaffold", () => {
  it("imports the repo's library schema directly", () => {
    expect(librarySchema.$defs).toBeTypeOf("object");
  });

  it("reads a library through the injected reader; missing files and folders give null", async () => {
    const reader = nodeReader(vectors + "synthetic-core");
    const manifest = await reader.read("manifest.json");
    expect(manifest).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(manifest!)).schemaVersion).toBe("0.1.0");
    expect(await reader.read("no-such-file.f32")).toBeNull();
    expect(await reader.read("no-such-dir/x.f32")).toBeNull();
    expect(await reader.read("arrays")).toBeNull(); // a folder isn't a file
  });

  it("WebCrypto SHA-256 matches node:crypto and every digest in the synthetic manifest", async () => {
    const reader = nodeReader(vectors + "synthetic-core");
    const manifest = JSON.parse(new TextDecoder().decode((await reader.read("manifest.json"))!));
    const arrays = Object.values(manifest.arrays) as { file: string; sha256: string }[];
    expect(arrays.length).toBeGreaterThan(0);
    for (const a of arrays) {
      const bytes = (await reader.read(a.file))!;
      expect(await sha256Hex(bytes)).toBe(a.sha256);
      expect(await sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("JSON.parse rejects NaN like the Python loader (E_JSON)", () => {
    expect(() => JSON.parse('{"x": NaN}')).toThrow(SyntaxError);
  });
});
