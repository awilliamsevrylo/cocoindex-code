// voyage-slot script: exports only the VoyageSlot Durable Object.
// A DO-only script still needs a default handler; it serves nothing public.
import { VoyageSlot } from '../src/slot';

export { VoyageSlot };

export default {
  async fetch(): Promise<Response> {
    return new Response('voyage-slot: DO host only', { status: 404 });
  },
} satisfies ExportedHandler;
