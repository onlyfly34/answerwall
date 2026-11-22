import { expect, test } from 'vitest';
import type { RunRequest } from '../contracts/index.ts';
import { isTerminalStreamEvent } from '../protocol/index.ts';
import type { AskSnapshot, StreamEvent } from '../protocol/index.ts';
import { answerScript } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, fold, targets } from './test-harness.ts';
import type { Harness } from './test-harness.ts';

const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];
/** Ten deltas, one every 10 ms, then the result. */
const tenDeltas = answerScript(
  Array.from({ length: 10 }, (_, index) => `${index} `),
  10,
);

async function initialOf(h: Harness, askId: string): Promise<AskSnapshot> {
  const snapshot = await h.manager.snapshot(askId);
  return {
    ...snapshot,
    status: 'running',
    seq: 0,
    slots: snapshot.slots.map(({ slotId, providerId, kind }) => ({
      slotId,
      providerId,
      kind,
      status: 'queued',
      text: '',
      reasoning: '',
      notices: [],
      truncated: false,
    })),
  };
}

const seqs = (events: StreamEvent[]): number[] => events.map((event) => event.seq);

test('a finished ask replays from every position; the last positions give one done snapshot', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 3));
  await h.clock.advance(1000);
  const all = await h.events(askId);
  const last = all.at(-1)!.seq;
  expect(seqs(all)).toEqual(Array.from({ length: last }, (_, index) => index + 1));
  expect(all.at(-1)?.type).toBe('ask_done');
  const final = await h.manager.snapshot(askId);

  for (let after = 0; after < last; after++) {
    expect(await h.events(askId, after)).toEqual(all.slice(after));
  }
  for (const after of [last, last + 1, 10_000]) {
    expect(await h.events(askId, after)).toEqual([
      { type: 'snapshot', seq: last, snapshot: final },
    ]);
  }
});

test('a client that reconnects at any moment of a running ask ends with the same state', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 3));
  const initial = await initialOf(h, askId);
  const first = h.watch(askId);
  const resumed: { received: StreamEvent[]; rest: ReturnType<Harness['watch']> }[] = [];
  for (let step = 0; step < 30; step++) {
    await h.clock.advance(10);
    // A client that saw everything so far, lost its connection and resumes from its last seq.
    const received = [...first.events];
    resumed.push({ received, rest: h.watch(askId, received.at(-1)?.seq ?? 0) });
  }
  await first.ended;
  const final = await h.manager.snapshot(askId);
  expect(final.status).toBe('done');
  expect(fold(initial, first.events)).toEqual(final);

  for (const { received, rest } of resumed) {
    await rest.ended;
    const terminal = rest.events.at(-1)!;
    expect(isTerminalStreamEvent(terminal)).toBe(true);
    expect(rest.events.filter(isTerminalStreamEvent)).toHaveLength(1);
    expect(fold(initial, [...received, ...rest.events])).toEqual(final);
    if (terminal.type === 'ask_done') {
      // Replayed, not snapshotted: exactly the events the client was missing.
      expect([...received, ...rest.events]).toEqual(first.events);
    }
  }
});

test('when the resume point is no longer retained the stream starts with a snapshot and continues live', async () => {
  const h = createHarness({ script: tenDeltas, tuning: { logMaxEvents: 4 } });
  const askId = await h.ask(targets('claude', 1));
  const initial = await initialOf(h, askId);
  await h.clock.advance(60);

  const late = h.watch(askId, 1);
  await h.clock.advance(1000);
  await late.ended;
  expect(late.events[0]).toMatchObject({
    type: 'snapshot',
    seq: 7,
    snapshot: { status: 'running', seq: 7, slots: [{ status: 'running', text: '0 1 2 3 4 5 ' }] },
  });
  expect(seqs(late.events)).toEqual([7, 8, 9, 10, 11, 12, 13]);
  expect(late.events.at(-1)?.type).toBe('ask_done');
  expect(fold(initial, late.events)).toEqual(await h.manager.snapshot(askId));
});

test('the text budget of the log also forces a snapshot', async () => {
  const h = createHarness({
    script: answerScript(['x'.repeat(600), 'y'.repeat(600), 'z'.repeat(600)], 10),
    tuning: { logMaxChars: 1000 },
  });
  const askId = await h.ask(targets('claude', 1));
  await h.clock.advance(30);
  const reader = h.watch(askId, 0);
  await h.clock.advance(10);
  await reader.ended;
  expect(reader.events[0]?.type).toBe('snapshot');
  expect(fold(await initialOf(h, askId), reader.events)).toEqual(await h.manager.snapshot(askId));
});

test('a finished ask whose log no longer reaches back ends with one done snapshot', async () => {
  const h = createHarness({ script: tenDeltas, tuning: { logMaxEvents: 4 } });
  const askId = await h.ask(targets('claude', 1));
  await h.clock.advance(1000);
  const events = await h.events(askId, 2);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'snapshot', seq: 13, snapshot: { status: 'done' } });
  // The retained tail is still replayed as events.
  expect((await h.events(askId, 10)).map((event) => event.type)).toEqual([
    'delta',
    'done',
    'ask_done',
  ]);
});

test('a resume point beyond the last event of a running ask gets a snapshot, then live events', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 1));
  await h.clock.advance(20);
  const reader = h.watch(askId, 500);
  await h.settle();
  expect(reader.events).toEqual([
    { type: 'snapshot', seq: 3, snapshot: await h.manager.snapshot(askId) },
  ]);
  await h.clock.advance(1000);
  await reader.ended;
  expect(seqs(reader.events)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('two subscribers receive the same events', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 4));
  const one = h.watch(askId);
  const two = h.watch(askId);
  await h.clock.advance(1000);
  await Promise.all([one.ended, two.ended]);
  expect(one.events).toEqual(two.events);
  expect(one.events.at(-1)?.type).toBe('ask_done');
});

test('a subscriber that leaves cancels nothing and disturbs no other subscriber', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 2));
  const leaving = h.watch(askId);
  const staying = h.watch(askId);
  await h.clock.advance(30);
  leaving.stop();
  await leaving.ended;
  const seen = leaving.events.length;
  expect(seen).toBeGreaterThan(0);
  expect(leaving.events.some(isTerminalStreamEvent)).toBe(false);
  expect(h.claude.active).toBe(2);
  expect(h.claude.runs.every((run) => !run.request.signal.aborted)).toBe(true);

  await h.clock.advance(1000);
  await staying.ended;
  expect(leaving.events).toHaveLength(seen);
  expect(staying.events.at(-1)?.type).toBe('ask_done');
  expect((await h.manager.snapshot(askId)).slots.map((slot) => slot.status)).toEqual([
    'done',
    'done',
  ]);
});

test('an ask runs to its end with no subscriber at all', async () => {
  const h = createHarness({ script: tenDeltas });
  const askId = await h.ask(targets('claude', 2));
  await h.clock.advance(1000);
  expect(await h.storage.turns.get(askId)).toMatchObject({
    status: 'done',
    slots: [{ text: '0 1 2 3 4 5 6 7 8 9 ' }, { status: 'done' }],
  });
});

test('a subscriber that stops reading neither blocks the run nor makes the log grow', async () => {
  const script = (_request: RunRequest): ScriptStep[] =>
    answerScript(
      Array.from({ length: 3000 }, () => 'x'.repeat(100)),
      0,
    );
  const h = createHarness({ script, tuning: { logMaxEvents: 16, logMaxChars: 4000 } });
  const askId = await h.ask(targets('claude', 1));
  const abort = new AbortController();
  const stalled = (await h.manager.subscribe(askId, { signal: abort.signal }))[
    Symbol.asyncIterator
  ]();
  // The run finished although nobody read; the stalled reader is then caught up in one step.
  expect((await h.manager.snapshot(askId)).status).toBe('done');
  const first = (await stalled.next()).value as StreamEvent;
  expect(first).toMatchObject({ type: 'snapshot', snapshot: { status: 'done' } });
  expect(first.type === 'snapshot' && first.snapshot.slots[0]!.text).toHaveLength(300_000);
  expect((await stalled.next()).done).toBe(true);
});

test('an aborted subscription ends even while it waits for the next event', async () => {
  const h = createHarness({ script: hang });
  const askId = await h.ask(targets('claude', 1));
  const reader = h.watch(askId);
  await h.settle();
  expect(reader.events.map((event) => event.type)).toEqual(['start']);
  reader.stop();
  await reader.ended;
  expect((await h.manager.snapshot(askId)).status).toBe('running');
});

test('subscribing to or reading an unknown ask is not_found before anything is yielded', async () => {
  const h = createHarness();
  const signal = new AbortController().signal;
  await expect(h.manager.subscribe('missing', { signal })).rejects.toMatchObject({
    code: 'not_found',
  });
  await expect(h.manager.snapshot('missing')).rejects.toMatchObject({ code: 'not_found' });
});

test('finished asks beyond the retained number are served from storage as one done snapshot', async () => {
  const h = createHarness({ tuning: { finishedAsksRetained: 2 } });
  const ids: string[] = [];
  for (let index = 0; index < 4; index++)
    ids.push(await h.ask(targets('claude', 1), `prompt ${index}`));

  // The two newest still have their log.
  expect((await h.events(ids[3]!)).map((event) => event.type)).toEqual([
    'start',
    'delta',
    'done',
    'ask_done',
  ]);
  expect((await h.events(ids[2]!)).at(-1)?.type).toBe('ask_done');

  for (const askId of [ids[0]!, ids[1]!]) {
    const stored = (await h.storage.turns.get(askId))!;
    expect(await h.manager.snapshot(askId)).toEqual(stored);
    for (const after of [undefined, 0, 2, 99]) {
      expect(await h.events(askId, after)).toEqual([
        { type: 'snapshot', seq: 4, snapshot: stored },
      ]);
    }
    expect(await h.manager.cancel(askId)).toEqual([]);
  }
});

test('a stored ask subscribed with an aborted signal yields nothing', async () => {
  const h = createHarness({ tuning: { finishedAsksRetained: 0 } });
  const askId = await h.ask(targets('claude', 1));
  const abort = new AbortController();
  abort.abort();
  const events: StreamEvent[] = [];
  for await (const event of await h.manager.subscribe(askId, { signal: abort.signal }))
    events.push(event);
  expect(events).toEqual([]);
});

test('forget drops a finished ask from memory and ends its subscriptions', async () => {
  const h = createHarness();
  const askId = await h.ask(targets('claude', 1));
  const stream = await h.manager.subscribe(askId, { signal: new AbortController().signal });
  const iterator = stream[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: 'start' });

  expect(await h.storage.turns.delete(askId)).toBe('deleted');
  h.manager.forget(askId);
  expect((await iterator.next()).done).toBe(true);
  await expect(h.manager.snapshot(askId)).rejects.toMatchObject({ code: 'not_found' });
  await expect(h.manager.cancel(askId)).rejects.toMatchObject({ code: 'not_found' });
  h.manager.forget(askId);
});

test('forget leaves a running ask and an unknown ask alone', async () => {
  const h = createHarness({ script: hang });
  const askId = await h.ask(targets('claude', 1));
  const reader = h.watch(askId);
  h.manager.forget(askId);
  h.manager.forget('missing');
  await h.settle();
  expect((await h.manager.snapshot(askId)).status).toBe('running');
  expect(h.claude.active).toBe(1);

  await h.manager.cancel(askId);
  await reader.ended;
  expect(reader.events.map((event) => event.type)).toEqual(['start', 'cancelled', 'ask_done']);
});

test('a forgotten ask no longer counts towards the retained ones', async () => {
  const h = createHarness({ tuning: { finishedAsksRetained: 2 } });
  const first = await h.ask(targets('claude', 1));
  const second = await h.ask(targets('claude', 1));
  h.manager.forget(first);
  const third = await h.ask(targets('claude', 1));
  // Without the forgotten one, both of these still fit and keep their log.
  expect((await h.events(second)).at(-1)?.type).toBe('ask_done');
  expect((await h.events(third)).at(-1)?.type).toBe('ask_done');
});
