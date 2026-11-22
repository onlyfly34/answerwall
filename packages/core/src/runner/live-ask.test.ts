import { expect, test } from 'vitest';
import { initialAskSnapshot, isTerminalStreamEvent } from '../protocol/index.ts';
import type { AskSnapshot, StreamEvent } from '../protocol/index.ts';
import { flushPromises } from '../testing/index.ts';
import { LiveAsk } from './live-ask.ts';
import { fold } from './test-harness.ts';

const slot = { slotId: 'a', providerId: 'claude' };

function initial(): AskSnapshot {
  return initialAskSnapshot({
    askId: 'ask-1',
    conversationId: 'conv-1',
    prompt: 'hi',
    createdAt: 1,
    targets: [{ ...slot, kind: 'claude' }],
  });
}

function create(limits = { maxEvents: 1000, maxChars: 1_000_000 }): LiveAsk {
  return new LiveAsk(initial(), limits);
}

/** start, `deltas` deltas, done, ask_done. */
function answer(ask: LiveAsk, deltas: number): void {
  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  for (let index = 0; index < deltas; index++) {
    ask.append({ type: 'delta', ...slot, text: `${index} ` });
  }
  ask.append({ type: 'done', ...slot, elapsedMs: 9 });
  ask.append({ type: 'ask_done' });
}

function read(ask: LiveAsk, after = 0) {
  const abort = new AbortController();
  const events: StreamEvent[] = [];
  let ended = false;
  const finished = (async () => {
    for await (const event of ask.subscribe(after, abort.signal)) events.push(event);
    ended = true;
  })();
  return { events, finished, abort, isEnded: () => ended };
}

test('append numbers events from 1 and folds them into the snapshot', () => {
  const ask = create();
  expect(ask.append({ type: 'queued', ...slot }).seq).toBe(1);
  expect(ask.append({ type: 'start', ...slot, at: 5, streaming: 'block' }).seq).toBe(2);
  ask.append({ type: 'delta', ...slot, text: 'Hel' });
  ask.append({ type: 'delta', ...slot, text: 'lo' });
  expect(ask.seq).toBe(4);
  expect(ask.done).toBe(false);
  expect(ask.snapshot()).toMatchObject({
    seq: 4,
    status: 'running',
    slots: [{ status: 'running', streaming: 'block', startedAt: 5, text: 'Hello' }],
  });
});

test('a snapshot is a copy that later events do not touch', () => {
  const ask = create();
  ask.append({ type: 'notice', ...slot, code: 'provider', message: 'one' });
  const before = ask.snapshot();
  ask.append({ type: 'notice', ...slot, code: 'provider', message: 'two' });
  ask.append({ type: 'error', ...slot, code: 'quota', message: 'out', elapsedMs: 1 });
  expect(before.slots[0]).toMatchObject({ status: 'queued', notices: [{ message: 'one' }] });
  expect(before.slots[0]!.error).toBeUndefined();
  before.slots[0]!.notices.length = 0;
  expect(ask.snapshot().slots[0]!.notices).toHaveLength(2);
});

test('a finished ask replays from every position and ends with ask_done', async () => {
  const ask = create();
  answer(ask, 5);
  const all = read(ask);
  await all.finished;
  expect(all.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(all.events.at(-1)?.type).toBe('ask_done');

  for (let after = 0; after < 8; after++) {
    const tail = read(ask, after);
    await tail.finished;
    expect(tail.events).toEqual(all.events.slice(after));
  }
});

test('a finished ask with nothing left to replay ends with one done snapshot', async () => {
  const ask = create();
  answer(ask, 1);
  for (const after of [4, 5, 99]) {
    const reader = read(ask, after);
    await reader.finished;
    expect(reader.events).toHaveLength(1);
    expect(reader.events[0]).toMatchObject({
      type: 'snapshot',
      seq: 4,
      snapshot: { status: 'done' },
    });
    expect(isTerminalStreamEvent(reader.events[0]!)).toBe(true);
  }
});

test('a subscriber waits for live events and ends after the terminal one', async () => {
  const ask = create();
  const reader = read(ask);
  await flushPromises();
  expect(reader.events).toEqual([]);

  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  await flushPromises();
  expect(reader.events.map((event) => event.type)).toEqual(['start']);

  ask.append({ type: 'done', ...slot, elapsedMs: 1 });
  ask.append({ type: 'ask_done' });
  await reader.finished;
  expect(reader.events.map((event) => event.type)).toEqual(['start', 'done', 'ask_done']);
});

test('a resume point that is no longer retained starts over from a snapshot', async () => {
  const ask = create({ maxEvents: 3, maxChars: 1_000_000 });
  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  for (let index = 0; index < 10; index++) ask.append({ type: 'delta', ...slot, text: `${index}` });
  expect(ask.retainedEvents).toBe(3);

  const reader = read(ask, 2);
  await flushPromises();
  expect(reader.events).toHaveLength(1);
  expect(reader.events[0]).toMatchObject({
    type: 'snapshot',
    seq: 11,
    snapshot: { status: 'running', slots: [{ text: '0123456789' }] },
  });

  ask.append({ type: 'done', ...slot, elapsedMs: 1 });
  ask.append({ type: 'ask_done' });
  await reader.finished;
  expect(reader.events.map((event) => event.seq)).toEqual([11, 12, 13]);
  expect(fold(initial(), reader.events)).toEqual(ask.snapshot());
});

test('the oldest retained position is still replayed without a snapshot', async () => {
  const ask = create({ maxEvents: 3, maxChars: 1_000_000 });
  answer(ask, 6);
  const reader = read(ask, 6);
  await reader.finished;
  expect(reader.events.map((event) => event.type)).toEqual(['delta', 'done', 'ask_done']);
});

test('a resume point beyond the last event of a running ask gets a snapshot, then live events', async () => {
  const ask = create();
  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  const reader = read(ask, 40);
  await flushPromises();
  expect(reader.events).toEqual([{ type: 'snapshot', seq: 1, snapshot: ask.snapshot() }]);
  ask.append({ type: 'delta', ...slot, text: 'x' });
  await flushPromises();
  expect(reader.events.map((event) => event.seq)).toEqual([1, 2]);
  reader.abort.abort();
  await reader.finished;
});

test('a subscriber that reads slowly is caught up with a snapshot, not buffered for', async () => {
  const ask = create({ maxEvents: 4, maxChars: 1_000_000 });
  const iterator = ask.subscribe(0, new AbortController().signal);
  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  expect((await iterator.next()).value).toMatchObject({ type: 'start', seq: 1 });

  for (let index = 0; index < 500; index++) ask.append({ type: 'delta', ...slot, text: 'x' });
  expect(ask.retainedEvents).toBe(4);
  const caughtUp = (await iterator.next()).value;
  expect(caughtUp).toMatchObject({ type: 'snapshot', seq: 501 });

  ask.append({ type: 'done', ...slot, elapsedMs: 1 });
  ask.append({ type: 'ask_done' });
  expect((await iterator.next()).value).toMatchObject({ type: 'done', seq: 502 });
  expect((await iterator.next()).value).toMatchObject({ type: 'ask_done', seq: 503 });
  expect((await iterator.next()).done).toBe(true);
});

test('many subscribers at different positions all converge on the same state', async () => {
  const ask = create({ maxEvents: 8, maxChars: 1_000_000 });
  const readers = [read(ask), read(ask, 3), read(ask, 1000)];
  ask.append({ type: 'start', ...slot, at: 5, streaming: 'token' });
  for (let index = 0; index < 40; index++) {
    ask.append({ type: 'delta', ...slot, text: `${index},` });
    if (index % 7 === 0) await flushPromises();
    if (index === 20) readers.push(read(ask, 5));
  }
  ask.append({ type: 'done', ...slot, elapsedMs: 1 });
  ask.append({ type: 'ask_done' });
  for (const reader of readers) {
    await reader.finished;
    expect(fold(initial(), reader.events)).toEqual(ask.snapshot());
    const seqs = reader.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  }
});

test('aborting ends a waiting subscription and leaves the others alone', async () => {
  const ask = create();
  const leaving = read(ask);
  const staying = read(ask);
  await flushPromises();
  leaving.abort.abort();
  await leaving.finished;
  expect(leaving.events).toEqual([]);

  answer(ask, 1);
  await staying.finished;
  expect(staying.events).toHaveLength(4);
});

test('a subscription with an already aborted signal yields nothing', async () => {
  const ask = create();
  answer(ask, 1);
  const abort = new AbortController();
  abort.abort();
  const events: StreamEvent[] = [];
  for await (const event of ask.subscribe(0, abort.signal)) events.push(event);
  expect(events).toEqual([]);
});

test('close ends waiting and replaying subscriptions without a terminal event', async () => {
  const ask = create();
  answer(ask, 3);
  const iterator = ask.subscribe(0, new AbortController().signal);
  expect((await iterator.next()).value).toMatchObject({ seq: 1 });
  ask.close();
  expect((await iterator.next()).done).toBe(true);

  const running = create();
  const waiting = read(running);
  await flushPromises();
  running.close();
  await waiting.finished;
  expect(waiting.events).toEqual([]);
});
