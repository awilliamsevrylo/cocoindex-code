// voyage-egress Worker: routes embedding requests to per-key Durable Objects.
// The VoyageSlot class lives in the separate "voyage-slot" script; this
// router only holds a script_name binding to it (one DO class per script).
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './slot';
import { assignDistinct, baseName, PLACEMENT_DO, type SlotHome } from './placement';
import { coreEmbed, embeddingsErrorResponse, voyageModel } from './embeddings';
import { handleEmbeddings } from './embeddings';
import { coreRerank, handleRerank, NotPlacedError } from './rerank';
import { NoHealthySlot } from './scheduler.ts';

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

// RPC entrypoint for service-binding callers (named export alongside the
// default fetch handler — workers/runtime-apis/bindings/service-bindings/rpc.mdx
// "Named entrypoints"). Reuses the SAME core as the HTTP routes: dispatch()
// with the shared pool from src/pool.ts, placement homes, and cooldowns.
// RPC errors propagate to the caller as exceptions, so each method maps the
// core's sentinel errors to its own typed shape (owner rule: RPC-first).
export class EmbedRPC extends WorkerEntrypoint<Env> {
  async embed(
    texts: string[],
    model: string,
    inputType: 'document' | 'query',
  ): Promise<{ vectors: number[][]; usage_tokens: number }> {
    if (!Array.isArray(texts) || texts.length === 0 || !texts.every((s) => typeof s === 'string')) {
      throw new Error('texts must be a non-empty string[]');
    }
    if (typeof model !== 'string' || model.length === 0) throw new Error('model required');
    const r = await coreEmbed(this.env, await loadHomes(this.env), texts, voyageModel(model), inputType);
    return { vectors: r.vectors, usage_tokens: r.usage_tokens };
  }

  async rerank(
    query: string,
    documents: string[],
    model?: string,
    topK?: number,
  ): Promise<{ status: number; body: string; retry_after_ms?: number }> {
    if (typeof query !== 'string' || query.length === 0) throw new Error('query required');
    if (!Array.isArray(documents) || documents.length === 0 || !documents.every((d) => typeof d === 'string')) {
      throw new Error('documents must be a non-empty string[]');
    }
    if (typeof model !== 'string' || model.length === 0) throw new Error('model required');
    return coreRerank(this.env, await loadHomes(this.env), query, documents, model, topK);
  }

  // Called for any HTTP request that reaches this named entrypoint directly
  // (e.g. via env.SERVICE.fetch()) — no external routes here by design.
  override async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: 'embedrpc_no_http_surface' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
}

// Exported for the RPC test surface so error mapping is testable in isolation.
export { embeddingsErrorResponse, NotPlacedError, NoHealthySlot };
