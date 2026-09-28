// POST /v1/rerank: same bearer gate as embeddings (checked in index.ts),
// one slot via the shared SlotScheduler shape, body relayed unchanged to
// Voyage /v1/rerank. Path allowlist lives here so the node unit test can
// import it without the cloudflare:workers runtime.
import type { Env } from './slot';
import type { SlotHome } from './placement';
import { NoHealthySlot, SlotScheduler } from './scheduler.ts';

// Exactly two upstream paths. Default keeps embeddings byte-identical.
export const ALLOWED_UPSTREAM_PATHS = ['/v1/embeddings', '/v1/rerank'] as const;

export function resolveUpstreamPath(path?: string): string | null {
  const p = path ?? '/v1/embeddings';
  return (ALLOWED_UPSTREAM_PATHS as readonly string[]).includes(p) ? p : null;
}

const cooldownUntil = new Map<number, number>();
const scheduler = new SlotScheduler(2);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleRerank(req: Request, env: Env, homes: SlotHome[] | null): Promise<Response> {
  if (!homes || homes.length === 0) return json({ error: 'not_placed: POST /place first' }, 503);
  let body: { query?: unknown; documents?: unknown; model?: unknown; top_k?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  if (typeof body.query !== 'string' || body.query.length === 0) return json({ error: 'query required' }, 400);
  if (!Array.isArray(body.documents) || body.documents.length === 0 || !body.documents.every((d) => typeof d === 'string')) {
    return json({ error: 'documents must be a non-empty string[]' }, 400);
  }
  if (typeof body.model !== 'string' || body.model.length === 0) return json({ error: 'model required' }, 400);

  // Forward {query, documents, model, top_k} unchanged.
  const payload: Record<string, unknown> = {
    query: body.query,
    documents: body.documents,
    model: body.model,
  };
  if (body.top_k !== undefined) payload.top_k = body.top_k;

  const bySlot = new Map(homes.map((h) => [h.slot, h.name]));
  const slots = homes.map((h) => h.slot);
  try {
    const slot = await scheduler.acquire(slots, cooldownUntil, Date.now);
    let r: { status: number; body: string; retry_after_ms?: number };
    try {
      const stub = env.VOYAGE_SLOT.get(env.VOYAGE_SLOT.idFromName(bySlot.get(slot)!));
      r = await stub.forward(slot, '/v1/rerank', JSON.stringify(payload));
    } finally {
      scheduler.release(slot);
    }
    if (r.status === 429 || r.status >= 500) {
      cooldownUntil.set(slot, Date.now() + (r.retry_after_ms ?? 30_000));
    }
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof NoHealthySlot) return json({ error: 'no_healthy_slot' }, 503);
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 502);
  }
}
