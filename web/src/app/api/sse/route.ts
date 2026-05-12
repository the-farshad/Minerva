/**
 * Server-Sent Events stream for the signed-in user. Every open
 * tab subscribes once on mount; mutation routes push events
 * through `bus.emit(userId, …)` and they arrive here as a single
 * `data: <json>` SSE frame per event.
 *
 *   GET /api/sse        → text/event-stream
 *
 * The stream stays open until the client aborts (tab closed,
 * navigation away). A heartbeat fires every 25 s so reverse-
 * proxies that idle-close at 60 s don't hang up on a quiet
 * user.
 */
import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { bus, type MinervaEvent } from '@/lib/event-bus';

// Long-running streams don't fit the default route cache; force
// dynamic so each request gets a fresh handler.
export const dynamic = 'force-dynamic';
// Node runtime is required for the in-process EventEmitter; the
// edge runtime can't share memory with mutation routes.
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return new Response('Unauthorized', { status: 401 });
  const userId = (session.user as { id: string }).id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Opening comment frame helps some browsers (Safari) start
      // delivering events before the first real frame arrives.
      controller.enqueue(encoder.encode(':ok\n\n'));

      const send = (event: MinervaEvent) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch { /* controller closed mid-write — happens when the client aborts */ }
      };
      const unsubscribe = bus.subscribe(userId, send);

      // Heartbeat. Re-uses the same encoder; comment lines are
      // ignored by EventSource clients but keep the TCP / proxy
      // path warm. 25 s is comfortably under the typical 60 s
      // idle timeout on reverse proxies.
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { /* closed */ }
      }, 25_000);

      const abort = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', abort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Disable nginx-style buffering — events have to arrive as
      // they're emitted, not in 4-KB batches.
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
