// voyage-egress Worker: routes embedding requests to per-key Durable Objects.
// The VoyageSlot class lives in the separate "voyage-slot" script; this
// router only holds a script_name binding to it (one DO class per script).
import type { Env } from './slot';
import { assignDistinct, baseName, PLACEMENT_DO, type SlotHome } from './placement';
import { handleEmbeddings } from './embeddings';
import { handleRerank } from './rerank';

export { baseName as slotName };

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

function stubFor(env: Env, name: string) {
  return env.VOYAGE_SLOT.get(env.VOYAGE_SLOT.idFromName(name));
}

export async function loadHomes(env: Env): Promise<SlotHome[] | null> {
  // RPC stubs drop generic type parameters; cast at the boundary.
  return (await stubFor(env, PLACEMENT_DO).getJson('homes')) as SlotHome[] | null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') return json({ ok: true });
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

    // Egress witness only — no Voyage spend. `name` targets a fresh DO for
    // the positive control; otherwise the slot's pinned home (or base name).
    if (url.pathname === '/egress') {
      const name = url.searchParams.get('name');
      const slot = Number(url.searchParams.get('slot') ?? '0');
      let doName = baseName(slot);
      if (name) doName = `probe-${name.replace(/[^a-z0-9-]/gi, '').slice(0, 40)}`;
      else if (url.searchParams.get('pinned') === '1') {
        const home = (await loadHomes(env))?.find((h) => h.slot === slot);
        if (!home) return json({ error: 'slot_not_placed', slot }, 409);
        doName = home.name;
      }
      return json({ name: doName, egress_ip: await stubFor(env, doName).egressIp() });
    }

    // (Re)compute placement: one DO name per key slot, every IP distinct.
    // Slots that cannot get their own IP are reported, never shared.
    if (url.pathname === '/place' && req.method === 'POST') {
      const slots = await stubFor(env, PLACEMENT_DO).keyCount();
      const result = await assignDistinct(slots, (n) => stubFor(env, n).egressIp().catch(() => 'ERR'));
      await stubFor(env, PLACEMENT_DO).putJson('homes', result.homes);
      return json({ slots, ...result });
    }

    if (url.pathname === '/placement') return json({ homes: await loadHomes(env) });

    // OpenAI-compatible surface for the Rust ccc ApiEmbedder (base_url = /v1).
    if (req.method === 'POST' && (url.pathname === '/v1/embeddings' || url.pathname === '/v1/embeddings/query')) {
      const forceType = url.pathname.endsWith('/query') ? 'query' : null;
      return handleEmbeddings(req, env, await loadHomes(env), forceType);
    }

    if (req.method === 'POST' && url.pathname === '/v1/rerank') {
      return handleRerank(req, env, await loadHomes(env));
    }

    if (url.pathname === '/probe') {
      const slot = Number(url.searchParams.get('slot') ?? '0');
      const stub = stubFor(env, baseName(slot));
      const egress_ip = await stub.egressIp();
      const r = await stub.embed(slot, ['android permission overview'], 'voyage-4-lite', 'query');
      return json({
        slot: baseName(slot),
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
