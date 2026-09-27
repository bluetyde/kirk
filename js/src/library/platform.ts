/**
 * What the library validator and loader need from their host, so the same code runs in the
 * browser (fetch or File API) and in Node tests (node:fs). Nothing here imports node:*.
 */

/** Reads files from one library folder, by the relative paths the manifest uses. */
export interface LibraryReader {
  /** The file's bytes, or null when there is no regular file at `relPath` (Python: not is_file()). */
  read(relPath: string): Promise<Uint8Array | null>;
}

/** Lowercase hex SHA-256, via WebCrypto (browsers and Node >= 19 both have globalThis.crypto). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
