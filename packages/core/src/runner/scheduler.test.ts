import { expect, test } from 'vitest';
import { Scheduler } from './scheduler.ts';
import type { Ticket } from './scheduler.ts';

function setup(capacity: Record<string, number>) {
  const started: string[] = [];
  const scheduler = new Scheduler((providerId) => capacity[providerId] ?? 1);
  const enqueue = (providerId: string, askId: string, name: string): Ticket =>
    scheduler.enqueue(providerId, askId, () => started.push(name));
  return { scheduler, started, enqueue, capacity };
}

test('nothing starts before dispatch, then at most the capacity', () => {
  const { scheduler, started, enqueue } = setup({ p: 2 });
  const tickets = ['a', 'b', 'c'].map((name) => enqueue('p', 'ask', name));
  expect(started).toEqual([]);
  expect(scheduler.waitingCount).toBe(3);

  scheduler.dispatch('p');
  expect(started).toEqual(['a', 'b']);
  expect(tickets.map((ticket) => ticket.waiting)).toEqual([false, false, true]);
  expect([scheduler.waitingCount, scheduler.activeCount('p')]).toEqual([1, 2]);
});

test('a released permit goes to the next waiter in order', () => {
  const { scheduler, started, enqueue } = setup({ p: 1 });
  const tickets = ['a', 'b', 'c'].map((name) => enqueue('p', 'ask', name));
  scheduler.dispatch();
  tickets[0]!.release();
  expect(started).toEqual(['a', 'b']);
  tickets[1]!.release();
  expect(started).toEqual(['a', 'b', 'c']);
  tickets[2]!.release();
  expect([scheduler.waitingCount, scheduler.activeCount('p')]).toEqual([0, 0]);
});

test('releasing twice returns one permit only', () => {
  const { scheduler, started, enqueue } = setup({ p: 1 });
  const tickets = ['a', 'b', 'c'].map((name) => enqueue('p', 'ask', name));
  scheduler.dispatch();
  tickets[0]!.release();
  tickets[0]!.release();
  expect(started).toEqual(['a', 'b']);
  expect(scheduler.activeCount('p')).toBe(1);
});

test('a waiter that leaves the queue never starts and takes no permit', () => {
  const { scheduler, started, enqueue } = setup({ p: 1 });
  const tickets = ['a', 'b', 'c'].map((name) => enqueue('p', 'ask', name));
  scheduler.dispatch();
  tickets[1]!.release();
  expect(tickets[1]!.waiting).toBe(false);
  expect(scheduler.waitingCount).toBe(1);
  tickets[0]!.release();
  expect(started).toEqual(['a', 'c']);
});

test('providers do not share permits', () => {
  const { scheduler, started, enqueue } = setup({ p: 1, q: 1 });
  enqueue('p', 'ask', 'p1');
  enqueue('p', 'ask', 'p2');
  enqueue('q', 'ask', 'q1');
  scheduler.dispatch();
  expect(started).toEqual(['p1', 'q1']);
  expect(scheduler.freePermits('p')).toBe(0);
  expect(scheduler.freePermits('q')).toBe(0);
  expect(scheduler.freePermits('other')).toBe(1);
});

test('free permits are zero while anyone waits, even below capacity', () => {
  const { scheduler, enqueue, capacity } = setup({ p: 3 });
  enqueue('p', 'ask', 'a');
  expect(scheduler.freePermits('p')).toBe(0);
  scheduler.dispatch();
  expect(scheduler.freePermits('p')).toBe(2);
  capacity.p = 0;
  expect(scheduler.freePermits('p')).toBe(0);
});

test('permits rotate between asks instead of serving the first ask to the end', () => {
  const { scheduler, started, enqueue } = setup({ p: 1 });
  const first = ['a1', 'a2', 'a3'].map((name) => enqueue('p', 'A', name));
  scheduler.dispatch();
  const second = ['b1', 'b2'].map((name) => enqueue('p', 'B', name));
  const third = enqueue('p', 'C', 'c1');
  const order = [first[0]!];
  const byName = new Map<string, Ticket>([
    ['a2', first[1]!],
    ['a3', first[2]!],
    ['b1', second[0]!],
    ['b2', second[1]!],
    ['c1', third],
  ]);
  for (let step = 0; step < 5; step++) {
    order.pop()!.release();
    order.push(byName.get(started.at(-1)!)!);
  }
  expect(started).toEqual(['a1', 'b1', 'c1', 'a2', 'b2', 'a3']);
});

test('a raised capacity admits more on the next dispatch; a lowered one waits for releases', () => {
  const { scheduler, started, enqueue, capacity } = setup({ p: 1 });
  const tickets = ['a', 'b', 'c', 'd'].map((name) => enqueue('p', 'ask', name));
  scheduler.dispatch();
  expect(started).toEqual(['a']);

  capacity.p = 3;
  scheduler.dispatch();
  expect(started).toEqual(['a', 'b', 'c']);

  capacity.p = 1;
  tickets[0]!.release();
  tickets[1]!.release();
  expect(started).toEqual(['a', 'b', 'c']);
  tickets[2]!.release();
  expect(started).toEqual(['a', 'b', 'c', 'd']);
});

test('a start callback may release its own permit', () => {
  const started: string[] = [];
  const scheduler = new Scheduler(() => 1);
  const tickets: Ticket[] = [];
  for (const name of ['a', 'b', 'c']) {
    const index = tickets.length;
    tickets.push(
      scheduler.enqueue('p', 'ask', () => {
        started.push(name);
        if (name !== 'c') tickets[index]!.release();
      }),
    );
  }
  scheduler.dispatch();
  expect(started).toEqual(['a', 'b', 'c']);
  expect(scheduler.activeCount('p')).toBe(1);
});
