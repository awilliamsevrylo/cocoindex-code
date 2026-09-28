/**
 * WebCrypto-based SHA-256 and chunk ID computation.
 * Runs identically in Node.js (v18+) and Cloudflare Workers runtime.
 */

export async function sha256hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    hex += hashArray[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Computes chunk ID:
 * id = sha256hex(path + "\n" + start_line + "\n" + end_line + "\n" + sha256hex(text))
 * Output is 64 lowercase hex characters.
 */
export async function computeChunkId(
  path: string,
  start_line: number,
  end_line: number,
  text: string
): Promise<string> {
  const contentHash = await sha256hex(text);
  const payload = `${path}\n${start_line}\n${end_line}\n${contentHash}`;
  return sha256hex(payload);
}
