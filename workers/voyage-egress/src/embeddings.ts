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
import { streamEmbeddingsResponse } from './stream-json.ts';

const { scheduler, cooldownUntil } = sharedPool();

// Voyage ids are bare ("voyage-4-large"); the engine's ApiEmbedder and the
// Python ccc config use a litellm-style "voyage/" prefix. Accept both.
export function voyageModel(model: string): string {
  return model.startsWith('voyage/') ? model.slice('voyage/'.length) : model;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

// Shared core for BOTH surfaces: the HTTP handler below and the EmbedRPC
// named entrypoint (index.ts). One dispatch path — HTTP does not own logic
// the RPC caller would miss.
export interface EmbedCoreResult {
  vectors: number[][];
  usage_tokens: number;
  calls: number;
  rerouted: number;
  slots: number[];
}

export async function coreEmbed(
  env: Env,
  homes: SlotHome[] | null,
  input: string[],
  model: string,
  inputType: 'document' | 'query',
): Promise<EmbedCoreResult> {
  if (!homes || homes.length === 0) throw new NotPlacedError();

  const bySlot = new Map(homes.map((h) => [h.slot, h.name]));
  return dispatch(
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
}

// A sentinel the router and entrypoint map to their own error shapes; carries
// the HTTP status the route would have returned so nothing is invented twice.
export class NotPlacedError extends Error {
  status = 503;
  constructor() {
    super('not_placed: POST /place first');
  }
}

export async function handleEmbeddings(
  req: Request,
  env: Env,
  homes: SlotHome[] | null,
  forceType: 'query' | null,
): Promise<Response> {
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

  try {
    const r = await coreEmbed(env, homes, input, model, inputType);
    return streamEmbeddingsResponse({
      vectors: r.vectors,
      model: body.model,
      usage: { prompt_tokens: r.usage_tokens, total_tokens: r.usage_tokens },
      voyage_egress: { calls: r.calls, rerouted: r.rerouted, slots: r.slots },
    });
  } catch (e) {
    return embeddingsErrorResponse(e);
  }
}

export function embeddingsErrorResponse(e: unknown): Response {
  if (e instanceof NotPlacedError) return json({ error: 'not_placed: POST /place first' }, 503);
  if (e instanceof NoHealthySlot) return json({ error: 'no_healthy_slot' }, 503);
  if (e instanceof UpstreamError && e.status >= 400 && e.status < 500) {
    return json({ error: e.message.slice(0, 300) }, e.status);
  }
  return json({ error: String((e as Error).message ?? e).slice(0, 300) }, 502);
}
