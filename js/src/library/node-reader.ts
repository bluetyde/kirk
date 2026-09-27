// Node-only LibraryReader for tests and scripts. Browser code must not import this file.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { LibraryReader } from "./platform.js";

export function nodeReader(folder: string): LibraryReader {
  return {
    async read(relPath) {
      const path = join(folder, relPath);
      try {
        if (!(await stat(path)).isFile()) return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
        throw e;
      }
      return new Uint8Array(await readFile(path));
    },
  };
}
