import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { AppDeps, AppEnv, Clock } from '../contracts/index.ts';
import {
  AskRequestSchema,
  CancelRequestSchema,
  SSE_PING_INTERVAL_MS,
  SSE_RESUME_HEADER,
  StreamQuerySchema,
} from '../protocol/index.ts';
import type { AskResponse, AskSnapshot, CancelResponse, StreamEvent } from '../protocol/index.ts';
import { parse, readJson } from './shared.ts';

export function formatSseEvent(event: StreamEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Calls `tick` every `intervalMs` until the returned function is called. */
function every(clock: Clock, intervalMs: number, tick: () => void): () => void {
  let cancel = clock.schedule(intervalMs, function run() {
    tick();
    cancel = clock.schedule(intervalMs, run);
  });
  return () => cancel();
}

export function askRoutes({ asks, clock }: Pick<AppDeps, 'asks' | 'clock'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/', async (c) => {
    const request = await readJson(c, AskRequestSchema);
    return c.json((await asks.submit(request)) satisfies AskResponse);
  });

  routes.get('/:askId', async (c) =>
    c.json((await asks.snapshot(c.req.param('askId'))) satisfies AskSnapshot),
  );

  routes.get('/:askId/stream', async (c) => {
    // A reconnecting EventSource sends the header; it wins over the URL it was first given.
    const resume = c.req.header(SSE_RESUME_HEADER);
    const { after } = parse(
      StreamQuerySchema,
      resume === undefined ? c.req.query() : { after: resume },
    );
    const disconnect = new AbortController();
    const events = await asks.subscribe(c.req.param('askId'), {
      ...(after === undefined ? {} : { after }),
      signal: disconnect.signal,
    });

    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return stream(c, async (out) => {
      out.onAbort(() => disconnect.abort());
      const stopPing = every(clock, SSE_PING_INTERVAL_MS, () => void out.write(': ping\n\n'));
      try {
        for await (const event of events) await out.write(formatSseEvent(event));
      } finally {
        stopPing();
        disconnect.abort();
      }
    });
  });

  routes.post('/:askId/cancel', async (c) => {
    const { slotId } = await readJson(c, CancelRequestSchema);
    const cancelled = await asks.cancel(c.req.param('askId'), slotId);
    return c.json({ cancelled } satisfies CancelResponse);
  });

  return routes;
}
