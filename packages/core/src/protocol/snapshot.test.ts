import { expect, test } from 'vitest';
import { AskSnapshotSchema, applyStreamEvent, initialAskSnapshot } from './index.ts';
import type { AskSnapshot, StreamEvent } from './index.ts';

const slotA = { slotId: 'a', providerId: 'claude' };
const slotB = { slotId: 'b', providerId: 'codex' };

function start(): AskSnapshot {
  return initialAskSnapshot({
    askId: 'ask-1',
    conversationId: 'conv-1',
    prompt: 'hi',
    createdAt: 1000,
    targets: [
      { ...slotA, kind: 'claude', model: 'sonnet' },
      { ...slotB, kind: 'codex' },
    ],
  });
}

const run = (events: StreamEvent[], from = start()) => events.reduce(applyStreamEvent, from);

test('an ask starts with every slot queued and a valid snapshot', () => {
  const snapshot = start();
  expect(AskSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot.slots.map((slot) => slot.status)).toEqual(['queued', 'queued']);
  expect(snapshot.seq).toBe(0);
});

test('events accumulate text, status, usage and errors per slot', () => {
  const snapshot = run([
    { type: 'start', seq: 1, ...slotA, at: 1010, streaming: 'token' },
    { type: 'reasoning', seq: 2, ...slotA, text: 'thinking' },
    { type: 'delta', seq: 3, ...slotA, text: 'Hel' },
    { type: 'delta', seq: 4, ...slotA, text: 'lo' },
    { type: 'start', seq: 5, ...slotB, at: 1020, streaming: 'block' },
    { type: 'error', seq: 6, ...slotB, code: 'quota', message: 'Limit reached', elapsedMs: 5 },
    { type: 'done', seq: 7, ...slotA, usage: { outputTokens: 2 }, elapsedMs: 40 },
    { type: 'ask_done', seq: 8 },
  ]);

  expect(snapshot).toMatchObject({ status: 'done', seq: 8 });
  expect(snapshot.slots[0]).toMatchObject({
    status: 'done',
    streaming: 'token',
    startedAt: 1010,
    text: 'Hello',
    reasoning: 'thinking',
    usage: { outputTokens: 2 },
    elapsedMs: 40,
  });
  expect(snapshot.slots[1]).toMatchObject({
    status: 'error',
    streaming: 'block',
    error: { code: 'quota', message: 'Limit reached' },
  });
  expect(AskSnapshotSchema.safeParse(snapshot).success).toBe(true);
});

test('a truncation notice flags the slot; other notices do not', () => {
  const snapshot = run([
    { type: 'notice', seq: 1, ...slotA, code: 'provider', message: 'A tool call was denied' },
    { type: 'notice', seq: 2, ...slotB, code: 'output_truncated', message: 'Output limit reached' },
  ]);
  expect(snapshot.slots.map((slot) => slot.truncated)).toEqual([false, true]);
  expect(snapshot.slots[0]?.notices).toHaveLength(1);
});

test('cancelled and timeout are terminal statuses without an error', () => {
  const snapshot = run([
    { type: 'cancelled', seq: 1, ...slotA, elapsedMs: 0 },
    { type: 'timeout', seq: 2, ...slotB, elapsedMs: 300_000 },
  ]);
  expect(snapshot.slots.map((slot) => [slot.status, slot.error])).toEqual([
    ['cancelled', undefined],
    ['timeout', undefined],
  ]);
});

test('replaying events that are already included changes nothing', () => {
  const delta: StreamEvent = { type: 'delta', seq: 1, ...slotA, text: 'once' };
  const snapshot = run([delta, delta]);
  expect(snapshot.slots[0]?.text).toBe('once');
});

test('a snapshot event replaces the state and later events continue from it', () => {
  const replacement = run([{ type: 'delta', seq: 9, ...slotA, text: 'caught up' }]);
  const snapshot = run([
    { type: 'snapshot', seq: 9, snapshot: replacement },
    { type: 'delta', seq: 10, ...slotA, text: '!' },
  ]);
  expect(snapshot.slots[0]?.text).toBe('caught up!');
});
