import { expect, test } from 'vitest';
import type { ProviderAdapter, ProviderEvent, RunRequest, Storage } from '../contracts/index.ts';
import { SERVER_RESTARTED_ERROR } from '../protocol/index.ts';
import type { ProviderInstance } from '../protocol/index.ts';
import { answerScript, createFakeStorage, READY_DETECTION } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, targets } from './test-harness.ts';

const partialThenHang: ScriptStep[] = [
  { event: { type: 'start' } },
  { event: { type: 'delta', text: 'partial' } },
  { hang: true },
];

function claudeAdapter(
  run: (instance: ProviderInstance, request: RunRequest) => AsyncIterable<ProviderEvent>,
): ProviderAdapter {
  return { kind: 'claude', toolAccess: 'none', detect: async () => READY_DETECTION, run };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

// ---- restart recovery ----

test('start fails the slots a previous process left queued or running, keeping their text', async () => {
  const storage = createFakeStorage();
  const crashed = createHarness({ storage, script: partialThenHang });
  const askId = await crashed.ask(targets('claude', 3));
  await crashed.clock.advance(1000);
  expect((await storage.turns.get(askId))!.slots.map((slot) => slot.status)).toEqual([
    'running',
    'running',
    'queued',
  ]);

  // A new process over the same database; the old one never shut down.
  const restarted = createHarness({ storage });
  await restarted.manager.start();

  const stored = (await storage.turns.get(askId))!;
  expect(stored.status).toBe('done');
  expect(stored.slots.map((slot) => [slot.status, slot.error, slot.text])).toEqual([
    ['error', SERVER_RESTARTED_ERROR, 'partial'],
    ['error', SERVER_RESTARTED_ERROR, 'partial'],
    ['error', SERVER_RESTARTED_ERROR, ''],
  ]);
  expect(SERVER_RESTARTED_ERROR).toEqual({ code: 'unknown', message: 'server restarted' });
  expect(await restarted.manager.snapshot(askId)).toEqual(stored);
  expect(restarted.logger.entries.find((entry) => entry.level === 'warn')?.fields).toMatchObject({
    failed: 3,
  });
});

test('an ask recovered after a restart streams as one done snapshot and is never run again', async () => {
  const storage = createFakeStorage();
  const crashed = createHarness({ storage, script: partialThenHang });
  const askId = await crashed.ask(targets('claude', 2));
  await crashed.clock.advance(1000);

  const restarted = createHarness({ storage });
  await restarted.manager.start();
  await restarted.clock.advance(3_600_000);

  const stored = (await storage.turns.get(askId))!;
  for (const after of [undefined, 0, 2, 50]) {
    expect(await restarted.events(askId, after)).toEqual([
      { type: 'snapshot', seq: stored.seq, snapshot: stored },
    ]);
  }
  expect(await restarted.manager.cancel(askId)).toEqual([]);
  expect(restarted.claude.runs).toHaveLength(0);
  expect(restarted.clock.pendingTimers).toBe(0);
});

test('start changes nothing when the previous process finished everything', async () => {
  const storage = createFakeStorage();
  const previous = createHarness({ storage });
  const askId = await previous.ask(targets('claude', 2));
  await previous.manager.shutdown();
  const before = await storage.turns.get(askId);

  const restarted = createHarness({ storage });
  await restarted.manager.start();
  expect(await storage.turns.get(askId)).toEqual(before);
  expect(restarted.logger.entries.filter((entry) => entry.level === 'warn')).toEqual([]);
});

test('a stored unfinished ask that no run of this process owns is reported as interrupted', async () => {
  const storage = createFakeStorage();
  const other = createHarness({ storage, script: partialThenHang });
  const askId = await other.ask(targets('claude', 1));
  await other.clock.advance(1000);

  const reader = createHarness({ storage });
  const snapshot = await reader.manager.snapshot(askId);
  expect(snapshot).toMatchObject({
    status: 'done',
    slots: [{ status: 'error', error: SERVER_RESTARTED_ERROR, text: 'partial' }],
  });
  expect(await reader.events(askId)).toEqual([{ type: 'snapshot', seq: snapshot.seq, snapshot }]);
});

// ---- shutdown ----

test('shutdown stops every provider, ends every slot and ask, and flushes to storage', async () => {
  const h = createHarness({
    script: (request) => (request.model === 'fast' ? answerScript(['ok']) : partialThenHang),
  });
  const askId = await h.ask([
    { slotId: 'x1', providerId: 'codex', model: 'fast' },
    ...targets('claude', 3),
  ]);
  const queuedOnly = await h.ask(targets('claude', 2, 'q'));
  const subscriber = h.watch(askId);
  await h.settle();
  expect(h.claude.active).toBe(2);
  expect(h.workDirs.existing.size).toBe(2);

  await h.manager.shutdown();
  await subscriber.ended;

  expect(h.claude.active).toBe(0);
  expect(h.claude.runs).toHaveLength(2);
  expect(h.claude.runs.every((run) => run.request.signal.aborted)).toBe(true);
  expect(h.workDirs.existing.size).toBe(0);
  expect(h.clock.pendingTimers).toBe(0);

  const snapshot = await h.manager.snapshot(askId);
  expect(snapshot.status).toBe('done');
  expect(snapshot.slots.map((slot) => [slot.slotId, slot.status, slot.error])).toEqual([
    ['x1', 'done', undefined],
    ['c1', 'error', SERVER_RESTARTED_ERROR],
    ['c2', 'error', SERVER_RESTARTED_ERROR],
    ['c3', 'error', SERVER_RESTARTED_ERROR],
  ]);
  expect(snapshot.slots[1]!.text).toBe('partial');
  expect(subscriber.events.filter((event) => event.type === 'error')).toHaveLength(3);
  expect(subscriber.events.filter((event) => event.type === 'ask_done')).toHaveLength(1);
  expect(subscriber.events.at(-1)?.type).toBe('ask_done');

  for (const id of [askId, queuedOnly]) {
    expect(await h.storage.turns.get(id)).toEqual(await h.manager.snapshot(id));
    expect((await h.storage.turns.get(id))!.status).toBe('done');
  }
});

test('shutdown waits until the providers are really gone', async () => {
  let gone = false;
  const h = createHarness({
    adapters: [
      claudeAdapter(async function* (_instance, request) {
        yield { type: 'start' };
        await aborted(request.signal);
        // Killing the process tree takes a moment.
        await new Promise<void>((resolve) => h.clock.schedule(50, resolve));
        gone = true;
      }),
    ],
  });
  await h.ask(targets('claude', 1));

  let finished = false;
  const shutdown = h.manager.shutdown().then(() => (finished = true));
  await h.clock.advance(49);
  expect([gone, finished]).toEqual([false, false]);
  expect(h.workDirs.existing.size).toBe(1);

  await h.clock.advance(1);
  await shutdown;
  expect(gone).toBe(true);
  expect(h.workDirs.existing.size).toBe(0);
});

test('shutdown gives up on a provider that never stops after the grace period', async () => {
  const h = createHarness({
    tuning: { stopGraceMs: 3000 },
    adapters: [
      claudeAdapter(() => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<never>(() => {}),
          return: () => new Promise<never>(() => {}),
        }),
      })),
    ],
  });
  const askId = await h.ask(targets('claude', 1));

  let finished = false;
  const shutdown = h.manager.shutdown().then(() => (finished = true));
  await h.clock.advance(2999);
  expect(finished).toBe(false);
  await h.clock.advance(1);
  await shutdown;

  expect((await h.storage.turns.get(askId))!.status).toBe('done');
  expect(h.workDirs.existing.size).toBe(0);
  expect(h.clock.pendingTimers).toBe(0);
});

test('shutdown is idempotent and with nothing running resolves at once', async () => {
  const h = createHarness();
  const first = h.manager.shutdown();
  expect(h.manager.shutdown()).toBe(first);
  await first;
  await h.manager.shutdown();
  expect(h.clock.pendingTimers).toBe(0);
});

test('after shutdown no ask is accepted and a settings change starts nothing', async () => {
  const h = createHarness();
  const finished = await h.ask(targets('claude', 1));
  await h.manager.shutdown();

  await expect(
    h.manager.submit({ prompt: 'hi', targets: targets('claude', 1) }),
  ).rejects.toMatchObject({ code: 'conflict' });
  await h.settings.update({ limits: { maxAsksInFlight: 8 } });
  await h.clock.advance(60_000);
  expect(h.claude.runs).toHaveLength(1);
  // What finished before is still readable.
  expect((await h.manager.snapshot(finished)).status).toBe('done');
});

test('an ask caught by shutdown while it was being stored is refused and never runs', async () => {
  const inner = createFakeStorage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const storage: Storage = {
    ...inner,
    turns: {
      ...inner.turns,
      create: async (snapshot) => {
        await gate;
        return inner.turns.create(snapshot);
      },
    },
  };
  const h = createHarness({ storage });
  const submitted = h.manager.submit({ prompt: 'hi', targets: targets('claude', 1) });
  const refused = expect(submitted).rejects.toMatchObject({ code: 'conflict' });
  await h.settle();

  let finished = false;
  const shutdown = h.manager.shutdown().then(() => (finished = true));
  await h.settle();
  expect(finished).toBe(false);

  release();
  await refused;
  await shutdown;
  expect(h.claude.runs).toHaveLength(0);
  expect(h.clock.pendingTimers).toBe(0);
});
