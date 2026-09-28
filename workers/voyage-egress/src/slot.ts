// VoyageSlot: one Durable Object per Voyage key. The DO name ("voyage-key-NN")
// pins the key to one DO instance, and connect() egress is sticky per DO, so
// each key keeps one stable outbound IP. All Voyage traffic for a key goes
// through its slot; nothing here ever returns or logs the key itself.
import { DurableObject } from 'cloudflare:workers';
import { rawRequest } from './rawhttp';

// Secrets live on the script that reads them: VOYAGE_KEYS on voyage-slot
// (read inside the DO), WORKER_TOKEN on voyage-egress (read by the router).
export interface SlotEnv {
  VOYAGE_KEYS: string; // secret: one "pa-..." key per line, slot = line index
}

export interface Env {
  VOYAGE_SLOT: DurableObjectNamespace<VoyageSlot>;
  WORKER_TOKEN: string; // secret: bearer callers must present
}

const VOYAGE_HOST = 'api.voyageai.com';
const CHECKIP_HOST = 'checkip.amazonaws.com';

export interface EmbedResult {
  status: number;
  vectors?: number[][];
  usage_tokens?: number;
  error?: string;
  retry_after_ms?: number;
}

export function keyForSlot(keys: string, slot: number): string | undefined {
  const list = keys
    .split('\n')
    .map((l) => l.split('#')[0].trim())
    .filter((l) => l.startsWith('pa-'));
  return list[slot];
}

export function slotCount(keys: string): number {
  return keys.split('\n').filter((l) => l.split('#')[0].trim().startsWith('pa-')).length;
}

export class VoyageSlot extends DurableObject<SlotEnv> {
  // Small JSON store. Only the reserved placement instance uses it; key
  // slots never store anything, so no key material ever touches storage.
  async getJson<T>(key: string): Promise<T | null> {
    return (await this.ctx.storage.get<T>(key)) ?? null;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }

  async keyCount(): Promise<number> {
    return slotCount(this.env.VOYAGE_KEYS);
  }

  // Egress witness: non-Cloudflare echo host over the same connect() path the
  // Voyage calls use. ipify/ifconfig.me are Cloudflare-fronted and misreport.
  async egressIp(): Promise<string> {
    const res = await rawRequest({
      host: CHECKIP_HOST,
      port: 80,
      tls: false,
      method: 'GET',
      path: '/',
      timeoutMs: 15_000,
    });
    return new TextDecoder().decode(res.body).trim();
  }

  async embed(
    slot: number,
    input: string[],
    model: string,
    inputType: 'document' | 'query' | null,
  ): Promise<EmbedResult> {
    const key = keyForSlot(this.env.VOYAGE_KEYS, slot);
    if (!key) return { status: 500, error: `no key for slot ${slot}` };
    const payload: Record<string, unknown> = { model, input };
    if (inputType) payload.input_type = inputType;
    const res = await rawRequest({
      host: VOYAGE_HOST,
      port: 443,
      tls: true,
      method: 'POST',
      path: '/v1/embeddings',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeoutMs: 120_000,
    });
    const text = new TextDecoder().decode(res.body);
    if (res.status !== 200) {
      const ra = Number(res.headers.get('retry-after'));
      return {
        status: res.status,
        error: text.slice(0, 500),
        retry_after_ms: Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined,
      };
    }
    const json = JSON.parse(text) as {
      data: { index: number; embedding: number[] }[];
      usage?: { total_tokens?: number };
    };
    const vectors = json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { status: 200, vectors, usage_tokens: json.usage?.total_tokens };
  }
}
