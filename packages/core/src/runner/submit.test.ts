import { expect, test } from 'vitest';
import { AppError } from '../contracts/index.ts';
import type { Storage } from '../contracts/index.ts';
import { answerScript, createFakeStorage } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, targets } from './test-harness.ts';

const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}

test('an ask is stored with every slot queued and its id returned without waiting for any answer', async () => {
  const h = createHarness({
    script: hang,
    settings: (s) => (s.providers.find((p) => p.id === 'codex')!.defaultModel = 'gpt-default'),
  });
  const { askId } = await h.manager.submit({
    prompt: 'Why is the sky blue?',
    targets: [
      { slotId: 'a', providerId: 'claude', model: 'opus', effort: 'high' },
      { slotId: 'b', providerId: 'codex' },
      { slotId: 'c', providerId: 'grok' },
    ],
  });

  expect((await h.manager.snapshot(askId)).status).toBe('running');
  const stored = (await h.storage.turns.get(askId))!;
  expect(stored).toMatchObject({
    askId,
    prompt: 'Why is the sky blue?',
    createdAt: h.clock.now(),
    status: 'running',
    seq: 0,
  });
  expect(stored.conversationId).not.toBe(askId);
  expect(await h.storage.turns.conversationExists(stored.conversationId)).toBe(true);
  expect(stored.slots).toEqual([
    expect.objectContaining({
      slotId: 'a',
      kind: 'claude',
      model: 'opus',
      effort: 'high',
      status: 'queued',
    }),
    expect.objectContaining({ slotId: 'b', kind: 'codex', model: 'gpt-default', status: 'queued' }),
    expect.objectContaining({ slotId: 'c', kind: 'grok', status: 'queued' }),
  ]);
  expect(stored.slots[2]).not.toHaveProperty('model');
  expect(stored.slots[1]).not.toHaveProperty('effort');
});

test('the adapter gets the prompt, the resolved model, the effort, the timeout and a work dir', async () => {
  const h = createHarness({
    script: hang,
    settings: (s) => {
      s.providers.find((p) => p.id === 'codex')!.defaultModel = 'gpt-default';
      s.limits.slotTimeoutMs = 42_000;
    },
  });
  await h.ask(
    [
      { slotId: 'a', providerId: 'claude', model: 'opus', effort: 'high' },
      { slotId: 'b', providerId: 'codex' },
      { slotId: 'c', providerId: 'grok' },
    ],
    'Why?',
  );

  const claude = h.claude.runs[0]!;
  expect(claude.instance.id).toBe('claude');
  expect(claude.request).toMatchObject({
    prompt: 'Why?',
    model: 'opus',
    effort: 'high',
    timeoutMs: 42_000,
  });
  expect(claude.request.signal.aborted).toBe(false);
  expect(h.workDirs.existing.has(claude.request.workDir)).toBe(true);
  expect(h.codex.runs[0]!.request).toMatchObject({ model: 'gpt-default' });
  expect(h.codex.runs[0]!.request).not.toHaveProperty('effort');
  expect(h.grok.runs[0]!.request).not.toHaveProperty('model');
  expect(new Set(h.workDirs.created).size).toBe(3);
});

test('more targets than the configured limit are refused', async () => {
  const h = createHarness({ settings: (s) => (s.limits.maxTargetsPerAsk = 3) });
  const error = await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 4) }));
  expect([error.code, error.status]).toEqual(['too_many_targets', 400]);
  await h.ask(targets('claude', 3));
});

test('the prompt limit counts UTF-8 bytes', async () => {
  const h = createHarness({ settings: (s) => (s.limits.maxPromptBytes = 1024) });
  await h.ask(targets('claude', 1), 'a'.repeat(1024));
  const error = await rejection(
    // 342 characters of three bytes each: 1026 bytes.
    h.manager.submit({ prompt: '漢'.repeat(342), targets: targets('claude', 1) }),
  );
  expect([error.code, error.status]).toEqual(['prompt_too_long', 413]);
});

test('an unknown provider and a disabled provider are told apart', async () => {
  const h = createHarness();
  const unknown = await rejection(
    h.manager.submit({ prompt: 'hi', targets: [...targets('claude', 1), ...targets('nope', 1)] }),
  );
  expect(unknown.code).toBe('unknown_provider');
  expect(unknown.message).toContain('nope');

  const disabled = await rejection(h.manager.submit({ prompt: 'hi', targets: targets('agy', 1) }));
  expect(disabled.code).toBe('provider_disabled');
});

test('a provider enabled or disabled in settings counts from the next ask on', async () => {
  const h = createHarness();
  const providers = h.settings.get().providers;
  await h.settings.update({
    providers: providers.map((p) => (p.id === 'claude' ? { ...p, enabled: false } : p)),
  });
  expect(
    (await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 1) }))).code,
  ).toBe('provider_disabled');
  await h.settings.update({ providers });
  await h.ask(targets('claude', 1));
});

test('duplicate slot ids are refused', async () => {
  const h = createHarness();
  const error = await rejection(
    h.manager.submit({ prompt: 'hi', targets: [...targets('claude', 1), ...targets('claude', 1)] }),
  );
  expect(error.code).toBe('bad_request');
});

test('an unknown conversation is refused, an existing one continued', async () => {
  const h = createHarness();
  const error = await rejection(
    h.manager.submit({ prompt: 'hi', targets: targets('claude', 1), conversationId: 'missing' }),
  );
  expect(error.code).toBe('not_found');

  const first = await h.ask(targets('claude', 1));
  const { conversationId } = await h.manager.snapshot(first);
  const second = await h.manager.submit({
    prompt: 'more',
    targets: targets('claude', 1),
    conversationId,
  });
  expect((await h.manager.snapshot(second.askId)).conversationId).toBe(conversationId);
});

test('a rejected ask leaves nothing behind and starts nothing', async () => {
  const h = createHarness({ settings: (s) => (s.limits.maxTargetsPerAsk = 1) });
  await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 2) }));
  await rejection(h.manager.submit({ prompt: 'hi', targets: targets('nope', 1) }));
  await h.settle();
  expect((await h.storage.turns.list({ limit: 10 })).items).toEqual([]);
  expect(h.claude.runs).toHaveLength(0);
  expect(h.workDirs.created).toEqual([]);
  expect(h.clock.pendingTimers).toBe(0);
});

test('asks in flight are capped, and a finished ask makes room again', async () => {
  const h = createHarness({ script: hang, settings: (s) => (s.limits.maxAsksInFlight = 2) });
  const first = await h.ask(targets('claude', 1));
  await h.ask(targets('codex', 1));
  const error = await rejection(h.manager.submit({ prompt: 'hi', targets: targets('grok', 1) }));
  expect([error.code, error.status]).toEqual(['too_many_asks', 429]);

  await h.manager.cancel(first);
  await h.ask(targets('grok', 1));
});

test('submissions made at the same moment cannot exceed the cap together', async () => {
  const h = createHarness({ script: hang, settings: (s) => (s.limits.maxAsksInFlight = 2) });
  const results = await Promise.allSettled(
    ['claude', 'codex', 'grok'].map((providerId) =>
      h.manager.submit({ prompt: 'hi', targets: targets(providerId, 1) }),
    ),
  );
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ code: 'too_many_asks' });
});

test('the queue limit counts only the slots that would have to wait', async () => {
  // claude admits two at a time.
  const h = createHarness({
    script: hang,
    settings: (s) => {
      s.limits.maxQueuedSlots = 3;
      s.limits.maxAsksInFlight = 8;
    },
  });
  await h.ask(targets('claude', 4)); // 2 run, 2 wait
  const full = await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 2) }));
  expect([full.code, full.status]).toEqual(['queue_full', 429]);

  await h.ask(targets('claude', 1)); // 3 wait: exactly the limit
  await h.ask(targets('codex', 2)); // nothing waits at codex
  const mixed = await rejection(
    h.manager.submit({ prompt: 'hi', targets: [...targets('grok', 2), ...targets('codex', 1)] }),
  );
  expect(mixed.code).toBe('queue_full');
});

test('a cancelled queued slot gives its place in the queue back', async () => {
  const h = createHarness({ script: hang, settings: (s) => (s.limits.maxQueuedSlots = 1) });
  const askId = await h.ask(targets('claude', 3));
  expect(
    (await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 1) }))).code,
  ).toBe('queue_full');
  await h.manager.cancel(askId, 'c3');
  await h.ask(targets('claude', 1));
});

test('limits changed in settings apply to the next ask', async () => {
  const h = createHarness();
  await h.settings.update({ limits: { maxTargetsPerAsk: 1 } });
  expect(
    (await rejection(h.manager.submit({ prompt: 'hi', targets: targets('claude', 2) }))).code,
  ).toBe('too_many_targets');
  await h.settings.update({ limits: { maxTargetsPerAsk: 2 } });
  await h.ask(targets('claude', 2));
});

test('an ask that cannot be stored is rejected and never runs; the next one works', async () => {
  const storage = createFakeStorage();
  let fail = true;
  const failing: Storage = {
    ...storage,
    turns: {
      ...storage.turns,
      create: async (snapshot) => {
        if (fail) throw new Error('database is locked');
        return storage.turns.create(snapshot);
      },
    },
  };
  const h = createHarness({ storage: failing, script: answerScript(['ok']) });
  await expect(h.manager.submit({ prompt: 'hi', targets: targets('claude', 1) })).rejects.toThrow(
    'database is locked',
  );
  await h.settle();
  expect(h.claude.runs).toHaveLength(0);

  fail = false;
  const askId = await h.ask(targets('claude', 1));
  expect((await h.manager.snapshot(askId)).status).toBe('done');
});
