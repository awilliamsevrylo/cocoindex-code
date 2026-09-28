// Streaming JSON response generator for embeddings to avoid V8 isolate
// "Invalid string length" errors when stringifying large vector arrays.

export interface EmbeddingsStreamPayload {
  vectors: number[][];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
  voyage_egress: { calls: number; rerouted: number; slots: number[] };
}

export function streamEmbeddingsResponse(payload: EmbeddingsStreamPayload): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      await writer.write(encoder.encode('{"object":"list","data":['));
      const vectors = payload.vectors;
      for (let i = 0; i < vectors.length; i++) {
        if (i > 0) {
          await writer.write(encoder.encode(','));
        }
        const item = { object: 'embedding', index: i, embedding: vectors[i] };
        await writer.write(encoder.encode(JSON.stringify(item)));
      }
      const tail = `],"model":${JSON.stringify(payload.model)},"usage":${JSON.stringify(payload.usage)},"voyage_egress":${JSON.stringify(payload.voyage_egress)}}`;
      await writer.write(encoder.encode(tail));
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { 'content-type': 'application/json' },
  });
}
