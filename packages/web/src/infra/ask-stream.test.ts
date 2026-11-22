import { createEffect, createRoot } from 'solid-js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { initialAskSnapshot } from '@answerwall/core/protocol';
import type { AskSnapshot, StreamEvent } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { AskStream } from '../contracts/services.ts';
import { createAskStream } from './ask-stream.ts';
import type { AskStreamTuning } from './ask-stream.ts';
import { errorResponse, fakeVisibility, sseConnection } from './test-support.ts';
import type { SseConnection } from './test-support.ts';

const ASK_ID = 'ask-1';
const TUNING: AskStreamTuning = {
  throttleMs: 80,
  backoffInitialMs: 500,
  backoffMaxMs: 2_000,
  stallMs: 45_000,
};
const slotA = { slotId: 'a', providerId: 'claude' };

function snapshot(slotIds: string[] = ['a'], overrides: Partial<AskSnapshot> = {}): AskSnapshot {
  return {
    ...initialAskSnapshot({
      askId: ASK_ID,
      conversationId: 'conv-1',
      prompt: 'hi',
      createdAt: 1,
      targets: slotIds.map((slotId) => ({ slotId, providerId: 'claude', kind: 'claude' })),
    }),
    ...overrides,
  };
}

const delta = (seq: number, text: string, slotId = 'a'): StreamEvent => ({
  type: 'delta',
  seq,
  slotId,
  providerId: 'claude',
  text,
});

/** Lets promise chains (the fake fetch, the stream reader) run without moving the clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

type Responder = (signal: AbortSignal | null | undefined) => Response | Promise<Response>;

const unreachable: Responder = () => {
  throw new TypeError('Failed to fetch');
};

interface HarnessOptions {
  initial?: AskSnapshot;
  random?: number;
  /** Answers for the first stream requests; after them a request opens a connection. */
  responders?: Responder[];
  /** Scripts the snapshot request. The stream starts at once, so this runs before it exists. */
  getAsk?(mock: Mock<(askId: string) => Promise<AskSnapshot>>): void;
}

function harness(options: HarnessOptions = {}) {
  const visibility = fakeVisibility();
  const reported: unknown[] = [];
  const streamUrls: string[] = [];
  /** When each stream request was made, on the fake clock. */
  const streamTimes: number[] = [];
  const connections: SseConnection[] = [];
  const streamResponders: Responder[] = [...(options.responders ?? [])];
  const getAsk = vi.fn<(askId: string) => Promise<AskSnapshot>>();
  options.getAsk?.(getAsk);

  const stream: AskStream = createAskStream(
    ASK_ID,
    {
      api: { getAsk },
      fetch: async (input, init) => {
        if (typeof input !== 'string') throw new Error('the stream is requested by path');
        streamUrls.push(input);
        streamTimes.push(Date.now());
        const responder = streamResponders.shift();
        if (responder) return responder(init?.signal);
        const connection = sseConnection(init?.signal);
        connections.push(connection);
        return connection.response;
      },
      notify: { reportError: (error) => void reported.push(error) },
      visibility,
      random: () => options.random ?? 0,
      tuning: TUNING,
    },
    options.initial,
  );

  return {
    stream,
    visibility,
    reported,
    streamUrls,
    streamTimes,
    connections,
    streamResponders,
    getAsk,
    /** The connection opened by the n-th stream request that got one. */
    connection: (index: number): SseConnection => {
      const connection = connections[index];
      if (!connection) throw new Error(`no stream connection ${index}`);
      return connection;
    },
    text: (slot = 0) => stream.snapshot()?.slots[slot]?.text,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('following', () => {
  test('with a snapshot in hand it streams from that seq and goes live', async () => {
    const h = harness({ initial: snapshot() });
    expect(h.stream.askId).toBe(ASK_ID);
    expect(h.stream.connection()).toBe('connecting');
    expect(h.stream.snapshot()?.slots[0]?.status).toBe('queued');

    await settle();

    expect(h.getAsk).not.toHaveBeenCalled();
    expect(h.streamUrls).toEqual(['/api/ask/ask-1/stream?after=0']);
    expect(h.stream.connection()).toBe('live');
    expect(h.stream.error()).toBeUndefined();
    h.stream.close();
  });

  test('without a snapshot it loads one first, then streams from its seq', async () => {
    const h = harness({ getAsk: (mock) => mock.mockResolvedValue(snapshot(['a'], { seq: 7 })) });
    expect(h.stream.snapshot()).toBeUndefined();

    await settle();

    expect(h.getAsk).toHaveBeenCalledWith(ASK_ID);
    expect(h.stream.snapshot()?.seq).toBe(7);
    expect(h.streamUrls).toEqual(['/api/ask/ask-1/stream?after=7']);
    h.stream.close();
  });

  test('an ask that is already done is shown and never streamed', async () => {
    const h = harness({
      getAsk: (mock) => mock.mockResolvedValue(snapshot(['a'], { status: 'done', seq: 4 })),
    });

    await settle();

    expect(h.stream.connection()).toBe('closed');
    expect(h.stream.snapshot()?.status).toBe('done');
    expect(h.streamUrls).toEqual([]);
    expect(h.visibility.listeners).toBe(0);
  });

  test('the request carries the session cookie and asks for an event stream', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return sseConnection(init?.signal).response;
    });
    const stream = createAskStream(
      ASK_ID,
      {
        api: { getAsk: vi.fn() },
        fetch,
        notify: { reportError: vi.fn() },
        visibility: fakeVisibility(),
        random: () => 0,
      },
      snapshot(),
    );
    await settle();

    const init = fetch.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
    expect(init?.method).toBeUndefined();
    stream.close();
  });
});

describe('applying events', () => {
  test('events reach the store only on the throttle, however many arrive', async () => {
    const slots = Array.from({ length: 12 }, (_, index) => `s${index}`);
    const h = harness({ initial: snapshot(slots) });
    await settle();

    let updates = 0;
    const dispose = createRoot((disposeRoot) => {
      createEffect(() => {
        h.stream.snapshot()?.slots.forEach((slot) => slot.text);
        updates += 1;
      });
      return disposeRoot;
    });
    expect(updates).toBe(1);

    let seq = 0;
    for (let round = 0; round < 5; round += 1) {
      for (const slotId of slots) h.connection(0).send(delta((seq += 1), `${round}`, slotId));
    }
    await settle();

    // 60 events were received and none is visible yet.
    expect(h.text(0)).toBe('');
    expect(updates).toBe(1);

    await vi.advanceTimersByTimeAsync(TUNING.throttleMs - 1);
    expect(updates).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.stream.snapshot()?.slots.map((slot) => slot.text)).toEqual(slots.map(() => '01234'));
    expect(h.stream.snapshot()?.seq).toBe(60);
    // One batch: every cell re-rendered once for sixty events.
    expect(updates).toBe(2);

    h.connection(0).send(delta(61, '!', 's0'));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);
    expect(h.text(0)).toBe('01234!');
    expect(updates).toBe(3);

    dispose();
    h.stream.close();
  });

  test('events use the shared reducer: status, text, usage and the terminal state', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    const server = h.connection(0);

    server.send({ type: 'start', seq: 1, ...slotA, at: 10, streaming: 'block' });
    server.send(delta(2, 'Hello'));
    server.send({ type: 'reasoning', seq: 3, ...slotA, text: 'thinking' });
    server.send({ type: 'notice', seq: 4, ...slotA, code: 'output_truncated', message: 'cut' });
    server.send({ type: 'done', seq: 5, ...slotA, elapsedMs: 9, usage: { outputTokens: 3 } });
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    expect(h.stream.snapshot()?.slots[0]).toMatchObject({
      status: 'done',
      streaming: 'block',
      startedAt: 10,
      text: 'Hello',
      reasoning: 'thinking',
      truncated: true,
      elapsedMs: 9,
      usage: { outputTokens: 3 },
    });
    expect(h.stream.snapshot()?.status).toBe('running');
    h.stream.close();
  });

  test('a snapshot event replaces everything the client had', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    const replacement = snapshot(['a'], { seq: 40 });
    replacement.slots[0]!.text = 'from the server';
    replacement.slots[0]!.status = 'running';

    h.connection(0).send(delta(1, 'stale'));
    h.connection(0).send({ type: 'snapshot', seq: 40, snapshot: replacement });
    h.connection(0).send(delta(41, '!'));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    expect(h.text()).toBe('from the server!');
    expect(h.stream.snapshot()?.seq).toBe(41);
    expect(h.stream.connection()).toBe('live');
    h.stream.close();
  });

  test('comments and pings are not events', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    h.connection(0).write(': ping\n\n');
    h.connection(0).send(delta(1, 'x'));
    h.connection(0).write(': ping\n\n');
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    expect(h.text()).toBe('x');
    expect(h.stream.connection()).toBe('live');
    h.stream.close();
  });

  test('an event split across network chunks is put back together', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    const message = `id: 1\nevent: delta\ndata: ${JSON.stringify(delta(1, '你好'))}\n\n`;
    const middle = Math.floor(message.length / 2);

    h.connection(0).write(message.slice(0, middle));
    await settle();
    h.connection(0).write(message.slice(middle));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    expect(h.text()).toBe('你好');
    h.stream.close();
  });
});

describe('terminal events', () => {
  test('ask_done closes the stream at once, without waiting for the throttle', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    h.connection(0).send(delta(1, 'answer'));
    h.connection(0).send({ type: 'done', seq: 2, ...slotA, elapsedMs: 5 });
    h.connection(0).send({ type: 'ask_done', seq: 3 });
    await settle();

    expect(h.stream.connection()).toBe('closed');
    expect(h.stream.snapshot()).toMatchObject({ status: 'done', seq: 3 });
    expect(h.text()).toBe('answer');
    expect(h.stream.error()).toBeUndefined();
  });

  test('after a terminal event the stream never reconnects', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send({ type: 'ask_done', seq: 1 });
    h.connection(0).end();
    await settle();

    h.visibility.set(true);
    h.visibility.set(false);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.streamUrls).toHaveLength(1);
    expect(h.stream.connection()).toBe('closed');
    expect(h.visibility.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a snapshot of a finished ask is terminal too', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    const finished = snapshot(['a'], { status: 'done', seq: 9 });
    finished.slots[0]!.status = 'done';
    finished.slots[0]!.text = 'all of it';

    h.connection(0).send({ type: 'snapshot', seq: 9, snapshot: finished });
    h.connection(0).end();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.stream.connection()).toBe('closed');
    expect(h.text()).toBe('all of it');
    expect(h.streamUrls).toHaveLength(1);
  });

  test('events after the terminal one are ignored', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    h.connection(0).write(
      [{ type: 'ask_done', seq: 1 } satisfies StreamEvent, delta(2, 'late')]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    );
    await settle();

    expect(h.stream.connection()).toBe('closed');
    expect(h.text()).toBe('');
    expect(h.stream.snapshot()?.seq).toBe(1);
  });
});

describe('resuming', () => {
  test('a stream that ends without a terminal event resumes from the last seq it received', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    h.connection(0).send(delta(1, 'ab'));
    h.connection(0).send(delta(2, 'cd'));
    h.connection(0).end();
    await settle();

    // What was received is shown at once; nothing is lost while reconnecting.
    expect(h.stream.connection()).toBe('reconnecting');
    expect(h.text()).toBe('abcd');
    expect(h.streamUrls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(249);
    expect(h.streamUrls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();

    expect(h.streamUrls[1]).toBe('/api/ask/ask-1/stream?after=2');
    expect(h.stream.connection()).toBe('live');

    h.connection(1).send(delta(3, 'ef'));
    h.connection(1).send({ type: 'ask_done', seq: 4 });
    await settle();
    expect(h.text()).toBe('abcdef');
    expect(h.stream.connection()).toBe('closed');
  });

  test('a replayed range that overlaps what is already here is not applied twice', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'a'));
    h.connection(0).send(delta(2, 'b'));
    h.connection(0).fail();
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    h.connection(1).send(delta(1, 'a'));
    h.connection(1).send(delta(2, 'b'));
    h.connection(1).send(delta(3, 'c'));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    expect(h.text()).toBe('abc');
    h.stream.close();
  });

  test('the delay doubles per failed attempt up to the maximum, with jitter', async () => {
    const h = harness({
      initial: snapshot(),
      random: 0.5,
      responders: [unreachable, unreachable, unreachable, unreachable, unreachable],
    });
    await settle();
    expect(h.stream.connection()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(10_000);
    await settle();

    // Ceilings 500, 1000, 2000, 2000 (capped); this jitter takes three quarters of each.
    const gaps = h.streamTimes.slice(1).map((time, index) => time - h.streamTimes[index]!);
    expect(gaps.slice(0, 4).map((gap) => Math.round(gap / 10) * 10)).toEqual([
      380, 750, 1500, 1500,
    ]);
    expect(h.stream.error()).toBeUndefined();
    expect(h.reported).toEqual([]);
    h.stream.close();
  });

  test('a connection that delivered events starts the backoff over', async () => {
    const h = harness({ initial: snapshot(), responders: [unreachable, unreachable] });
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    expect(h.stream.connection()).toBe('live');

    h.connection(0).send(delta(1, 'x'));
    await settle();
    h.connection(0).end();
    await settle();
    expect(h.stream.connection()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.streamUrls).toHaveLength(4);
    expect(h.streamUrls[3]).toBe('/api/ask/ask-1/stream?after=1');
    h.stream.close();
  });

  test.each([
    ['a server error', () => errorResponse('internal', 500)],
    ['a full queue', () => errorResponse('queue_full', 429)],
    ['a proxy error page', () => new Response('Bad gateway', { status: 502 })],
  ])('%s on the stream request is retried, not reported', async (_name, respond) => {
    const h = harness({ initial: snapshot(), responders: [respond] });
    await settle();

    expect(h.stream.connection()).toBe('reconnecting');
    expect(h.stream.error()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.stream.connection()).toBe('live');
    expect(h.reported).toEqual([]);
    h.stream.close();
  });

  test('an unreachable server while loading the snapshot is retried', async () => {
    const h = harness({
      getAsk: (mock) =>
        mock
          .mockRejectedValueOnce(new ApiError('network', 0, 'unreachable'))
          .mockRejectedValueOnce(new ApiError('internal', 500, 'oops'))
          .mockResolvedValue(snapshot(['a'], { seq: 2 })),
    });
    await settle();
    expect(h.stream.connection()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(250);
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    expect(h.getAsk).toHaveBeenCalledTimes(3);
    expect(h.stream.connection()).toBe('live');
    expect(h.streamUrls).toEqual(['/api/ask/ask-1/stream?after=2']);
    h.stream.close();
  });

  test('a connection that goes silent, pings included, is replaced', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    // Pings keep it alive well past the limit.
    for (let elapsed = 0; elapsed < TUNING.stallMs * 2; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      h.connection(0).write(': ping\n\n');
      await settle();
    }
    expect(h.connection(0).aborted).toBe(false);
    expect(h.streamUrls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(TUNING.stallMs);
    await settle();
    expect(h.connection(0).aborted).toBe(true);
    expect(h.stream.connection()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.streamUrls).toHaveLength(2);
    expect(h.stream.connection()).toBe('live');
    h.stream.close();
  });
});

describe('page visibility', () => {
  test('a hidden page does not retry; it reconnects the moment it is shown again', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'a'));
    await settle();

    h.visibility.set(true);
    h.connection(0).fail();
    await settle();
    expect(h.stream.connection()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.streamUrls).toHaveLength(1);

    h.visibility.set(false);
    await settle();
    expect(h.streamUrls).toEqual([
      '/api/ask/ask-1/stream?after=0',
      '/api/ask/ask-1/stream?after=1',
    ]);
    expect(h.stream.connection()).toBe('live');
    h.stream.close();
  });

  test('hiding the page during the backoff cancels the pending retry', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).end();
    await settle();
    expect(h.stream.connection()).toBe('reconnecting');

    h.visibility.set(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.streamUrls).toHaveLength(1);

    h.visibility.set(false);
    await settle();
    expect(h.streamUrls).toHaveLength(2);
    h.stream.close();
  });

  test('a healthy connection is kept while the page is hidden', async () => {
    const h = harness({ initial: snapshot() });
    await settle();

    h.visibility.set(true);
    h.connection(0).send(delta(1, 'while hidden'));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);
    h.visibility.set(false);
    await settle();

    expect(h.connection(0).aborted).toBe(false);
    expect(h.streamUrls).toHaveLength(1);
    expect(h.text()).toBe('while hidden');
    h.stream.close();
  });

  test('coming back after the device slept replaces a connection that is long silent', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'a'));
    await settle();
    await vi.advanceTimersByTimeAsync(TUNING.throttleMs);

    h.visibility.set(true);
    // The device sleeps: the clock moves on, but no timer of the page runs.
    vi.setSystemTime(Date.now() + TUNING.stallMs + 1);
    h.visibility.set(false);
    await settle();

    expect(h.connection(0).aborted).toBe(true);
    expect(h.stream.connection()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(h.streamUrls[1]).toBe('/api/ask/ask-1/stream?after=1');
    h.stream.close();
  });

  test('coming back online ends the wait before a retry', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).fail();
    await settle();
    expect(h.streamUrls).toHaveLength(1);

    h.visibility.online();
    await settle();
    expect(h.streamUrls).toHaveLength(2);
    h.stream.close();
  });
});

describe('failing for good', () => {
  test('a stream request answered with 404 fails: the ask no longer exists', async () => {
    const h = harness({
      initial: snapshot(),
      responders: [() => errorResponse('not_found', 404, 'No such ask')],
    });
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toMatchObject({ code: 'not_found', status: 404 });
    // A missing ask is the wall's to explain; it is not a session problem.
    expect(h.reported).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.streamUrls).toHaveLength(1);
    expect(h.visibility.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('a stream request answered with 401 fails and is passed on to return to sign-in', async () => {
    const h = harness({
      initial: snapshot(),
      responders: [() => errorResponse('unauthorized', 401)],
    });
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(h.reported).toEqual([h.stream.error()]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.streamUrls).toHaveLength(1);
  });

  test('a session that ends mid-stream fails on the reconnect', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'kept'));
    h.connection(0).end();
    h.streamResponders.push(() => errorResponse('unauthorized', 401));
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.text()).toBe('kept');
    expect(h.reported).toHaveLength(1);
  });

  test.each([
    [404, new ApiError('not_found', 404, 'gone'), 0],
    [401, new ApiError('unauthorized', 401, 'no session'), 1],
  ])('loading the snapshot answered with %i fails', async (_status, error, reports) => {
    const h = harness({ getAsk: (mock) => mock.mockRejectedValue(error) });
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toBe(error);
    expect(h.stream.snapshot()).toBeUndefined();
    expect(h.reported).toHaveLength(reports);
    expect(h.streamUrls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.getAsk).toHaveBeenCalledTimes(1);
  });

  test('a response that is not an event stream fails as an invalid response', async () => {
    const h = harness({
      initial: snapshot(),
      responders: [() => new Response('<!doctype html>', { status: 200 })],
    });
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toMatchObject({ code: 'invalid_response', status: 200 });
    expect(h.reported).toEqual([]);
  });

  test.each([
    ['not JSON', 'data: {not json\n\n'],
    ['not a protocol event', 'data: {"type":"mystery","seq":1}\n\n'],
  ])('an event that is %s fails as an invalid response', async (_name, message) => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'good'));
    h.connection(0).write(message);
    await settle();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toMatchObject({ code: 'invalid_response' });
    // What arrived before it is still shown.
    expect(h.text()).toBe('good');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.streamUrls).toHaveLength(1);
  });
});

describe('closing', () => {
  test('close stops following, drops the connection and shows what was received', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).send(delta(1, 'partial'));
    await settle();

    h.stream.close();

    expect(h.stream.connection()).toBe('closed');
    expect(h.text()).toBe('partial');
    expect(h.connection(0).aborted).toBe(true);
    expect(h.visibility.listeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.streamUrls).toHaveLength(1);
    expect(h.stream.connection()).toBe('closed');
    expect(h.stream.error()).toBeUndefined();
  });

  test('close during the backoff cancels the retry', async () => {
    const h = harness({ initial: snapshot() });
    await settle();
    h.connection(0).end();
    await settle();

    h.stream.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.streamUrls).toHaveLength(1);
    expect(h.stream.connection()).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  test('close while the snapshot is loading leaves the stream closed and empty', async () => {
    let resolve!: (value: AskSnapshot) => void;
    const h = harness({
      getAsk: (mock) => mock.mockReturnValue(new Promise((done) => (resolve = done))),
    });
    await settle();

    h.stream.close();
    resolve(snapshot());
    await settle();

    expect(h.stream.connection()).toBe('closed');
    expect(h.stream.snapshot()).toBeUndefined();
    expect(h.streamUrls).toEqual([]);
  });

  test('close is idempotent and a failed stream stays failed', async () => {
    const h = harness({ initial: snapshot(), responders: [() => errorResponse('not_found', 404)] });
    await settle();

    h.stream.close();
    h.stream.close();

    expect(h.stream.connection()).toBe('failed');
    expect(h.stream.error()).toBeDefined();
  });
});
