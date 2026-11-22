import { expect, test } from 'vitest';
import {
  API_PATHS,
  AskSnapshotSchema,
  isTerminalStreamEvent,
  SSE_PING_INTERVAL_MS,
  StreamEventSchema,
} from '../protocol/index.ts';
import type { AskRequest, AskSnapshot, AskTarget, StreamEvent } from '../protocol/index.ts';
import { createHarness, fold, targets } from './test-harness.ts';
import type { Harness, HarnessOptions } from './test-harness.ts';
import { answerScript, createTestApp, TEST_TOKEN } from '../testing/index.ts';
import type { ScriptStep, TestApp } from '../testing/index.ts';

/** The ask routes of the real app over the real runner. */
function setup(options: HarnessOptions = {}): { h: Harness; t: TestApp } {
  const h = createHarness(options);
  const t = createTestApp(
    {
      asks: h.manager,
      settings: h.settings,
      storage: h.storage,
      providers: h.providers,
      logger: h.logger,
    },
    h.clock,
  );
  return { h, t };
}

const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];
/** Ten deltas, one every 10 ms, then the result at 110 ms. */
const tenDeltas = answerScript(
  Array.from({ length: 10 }, (_, index) => `${index} `),
  10,
);

async function submit(t: TestApp, askTargets: AskTarget[], prompt = 'What is 2 + 2?') {
  const response = await t.request('POST', API_PATHS.ask, {
    prompt,
    targets: askTargets,
  } satisfies AskRequest);
  expect(response.status).toBe(200);
  return ((await response.json()) as { askId: string }).askId;
}

async function snapshotOf(t: TestApp, askId: string): Promise<AskSnapshot> {
  const response = await t.request('GET', API_PATHS.askSnapshot(askId));
  expect(response.status).toBe(200);
  return AskSnapshotSchema.parse(await response.json());
}

async function errorOf(response: Response): Promise<[number, string]> {
  const body = (await response.json()) as { error: { code: string } };
  return [response.status, body.error.code];
}

/**
 * Splits a stream body into its messages, insisting on the exact framing:
 * `id`, `event` and one `data` line, a blank line after each message, and an
 * id and event name that agree with the payload.
 */
function parseSse(text: string): StreamEvent[] {
  if (text === '') return [];
  expect(text.endsWith('\n\n')).toBe(true);
  return text
    .slice(0, -2)
    .split('\n\n')
    .filter((message) => message !== ': ping')
    .map((message) => {
      const lines = message.split('\n');
      expect(lines).toHaveLength(3);
      const event = StreamEventSchema.parse(JSON.parse(lines[2]!.replace(/^data: /, '')));
      expect(lines.slice(0, 2)).toEqual([`id: ${event.seq}`, `event: ${event.type}`]);
      expect(lines[2]!.startsWith('data: ')).toBe(true);
      return event;
    });
}

function open(t: TestApp, askId: string, after?: number) {
  return t.request('GET', API_PATHS.askStream(askId, after));
}

function readerOf(response: Response): ReadableStreamDefaultReader<string> {
  return response.body!.pipeThrough(new TextDecoderStream()).getReader();
}

const seqs = (events: StreamEvent[]): number[] => events.map((event) => event.seq);
const count = (events: StreamEvent[], type: StreamEvent['type']): number =>
  events.filter((event) => event.type === type).length;

// ---- the whole path ----

test('twelve slots stream as well-formed server-sent events that fold into the snapshot', async () => {
  const { h, t } = setup({ script: answerScript(['line one\nline two\r\n', '✓ 🙂 "quoted"'], 10) });
  const askId = await submit(t, [
    ...targets('claude', 4),
    ...targets('codex', 4, 'x'),
    ...targets('grok', 4),
  ]);
  const initial = (await h.storage.turns.get(askId))!;
  expect(initial.seq).toBe(0);

  const response = await open(t, askId);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('X-Accel-Buffering')).toBe('no');
  expect(response.headers.get('Content-Encoding')).toBeNull();
  const body = response.text();
  await h.clock.advance(1000);
  const events = parseSse(await body);

  expect(seqs(events)).toEqual(events.map((_, index) => index + 1));
  expect([count(events, 'queued'), count(events, 'start'), count(events, 'done')]).toEqual([
    6, 12, 12,
  ]);
  expect(count(events, 'ask_done')).toBe(1);
  expect(events.at(-1)?.type).toBe('ask_done');
  expect(events.filter(isTerminalStreamEvent)).toHaveLength(1);

  const final = await snapshotOf(t, askId);
  expect(fold(initial, events)).toEqual(final);
  expect(final.status).toBe('done');
  expect(final.slots).toHaveLength(12);
  expect(final.slots.every((slot) => slot.text === 'line one\nline two\r\n✓ 🙂 "quoted"')).toBe(
    true,
  );
  expect(h.clock.pendingTimers).toBe(0);
});

test('the limits and provider checks of the runner reach the client as typed errors', async () => {
  const { h, t } = setup({
    script: hang,
    settings: (settings) => {
      Object.assign(settings.limits, {
        maxTargetsPerAsk: 3,
        maxPromptBytes: 1024,
        maxAsksInFlight: 2,
        maxQueuedSlots: 1,
      });
    },
  });
  const post = (body: unknown) => t.request('POST', API_PATHS.ask, body);
  const one = targets('claude', 1);

  expect(await errorOf(await post({ prompt: 'hi', targets: targets('claude', 4) }))).toEqual([
    400,
    'too_many_targets',
  ]);
  expect(await errorOf(await post({ prompt: 'é'.repeat(513), targets: one }))).toEqual([
    413,
    'prompt_too_long',
  ]);
  expect(
    await errorOf(await post({ prompt: 'hi', targets: [{ slotId: 'a', providerId: 'nope' }] })),
  ).toEqual([400, 'unknown_provider']);
  expect(
    await errorOf(await post({ prompt: 'hi', targets: [{ slotId: 'a', providerId: 'agy' }] })),
  ).toEqual([400, 'provider_disabled']);
  expect(await errorOf(await post({ prompt: 'hi', targets: [] }))).toEqual([400, 'bad_request']);
  expect(await errorOf(await post({ prompt: '', targets: one }))).toEqual([400, 'bad_request']);
  expect(await errorOf(await post({ prompt: 'hi', targets: [...one, ...one] }))).toEqual([
    400,
    'bad_request',
  ]);
  expect(
    await errorOf(await post({ prompt: 'hi', targets: one, conversationId: 'missing' })),
  ).toEqual([404, 'not_found']);
  expect(h.claude.runs).toHaveLength(0);

  // Two run, one waits; a second waiting slot would exceed the queue.
  await submit(t, targets('claude', 3));
  expect(await errorOf(await post({ prompt: 'hi', targets: one }))).toEqual([429, 'queue_full']);
  await submit(t, targets('codex', 1, 'x'));
  expect(await errorOf(await post({ prompt: 'hi', targets: targets('grok', 1) }))).toEqual([
    429,
    'too_many_asks',
  ]);
  await h.manager.shutdown();
});

test('a body that is not JSON is a bad request', async () => {
  const { t } = setup();
  const response = await t.app.request(API_PATHS.ask, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: '{"prompt": ',
  });
  expect(await errorOf(response)).toEqual([400, 'bad_request']);
});

// ---- resuming ----

test('a client that drops mid-stream cancels nothing and resumes with Last-Event-ID', async () => {
  const { h, t } = setup({ script: tenDeltas });
  const askId = await submit(t, targets('claude', 2));
  const initial = (await h.storage.turns.get(askId))!;

  const first = readerOf(await open(t, askId));
  const received: StreamEvent[] = [];
  while (received.length < 4) {
    await h.clock.advance(10);
    received.push(...parseSse((await first.read()).value!));
  }
  await first.cancel();
  await h.settle();

  // The ask runs on without any subscriber.
  await h.clock.advance(1000);
  expect(h.claude.active).toBe(0);

  const resumed = await t.app.request(API_PATHS.askStream(askId), {
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Last-Event-ID': String(received.at(-1)!.seq),
    },
  });
  const rest = parseSse(await resumed.text());
  expect(rest[0]!.seq).toBe(received.at(-1)!.seq + 1);
  expect(rest.at(-1)?.type).toBe('ask_done');

  const all = [...received, ...rest];
  expect(seqs(all)).toEqual(all.map((_, index) => index + 1));
  const final = await snapshotOf(t, askId);
  expect(fold(initial, all)).toEqual(final);
  expect(final.slots.map((slot) => slot.status)).toEqual(['done', 'done']);
  expect(h.clock.pendingTimers).toBe(0);
});

test('every resume point of a finished ask gives the rest of the log, or one done snapshot', async () => {
  const { h, t } = setup({ script: answerScript(['a', 'b']) });
  const askId = await submit(t, targets('claude', 1));
  await h.settle();
  const full = parseSse(await (await open(t, askId)).text());
  expect(full.map((event) => event.type)).toEqual(['start', 'delta', 'delta', 'done', 'ask_done']);

  for (let after = 0; after < full.length; after++) {
    expect(parseSse(await (await open(t, askId, after)).text())).toEqual(full.slice(after));
  }
  for (const after of [full.length, full.length + 10]) {
    const events = parseSse(await (await open(t, askId, after)).text());
    expect(events).toEqual([
      { type: 'snapshot', seq: full.length, snapshot: await snapshotOf(t, askId) },
    ]);
    expect(isTerminalStreamEvent(events[0]!)).toBe(true);
  }
});

test('a resume point that is no longer retained starts with a snapshot and continues live', async () => {
  const { h, t } = setup({ script: tenDeltas, tuning: { logMaxEvents: 4 } });
  const askId = await submit(t, targets('claude', 1));
  await h.clock.advance(60);

  const response = await open(t, askId, 1);
  const body = response.text();
  await h.clock.advance(1000);
  const events = parseSse(await body);

  const [first, ...live] = events;
  expect(first).toMatchObject({ type: 'snapshot', snapshot: { status: 'running' } });
  expect(first!.seq).toBeGreaterThan(4);
  expect(seqs(live)).toEqual(live.map((_, index) => first!.seq + index + 1));
  expect(live.at(-1)?.type).toBe('ask_done');
  expect(fold((first as Extract<StreamEvent, { type: 'snapshot' }>).snapshot, live)).toEqual(
    await snapshotOf(t, askId),
  );
});

test('a resume point that is not a sequence number is refused', async () => {
  const { t } = setup({ script: hang });
  const askId = await submit(t, targets('claude', 1));
  for (const after of ['-1', 'abc', '1.5']) {
    const byQuery = await t.request('GET', `${API_PATHS.askStream(askId)}?after=${after}`);
    expect(await errorOf(byQuery)).toEqual([400, 'bad_request']);
    const byHeader = await t.app.request(API_PATHS.askStream(askId), {
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Last-Event-ID': after },
    });
    expect(await errorOf(byHeader)).toEqual([400, 'bad_request']);
  }
  await t.request('POST', API_PATHS.askCancel(askId), {});
});

// ---- connections ----

test('a disconnecting client tears down its subscription and ping timer, and nothing else', async () => {
  const { h, t } = setup({ script: hang });
  const askId = await submit(t, targets('claude', 1));
  const staying = readerOf(await open(t, askId));
  const leaving = readerOf(await open(t, askId));
  expect(parseSse((await staying.read()).value!)[0]!.type).toBe('start');
  expect(parseSse((await leaving.read()).value!)[0]!.type).toBe('start');
  await h.settle();
  const timers = h.clock.pendingTimers;

  await leaving.cancel();
  await h.settle();
  expect(h.clock.pendingTimers).toBe(timers - 1);
  expect(h.claude.active).toBe(1);
  expect((await snapshotOf(t, askId)).slots[0]!.status).toBe('running');

  // The other client still gets pings and the rest of the ask.
  await h.clock.advance(SSE_PING_INTERVAL_MS);
  expect((await staying.read()).value).toBe(': ping\n\n');
  await t.request('POST', API_PATHS.askCancel(askId), {});
  const tail = parseSse(`${(await staying.read()).value!}${(await staying.read()).value!}`);
  expect(tail.map((event) => event.type)).toEqual(['cancelled', 'ask_done']);
  expect((await staying.read()).done).toBe(true);
  await h.settle();
  expect(h.clock.pendingTimers).toBe(0);
});

test('an idle stream of a running slot gets a ping comment every fifteen seconds', async () => {
  const { h, t } = setup({ script: hang });
  const askId = await submit(t, targets('claude', 1));
  const reader = readerOf(await open(t, askId));
  expect((await reader.read()).value).toMatch(/^id: 1\nevent: start\n/);

  for (let round = 0; round < 3; round++) {
    const next = reader.read();
    let arrived = false;
    void next.then(() => (arrived = true));
    await h.clock.advance(SSE_PING_INTERVAL_MS - 1);
    expect(arrived).toBe(false);
    await h.clock.advance(1);
    expect((await next).value).toBe(': ping\n\n');
  }
  await reader.cancel();
  await h.manager.shutdown();
});

test('a client that does not read holds nothing up and is caught up with a snapshot', async () => {
  const { h, t } = setup({ script: tenDeltas, tuning: { logMaxEvents: 4 } });
  const askId = await submit(t, targets('claude', 1));
  const response = await open(t, askId);

  await h.clock.advance(1000);
  const final = await snapshotOf(t, askId);
  expect(final.status).toBe('done');

  const events = parseSse(await response.text());
  expect(events.length).toBeLessThan(final.seq);
  expect(events.at(-1)).toEqual({ type: 'snapshot', seq: final.seq, snapshot: final });
  expect(h.clock.pendingTimers).toBe(0);
});

// ---- cancel ----

test('cancel ends one slot or the whole ask, queued or running, and is idempotent', async () => {
  const { h, t } = setup({ script: hang });
  const askId = await submit(t, targets('claude', 3));
  const cancel = async (body: unknown) =>
    (await t.request('POST', API_PATHS.askCancel(askId), body)).json();

  expect((await snapshotOf(t, askId)).slots.map((slot) => slot.status)).toEqual([
    'running',
    'running',
    'queued',
  ]);
  expect(await cancel({ slotId: 'c3' })).toEqual({ cancelled: ['c3'] });
  expect(await cancel({ slotId: 'c3' })).toEqual({ cancelled: [] });
  expect(await cancel({ slotId: 'other' })).toEqual({ cancelled: [] });
  expect(await cancel({})).toEqual({ cancelled: ['c1', 'c2'] });
  expect(await cancel({})).toEqual({ cancelled: [] });

  const events = parseSse(await (await open(t, askId)).text());
  expect(count(events, 'cancelled')).toBe(3);
  expect(events.at(-1)?.type).toBe('ask_done');
  // The queued slot never reached its provider.
  expect(h.claude.runs).toHaveLength(2);
  expect((await snapshotOf(t, askId)).slots.map((slot) => slot.status)).toEqual([
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
});

test('cancel validates its body and the ask', async () => {
  const { t } = setup({ script: hang });
  const askId = await submit(t, targets('claude', 1));
  expect(
    await errorOf(await t.request('POST', API_PATHS.askCancel(askId), { slotId: 'not valid!' })),
  ).toEqual([400, 'bad_request']);
  expect(await errorOf(await t.request('POST', API_PATHS.askCancel('missing'), {}))).toEqual([
    404,
    'not_found',
  ]);
  expect((await snapshotOf(t, askId)).slots[0]!.status).toBe('running');
  await t.request('POST', API_PATHS.askCancel(askId), {});
});

// ---- asks that are no longer in memory ----

test('an ask served from storage streams as one done snapshot and closes', async () => {
  const { h, t } = setup({ tuning: { finishedAsksRetained: 0 } });
  const askId = await submit(t, targets('claude', 1));
  await h.settle();

  const stored = (await h.storage.turns.get(askId))!;
  expect(await snapshotOf(t, askId)).toEqual(stored);
  for (const after of [undefined, 2, 99]) {
    expect(parseSse(await (await open(t, askId, after)).text())).toEqual([
      { type: 'snapshot', seq: stored.seq, snapshot: stored },
    ]);
  }
  expect(h.clock.pendingTimers).toBe(0);
});

test('an unknown or forgotten ask is a 404 on every ask route', async () => {
  const { h, t } = setup();
  const askId = await submit(t, targets('claude', 1));
  await h.settle();
  expect(await h.storage.turns.delete(askId)).toBe('deleted');
  h.manager.forget(askId);

  for (const id of [askId, 'missing']) {
    expect(await errorOf(await t.request('GET', API_PATHS.askSnapshot(id)))).toEqual([
      404,
      'not_found',
    ]);
    expect(await errorOf(await open(t, id))).toEqual([404, 'not_found']);
    expect(await errorOf(await t.request('POST', API_PATHS.askCancel(id), {}))).toEqual([
      404,
      'not_found',
    ]);
  }
});
