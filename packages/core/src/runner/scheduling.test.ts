import { expect, test } from 'vitest';
import type { RunRequest } from '../contracts/index.ts';
import { isTerminalSlotStatus } from '../protocol/index.ts';
import type { ProviderInstance, Settings } from '../protocol/index.ts';
import { answerScript } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, fold, targets } from './test-harness.ts';
import type { Harness } from './test-harness.ts';

/** Every run takes 100 ms. */
const slow = answerScript(['ok'], 50);

const setConcurrency =
  (providerId: string, concurrency: number) =>
  (settings: Settings): void => {
    settings.providers.find((p) => p.id === providerId)!.concurrency = concurrency;
  };

async function updateProvider(
  h: Harness,
  providerId: string,
  change: Partial<ProviderInstance>,
): Promise<void> {
  await h.settings.update({
    providers: h.settings
      .get()
      .providers.map((p) => (p.id === providerId ? ({ ...p, ...change } as ProviderInstance) : p)),
  });
  await h.settle();
}

/** The prompts in the order the adapter received them. */
const order = (h: Harness): string[] => h.claude.runs.map((run) => run.request.prompt);

async function statuses(h: Harness, askId: string): Promise<string[]> {
  return (await h.manager.snapshot(askId)).slots.map((slot) => slot.status);
}

test('nothing runs, and no timer is pending, until an ask is submitted', async () => {
  const h = createHarness();
  await h.manager.start();
  await h.clock.advance(3_600_000);
  expect([h.claude.runs.length, h.codex.runs.length, h.grok.runs.length]).toEqual([0, 0, 0]);
  expect(h.claude.detectCalls).toBe(0);
  expect(h.clock.pendingTimers).toBe(0);
  expect(h.workDirs.created).toEqual([]);
});

test('a provider never runs more slots than its concurrency; the rest are queued in order', async () => {
  const h = createHarness({ script: slow });
  let peak = 0;
  const askId = await h.ask(targets('claude', 5));
  const watch = h.watch(askId);
  await h.settle();

  expect(h.claude.active).toBe(2);
  expect(await statuses(h, askId)).toEqual(['running', 'running', 'queued', 'queued', 'queued']);
  expect(watch.events.filter((e) => e.type === 'queued').map((e) => e.slotId)).toEqual([
    'c3',
    'c4',
    'c5',
  ]);
  expect(watch.events.slice(0, 3).map((e) => e.type)).toEqual(['queued', 'queued', 'queued']);

  for (let step = 0; step < 20; step++) {
    await h.clock.advance(25);
    peak = Math.max(peak, h.claude.active);
  }
  await watch.ended;
  expect(peak).toBe(2);
  expect(h.claude.runs).toHaveLength(5);
  const starts = watch.events.filter((e) => e.type === 'start').map((e) => e.slotId);
  expect(starts).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  expect(await statuses(h, askId)).toEqual(['done', 'done', 'done', 'done', 'done']);
});

test('a slot admitted at once gets no queued event', async () => {
  const h = createHarness({ script: slow });
  const askId = await h.ask(targets('claude', 2));
  await h.clock.advance(200);
  const events = await h.events(askId);
  expect(events.some((event) => event.type === 'queued')).toBe(false);
});

test('each provider has its own permits', async () => {
  const h = createHarness({ script: slow });
  const askId = await h.ask([
    ...targets('claude', 3),
    ...targets('codex', 3, 'x'),
    ...targets('grok', 1),
  ]);
  expect([h.claude.active, h.codex.active, h.grok.active]).toEqual([2, 2, 1]);
  expect(await statuses(h, askId)).toEqual([
    'running',
    'running',
    'queued',
    'running',
    'running',
    'queued',
    'running',
  ]);
});

test('a later ask is not kept waiting behind every slot of an earlier one', async () => {
  const h = createHarness({ script: slow, settings: setConcurrency('claude', 1) });
  await h.ask(targets('claude', 3), 'first');
  await h.ask(targets('claude', 1), 'second');
  await h.ask(targets('claude', 2), 'third');
  await h.clock.advance(1000);
  expect(order(h)).toEqual(['first', 'second', 'third', 'first', 'third', 'first']);
});

test('raising a provider concurrency admits queued slots at once', async () => {
  const h = createHarness({ script: slow, settings: setConcurrency('claude', 1) });
  const askId = await h.ask(targets('claude', 4));
  expect(h.claude.active).toBe(1);

  await updateProvider(h, 'claude', { concurrency: 3 });
  expect(h.claude.active).toBe(3);
  expect(await statuses(h, askId)).toEqual(['running', 'running', 'running', 'queued']);
});

test('lowering a provider concurrency lets running slots finish and admits no more until below it', async () => {
  const script = (request: RunRequest): ScriptStep[] =>
    answerScript(['ok'], request.model === 'long' ? 500 : 50);
  const h = createHarness({ script, settings: setConcurrency('claude', 3) });
  const askId = await h.ask([
    { slotId: 'a', providerId: 'claude', model: 'long' },
    { slotId: 'b', providerId: 'claude' },
    { slotId: 'c', providerId: 'claude' },
    { slotId: 'd', providerId: 'claude' },
    { slotId: 'e', providerId: 'claude' },
  ]);
  expect(h.claude.active).toBe(3);

  await updateProvider(h, 'claude', { concurrency: 1 });
  expect(h.claude.active).toBe(3);
  await h.clock.advance(150);
  // b and c are done; only the long one runs, and it alone fills the single permit.
  expect(h.claude.active).toBe(1);
  expect(await statuses(h, askId)).toEqual(['running', 'done', 'done', 'queued', 'queued']);

  await h.clock.advance(1000);
  expect(h.claude.active).toBe(1);
  await h.clock.advance(1000);
  expect(await statuses(h, askId)).toEqual(['done', 'done', 'done', 'done', 'done']);
});

test('slots queued for a provider that gets disabled fail without ever running', async () => {
  const h = createHarness({ script: slow });
  const askId = await h.ask(targets('claude', 4));
  await updateProvider(h, 'claude', { enabled: false });

  const snapshot = await h.manager.snapshot(askId);
  expect(snapshot.slots.map((slot) => slot.status)).toEqual([
    'running',
    'running',
    'error',
    'error',
  ]);
  expect(snapshot.slots[2]!.error).toMatchObject({ code: 'unsupported' });
  expect(snapshot.slots[2]).not.toHaveProperty('startedAt');
  expect(h.claude.runs).toHaveLength(2);

  await h.clock.advance(200);
  expect(await statuses(h, askId)).toEqual(['done', 'done', 'error', 'error']);
  expect(h.claude.runs).toHaveLength(2);
});

test('slots queued for a provider that is removed fail the same way', async () => {
  const h = createHarness({
    script: slow,
    settings: (s) =>
      s.providers.push({
        id: 'local',
        kind: 'openai-compat',
        label: 'Local',
        enabled: true,
        concurrency: 1,
        models: [],
        baseUrl: 'http://127.0.0.1:1234',
        hasApiKey: false,
      }),
  });
  const askId = await h.ask(targets('local', 3));
  await h.settings.update({
    providers: h.settings.get().providers.filter((p) => p.id !== 'local'),
  });
  await h.clock.advance(200);
  expect(await statuses(h, askId)).toEqual(['done', 'error', 'error']);
  expect((await h.manager.snapshot(askId)).status).toBe('done');
});

test('an ask with sixteen slots over three providers finishes every slot exactly once', async () => {
  const script = (request: RunRequest): ScriptStep[] => [
    { event: { type: 'start' } },
    { event: { type: 'reasoning', text: 'thinking ' }, delayMs: 10 },
    { event: { type: 'delta', text: `answer for ${request.model} ` }, delayMs: 10 },
    { event: { type: 'delta', text: 'done.' }, delayMs: 10 },
    { event: { type: 'done', elapsedMs: 30, usage: { outputTokens: 5 } }, delayMs: 5 },
  ];
  const h = createHarness({ script });
  const askTargets = [
    ...targets('claude', 6, 'c', { model: 'm-claude' }),
    ...targets('codex', 6, 'x', { model: 'm-codex' }),
    ...targets('grok', 4, 'g', { model: 'm-grok' }),
  ];
  const askId = await h.ask(askTargets);
  const initial = (await h.storage.turns.get(askId))!;
  const watch = h.watch(askId);
  let peak = 0;
  for (let step = 0; step < 60; step++) {
    await h.clock.advance(5);
    peak = Math.max(peak, h.claude.active + h.codex.active + h.grok.active);
  }
  await watch.ended;

  expect(peak).toBe(6);
  const events = watch.events;
  expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  expect(events.filter((event) => event.type === 'ask_done')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('ask_done');
  for (const target of askTargets) {
    const mine = events.filter((event) => 'slotId' in event && event.slotId === target.slotId);
    expect(mine.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(mine.filter((event) => event.type === 'start')).toHaveLength(1);
    expect(mine.at(-1)?.type).toBe('done');
  }
  expect(events.filter((event) => event.type === 'queued')).toHaveLength(10);

  const final = await h.manager.snapshot(askId);
  expect(final.status).toBe('done');
  expect(final.slots.every((slot) => isTerminalSlotStatus(slot.status))).toBe(true);
  expect(final.slots[0]).toMatchObject({
    text: 'answer for m-claude done.',
    reasoning: 'thinking ',
  });
  expect(fold(initial, events)).toEqual(final);
  expect(await h.storage.turns.get(askId)).toEqual(final);
  expect(h.workDirs.existing.size).toBe(0);
  expect(h.workDirs.created).toHaveLength(16);
  expect(h.clock.pendingTimers).toBe(0);
});
