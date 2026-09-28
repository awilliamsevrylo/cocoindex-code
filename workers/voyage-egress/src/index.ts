// voyage-egress Worker: routes embedding requests to per-key Durable Objects.
// POC 1 surface: GET /probe?slot=NN — egress witness + one real embedding.
// The VoyageSlot class lives in the separate "voyage-slot" script; this
// router only holds a script_name binding to it (one DO class per script).
import type { Env } from './slot';

export function slotName(slot: number): string {
  return `voyage-key-${String(slot).padStart(2, '0')}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authorized(req: Request, env: Env): boolean {
  const got = req.headers.get('authorization') ?? '';
  return env.WORKER_TOKEN.length >= 32 && got === `Bearer ${env.WORKER_TOKEN}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

    if (url.pathname === '/probe') {
      const slot = Number(url.searchParams.get('slot') ?? '0');
      const stub = env.VOYAGE_SLOT.get(env.VOYAGE_SLOT.idFromName(slotName(slot)));
      const egress_ip = await stub.egressIp();
      const r = await stub.embed(slot, ['android permission overview'], 'voyage-4-lite', 'query');
      return json({
        slot: slotName(slot),
        egress_ip,
        status: r.status,
        dims: r.vectors?.[0]?.length ?? 0,
        usage_tokens: r.usage_tokens ?? null,
        error: r.error ?? null,
      });
    }
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;
