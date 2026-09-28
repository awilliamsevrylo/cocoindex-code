// Minimal HTTP/1.1 over a Workers TCP socket (cloudflare:sockets).
// Why not fetch(): fetch() egress is one shared Cloudflare IP for every
// Durable Object; connect() egress is distinct per DO instance and sticky
// per DO name (measured 2026-09-15). The whole point of this Worker is one
// Voyage key per egress IP, so every outbound call goes through connect().
import { connect } from 'cloudflare:sockets';
import { concat, parseResponse, type RawResponse } from './rawhttp-parse';

export type { RawResponse };

export interface RawRequest {
  host: string;
  port: number;
  tls: boolean;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const enc = new TextEncoder();

export async function rawRequest(req: RawRequest): Promise<RawResponse> {
  const socket = connect(
    { hostname: req.host, port: req.port },
    { secureTransport: req.tls ? 'on' : 'off', allowHalfOpen: false },
  );
  const bodyBytes = req.body === undefined ? undefined : enc.encode(req.body);
  const lines = [`${req.method} ${req.path} HTTP/1.1`, `Host: ${req.host}`, 'Connection: close'];
  for (const [k, v] of Object.entries(req.headers ?? {})) lines.push(`${k}: ${v}`);
  if (bodyBytes) lines.push(`Content-Length: ${bodyBytes.length}`);
  const head = enc.encode(lines.join('\r\n') + '\r\n\r\n');

  const writer = socket.writable.getWriter();
  await writer.write(bodyBytes ? concat([head, bodyBytes]) : head);
  writer.releaseLock();

  const timeoutMs = req.timeoutMs ?? 60_000;
  const raw = await withTimeout(readAll(socket.readable), timeoutMs, `${req.host} read`);
  await socket.close().catch(() => {});
  return parseResponse(raw);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return concat(parts);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${what}`)), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}
