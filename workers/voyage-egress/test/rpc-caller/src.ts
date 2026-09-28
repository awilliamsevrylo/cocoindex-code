// POC 12.1 caller proof: call voyage-egress EmbedRPC over the service binding.
// GET /probe?model=voyage-4  -> dims + content marker
// GET /order?model=voyage-4&n=300 -> order preservation via sentinel argmax
// GET /rerank -> rerank over RPC
type EmbedRPCStub = {
  embed(texts: string[], model: string, inputType: 'document' | 'query'): Promise<{
    vectors: number[][];
    usage_tokens: number;
  }>;
  rerank(query: string, documents: string[], model?: string, topK?: number): Promise<{
    status: number;
    body: string;
  }>;
};

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}

function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b) + 1e-12);
}

export default {
  async fetch(req: Request, env: { EGRESS: EmbedRPCStub }): Promise<Response> {
    const url = new URL(req.url);
    const model = url.searchParams.get('model') ?? 'voyage-4';
    const n = Number(url.searchParams.get('n') ?? '300');

    if (url.pathname === '/probe') {
      const r = await env.EGRESS.embed(['rpc probe alpha', 'rpc probe beta'], model, 'query');
      const dims = [...new Set(r.vectors.map((v) => v.length))];
      const head = r.vectors[0].slice(0, 3).map((x) => x.toFixed(4)).join(',');
      return Response.json({ ok: true, dims, usage_tokens: r.usage_tokens, head, n_vectors: r.vectors.length });
    }

    if (url.pathname === '/order') {
      const texts = Array.from({ length: n }, (_, i) => `order check input number ${i} unique-${i}`);
      const r = await env.EGRESS.embed(texts, model, 'document');
      const countOk = r.vectors.length === n && r.vectors.every((v) => v.length > 0);
      const dimsUnique = [...new Set(r.vectors.map((v) => v.length))];

      // Real order proof: re-embed sentinels alone, then require each batch slot
      // to be the argmax cosine for its own text. A shuffled output fails this.
      const sentinels = n >= 3 ? [0, Math.floor(n / 2), n - 1] : [0];
      const sTexts = sentinels.map((i) => texts[i]);
      const s = await env.EGRESS.embed(sTexts, model, 'document');
      const indexChecks = sentinels.map((idx, k) => {
        let best = 0;
        let bestScore = -Infinity;
        for (let j = 0; j < r.vectors.length; j++) {
          const c = cosine(r.vectors[j], s.vectors[k]);
          if (c > bestScore) {
            bestScore = c;
            best = j;
          }
        }
        return { expect: idx, got: best, cos: Number(bestScore.toFixed(6)), pass: best === idx && bestScore > 0.99 };
      });
      const orderOk = indexChecks.every((c) => c.pass);

      return Response.json({
        ok: countOk && orderOk,
        n: r.vectors.length,
        usage_tokens: r.usage_tokens + s.usage_tokens,
        dims_unique: dimsUnique,
        count_ok: countOk,
        order_ok: orderOk,
        index_checks: indexChecks,
      });
    }

    if (url.pathname === '/rerank') {
      const r = await env.EGRESS.rerank(
        'android permissions',
        ['permission model overview', 'USB host mode', 'WorkManager jobs'],
        'rerank-2.5',
        2,
      );
      return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
    }

    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
