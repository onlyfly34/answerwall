import { expect, test } from 'vitest';
import { EventLog } from './event-log.ts';
import type { LoggedEvent } from './events.ts';

const delta = (seq: number, text = 'x'): LoggedEvent => ({
  type: 'delta',
  seq,
  slotId: 'a',
  providerId: 'claude',
  text,
});

function filled(count: number, limits = { maxEvents: 1000, maxChars: 1_000_000 }): EventLog {
  const log = new EventLog(limits);
  for (let seq = 1; seq <= count; seq++) log.append(delta(seq));
  return log;
}

test('an empty log retains nothing and starts before seq 1', () => {
  const log = new EventLog({ maxEvents: 4, maxChars: 1000 });
  expect([log.firstSeq, log.lastSeq, log.size]).toEqual([1, 0, 0]);
  expect(log.get(0)).toBeUndefined();
  expect(log.get(1)).toBeUndefined();
});

test('events are found by their seq', () => {
  const log = filled(5);
  expect([log.firstSeq, log.lastSeq, log.size]).toEqual([1, 5, 5]);
  for (let seq = 1; seq <= 5; seq++) expect(log.get(seq)?.seq).toBe(seq);
  expect(log.get(6)).toBeUndefined();
});

test('an event out of sequence is refused', () => {
  const log = filled(2);
  expect(() => log.append(delta(2))).toThrow(/expected seq 3/);
  expect(() => log.append(delta(4))).toThrow(/expected seq 3/);
  expect(log.lastSeq).toBe(2);
});

test('the oldest events are dropped beyond the event limit', () => {
  const log = filled(10, { maxEvents: 4, maxChars: 1_000_000 });
  expect([log.firstSeq, log.lastSeq, log.size]).toEqual([7, 10, 4]);
  expect(log.get(6)).toBeUndefined();
  expect(log.get(7)?.seq).toBe(7);
  expect(log.get(10)?.seq).toBe(10);
});

test('the oldest events are dropped beyond the text limit', () => {
  const log = new EventLog({ maxEvents: 1000, maxChars: 1000 });
  for (let seq = 1; seq <= 20; seq++) log.append(delta(seq, 'y'.repeat(236)));
  // Each event weighs 300: three fit, a fourth does not.
  expect(log.size).toBe(3);
  expect(log.firstSeq).toBe(18);
  expect(log.retainedChars).toBe(900);
});

test('an event larger than the whole budget is not retained at all', () => {
  const log = filled(3, { maxEvents: 1000, maxChars: 500 });
  log.append(delta(4, 'z'.repeat(1000)));
  expect([log.firstSeq, log.lastSeq, log.size, log.retainedChars]).toEqual([5, 4, 0, 0]);
  log.append(delta(5));
  expect([log.firstSeq, log.size]).toEqual([5, 1]);
  expect(log.get(5)?.seq).toBe(5);
});

test('the retained size stays bounded over a long stream', () => {
  const log = new EventLog({ maxEvents: 50, maxChars: 10_000 });
  for (let seq = 1; seq <= 20_000; seq++) {
    log.append(delta(seq, 'w'.repeat(seq % 300)));
    expect(log.size).toBeLessThanOrEqual(50);
    expect(log.retainedChars).toBeLessThanOrEqual(10_000);
  }
  expect(log.lastSeq).toBe(20_000);
  expect(log.get(log.firstSeq)?.seq).toBe(log.firstSeq);
  expect(log.get(log.firstSeq - 1)).toBeUndefined();
});
