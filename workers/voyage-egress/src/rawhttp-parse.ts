// Pure HTTP/1.1 response parsing — no runtime imports, so plain Node tests
// can exercise it without workerd.

export interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function parseResponse(raw: Uint8Array): RawResponse {
  const sep = indexOf(raw, enc.encode('\r\n\r\n'));
  if (sep < 0) throw new Error('malformed HTTP response: no header terminator');
  const headLines = dec.decode(raw.subarray(0, sep)).split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headLines[0] ?? '');
  if (!statusMatch) throw new Error(`malformed status line: ${headLines[0]}`);
  const headers = new Map<string, string>();
  for (const line of headLines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  let body = raw.subarray(sep + 4);
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    body = dechunk(body);
  } else if (headers.has('content-length')) {
    body = body.subarray(0, Number(headers.get('content-length')));
  }
  return { status: Number(statusMatch[1]), headers, body };
}

export function dechunk(data: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let pos = 0;
  for (;;) {
    const lineEnd = indexOf(data, enc.encode('\r\n'), pos);
    if (lineEnd < 0) throw new Error('truncated chunked body: missing size line');
    const size = parseInt(dec.decode(data.subarray(pos, lineEnd)).split(';')[0].trim(), 16);
    if (Number.isNaN(size)) throw new Error('malformed chunk size');
    if (size === 0) break;
    const start = lineEnd + 2;
    if (start + size > data.length) throw new Error('truncated chunked body');
    out.push(data.subarray(start, start + size));
    pos = start + size + 2;
  }
  return concat(out);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
