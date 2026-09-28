// POST /v1/embeddings (OpenAI-compatible) and /v1/embeddings/query.
// Resolves placed slots, dispatches batches to their Durable Objects, and
// returns vectors in input order. Cooldowns live in isolate memory: a 429
// benches a slot for this isolate only, which is enough to steer the rest of
// a request (and later requests on the same isolate) away from it.
import type { Env } from './slot';
import type { SlotHome } from './placement';
import { dispatch, NoHealthySlot, UpstreamError } from './dispatch.ts';
// Scheduler + cooldown map live in pool.ts, module-scoped and shared with
// rerank.ts: at most POOL_PER_SLOT calls per Voyage key across both routes,
// and a cooldown learned on either route benches the slot for both.
import { sharedPool } from './pool.ts';

const { scheduler, cooldownUntil } = sharedPool();

// Voyage ids are bare ("voyage-4-large"); the engine's ApiEmbedder and the
// Python ccc config use a litellm-style "voyage/" prefix. Accept both.
export function voyageModel(model: string): string {
  return model.startsWith('voyage/') ? model.slice('voyage/'.length) : model;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function handleEmbeddings(
  req: Request,
  env: Env,
  homes: SlotHome[] | null,
  forceType: 'query' | null,
): Promise<Response> {
  if (!homes || homes.length === 0) return json({ error: 'not_placed: POST /place first' }, 503);
  let body: { model?: string; input?: string | string[]; input_type?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const input = typeof body.input === 'string' ? [body.input] : body.input;
  if (!Array.isArray(input) || input.length === 0 || !input.every((s) => typeof s === 'string')) {
    return json({ error: 'input must be a non-empty string or string[]' }, 400);
  }
  if (!body.model) return json({ error: 'model required' }, 400);
  const model = voyageModel(body.model);
  const inputType = forceType ?? (body.input_type === 'query' ? 'query' : 'document');

  const bySlot = new Map(homes.map((h) => [h.slot, h.name]));
  try {
    const r = await dispatch(
      input,
      homes.map((h) => h.slot),
      (slot, batch) => {
        const stub = env.VOYAGE_SLOT.get(env.VOYAGE_SLOT.idFromName(bySlot.get(slot)!));
        return stub.embed(slot, batch, model, inputType);
      },
      cooldownUntil,
      Date.now,
      scheduler,
    );
    return json({
      object: 'list',
      data: r.vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: body.model,
      usage: { prompt_tokens: r.usage_tokens, total_tokens: r.usage_tokens },
      voyage_egress: { calls: r.calls, rerouted: r.rerouted, slots: r.slots },
    });
  } catch (e) {
    if (e instanceof NoHealthySlot) return json({ error: 'no_healthy_slot' }, 503);
    if (e instanceof UpstreamError && e.status >= 400 && e.status < 500) {
      return json({ error: e.message.slice(0, 300) }, e.status);
    }
    return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 502);
  }
}
