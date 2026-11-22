import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { ProviderAdapter, ProviderEvent, RunRequest } from '../contracts/index.ts';
import type {
  ProviderInstance,
  ExecutedProviderKind,
  Settings,
  StreamEvent,
} from '../protocol/index.ts';
import { answerScript, READY_DETECTION } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, targets } from './test-harness.ts';
import type { Harness } from './test-harness.ts';

const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];
const one = targets('claude', 1);
const slot = { slotId: 'c1', providerId: 'claude' };

/** An adapter whose `run` is the given function; what it returns need not honour the contract. */
function adapter(
  run: (instance: ProviderInstance, request: RunRequest) => unknown,
  kind: ExecutedProviderKind = 'claude',
): ProviderAdapter {
  return {
    kind,
    toolAccess: 'none',
    detect: async () => READY_DETECTION,
    run: run as ProviderAdapter['run'],
  };
}

/** Yields the given values, whatever they are. */
const yielding = (values: unknown[]): ProviderAdapter =>
  adapter(async function* () {
    yield* values;
  });

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

const types = (events: StreamEvent[]): string[] => events.map((event) => event.type);

async function onlySlot(h: Harness, askId: string) {
  return (await h.manager.snapshot(askId)).slots[0]!;
}

const withLimits =
  (limits: Partial<Settings['limits']>) =>
  (settings: Settings): void => {
    Object.assign(settings.limits, limits);
  };

// ---- event mapping ----

test('provider events become stream events with consecutive seq and the slot identity', async () => {
  const h = createHarness({
    script: [
      { event: { type: 'start', streaming: 'block' } },
      { event: { type: 'reasoning', text: 'Let me think. ' }, delayMs: 10 },
      { event: { type: 'delta', text: 'Hel' }, delayMs: 10 },
      { event: { type: 'notice', message: 'A tool call was denied' } },
      { event: { type: 'delta', text: 'lo' }, delayMs: 10 },
      {
        event: { type: 'done', elapsedMs: 1234.4, usage: { inputTokens: 3, outputTokens: 2 } },
        delayMs: 10,
      },
    ],
  });
  const startedAt = h.clock.now();
  const askId = await h.ask(one);
  await h.clock.advance(100);

  expect(await h.events(askId)).toEqual([
    { type: 'start', seq: 1, ...slot, at: startedAt, streaming: 'block' },
    { type: 'reasoning', seq: 2, ...slot, text: 'Let me think. ' },
    { type: 'delta', seq: 3, ...slot, text: 'Hel' },
    { type: 'notice', seq: 4, ...slot, code: 'provider', message: 'A tool call was denied' },
    { type: 'delta', seq: 5, ...slot, text: 'lo' },
    { type: 'done', seq: 6, ...slot, elapsedMs: 1234, usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'ask_done', seq: 7 },
  ]);
  expect(await h.manager.snapshot(askId)).toMatchObject({
    status: 'done',
    seq: 7,
    slots: [
      {
        status: 'done',
        streaming: 'block',
        startedAt,
        text: 'Hello',
        reasoning: 'Let me think. ',
        notices: [{ code: 'provider', message: 'A tool call was denied' }],
        truncated: false,
        usage: { inputTokens: 3, outputTokens: 2 },
        elapsedMs: 1234,
      },
    ],
  });
});

test('the streaming mode falls back to the cached detection, then to unknown', async () => {
  const h = createHarness();
  const before = await h.ask(one);
  expect((await onlySlot(h, before)).streaming).toBe('unknown');

  h.claude.detection = { ...READY_DETECTION, streaming: 'block' };
  await h.providers.refresh('claude');
  const after = await h.ask(one);
  expect((await onlySlot(h, after)).streaming).toBe('block');
});

test('a provider error ends the slot as error with its code and the measured time', async () => {
  const h = createHarness({
    script: [
      { event: { type: 'start' } },
      { event: { type: 'delta', text: 'partial' }, delayMs: 20 },
      { event: { type: 'error', code: 'quota', message: 'Usage limit reached' }, delayMs: 30 },
    ],
  });
  const askId = await h.ask(one);
  await h.clock.advance(50);

  const events = await h.events(askId);
  expect(types(events)).toEqual(['start', 'delta', 'error', 'ask_done']);
  expect(events[2]).toMatchObject({ code: 'quota', message: 'Usage limit reached', elapsedMs: 50 });
  expect(await onlySlot(h, askId)).toMatchObject({
    status: 'error',
    text: 'partial',
    error: { code: 'quota', message: 'Usage limit reached' },
    elapsedMs: 50,
  });
});

test('a provider that fails before starting takes the slot from queued straight to error', async () => {
  const h = createHarness({
    script: [{ event: { type: 'error', code: 'not_logged_in', message: 'Run the login command' } }],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['error', 'ask_done']);
  const result = await onlySlot(h, askId);
  expect(result).toMatchObject({ status: 'error', error: { code: 'not_logged_in' } });
  expect(result).not.toHaveProperty('startedAt');
});

// ---- timeout ----

test('a slot that outlives the configured timeout ends as timeout and its provider is stopped', async () => {
  const h = createHarness({ script: hang, settings: withLimits({ slotTimeoutMs: 5000 }) });
  const askId = await h.ask(targets('claude', 3));
  await h.clock.advance(4999);
  expect((await onlySlot(h, askId)).status).toBe('running');
  expect(h.claude.active).toBe(2);
  const firstDir = h.claude.runs[0]!.request.workDir;

  await h.clock.advance(1);
  const snapshot = await h.manager.snapshot(askId);
  expect(snapshot.slots.map((s) => s.status)).toEqual(['timeout', 'timeout', 'running']);
  expect(snapshot.slots[0]).toMatchObject({ elapsedMs: 5000 });
  expect(snapshot.slots[0]).not.toHaveProperty('error');
  expect(h.claude.runs[0]!.request.signal.aborted).toBe(true);
  expect(h.workDirs.existing.has(firstDir)).toBe(false);
  // The freed permit went to the queued slot, whose own clock starts now.
  expect(h.claude.active).toBe(1);

  await h.clock.advance(5000);
  const events = await h.events(askId);
  expect(types(events)).toEqual([
    'queued',
    'start',
    'start',
    'timeout',
    'start',
    'timeout',
    'timeout',
    'ask_done',
  ]);
  expect(h.claude.active).toBe(0);
  expect(h.clock.pendingTimers).toBe(0);
});

test('a slot that finishes in time leaves no timeout behind', async () => {
  const h = createHarness({ script: answerScript(['ok'], 10) });
  const askId = await h.ask(one);
  await h.clock.advance(20);
  expect(h.clock.pendingTimers).toBe(0);
  await h.clock.advance(3_600_000);
  expect(types(await h.events(askId))).toEqual(['start', 'delta', 'done', 'ask_done']);
});

test('a changed timeout applies to slots admitted afterwards', async () => {
  const h = createHarness({ script: hang, settings: withLimits({ slotTimeoutMs: 5000 }) });
  const first = await h.ask(one);
  await h.settings.update({ limits: { slotTimeoutMs: 60_000 } });
  const second = await h.ask(one);

  await h.clock.advance(5000);
  expect((await onlySlot(h, first)).status).toBe('timeout');
  expect((await onlySlot(h, second)).status).toBe('running');
  expect(h.claude.runs.map((run) => run.request.timeoutMs)).toEqual([5000, 60_000]);
  await h.clock.advance(55_000);
  expect((await onlySlot(h, second)).status).toBe('timeout');
});

// ---- cancel ----

test('a queued slot is cancelled without ever reaching its provider', async () => {
  const h = createHarness({ script: hang });
  const askId = await h.ask(targets('claude', 3));
  expect(await h.manager.cancel(askId, 'c3')).toEqual(['c3']);

  const snapshot = await h.manager.snapshot(askId);
  expect(snapshot.slots.map((s) => s.status)).toEqual(['running', 'running', 'cancelled']);
  expect(snapshot.slots[2]).toMatchObject({ elapsedMs: 0, text: '' });
  expect(snapshot.status).toBe('running');

  await h.manager.cancel(askId);
  await h.settle();
  expect(h.claude.runs).toHaveLength(2);
  expect(h.workDirs.created).toHaveLength(2);
});

test('a running slot is cancelled at once, its provider aborted and its permit passed on', async () => {
  const h = createHarness({ script: hang });
  const askId = await h.ask(targets('claude', 3));
  await h.clock.advance(700);

  expect(await h.manager.cancel(askId, 'c1')).toEqual(['c1']);
  expect(await onlySlot(h, askId)).toMatchObject({ status: 'cancelled', elapsedMs: 700 });
  expect(h.claude.runs[0]!.request.signal.aborted).toBe(true);
  expect(h.claude.runs[1]!.request.signal.aborted).toBe(false);

  await h.settle();
  expect(h.workDirs.existing.has(h.claude.runs[0]!.request.workDir)).toBe(false);
  expect(h.claude.runs).toHaveLength(3);
  expect((await h.manager.snapshot(askId)).slots.map((s) => s.status)).toEqual([
    'cancelled',
    'running',
    'running',
  ]);
});

test('cancelling an ask ends its queued and running slots and the ask itself', async () => {
  const h = createHarness({ script: hang });
  const askId = await h.ask([...targets('claude', 3), ...targets('codex', 1, 'x')]);
  const other = await h.ask(targets('grok', 1));

  expect(await h.manager.cancel(askId)).toEqual(['c1', 'c2', 'c3', 'x1']);
  await h.settle();
  const events = await h.events(askId);
  expect(types(events)).toEqual([
    'queued',
    'start',
    'start',
    'start',
    'cancelled',
    'cancelled',
    'cancelled',
    'cancelled',
    'ask_done',
  ]);
  expect((await h.manager.snapshot(askId)).status).toBe('done');
  expect(h.claude.active + h.codex.active).toBe(0);
  expect(h.claude.runs).toHaveLength(2);
  expect((await onlySlot(h, other)).status).toBe('running');
  expect(h.grok.active).toBe(1);
});

test('cancel is idempotent and reports only what was still unfinished', async () => {
  const h = createHarness({
    script: (request) => (request.model === 'quick' ? answerScript(['ok']) : hang),
  });
  const askId = await h.ask([
    { slotId: 'quick', providerId: 'claude', model: 'quick' },
    { slotId: 'slow', providerId: 'claude' },
  ]);
  expect(await h.manager.cancel(askId, 'quick')).toEqual([]);
  expect(await h.manager.cancel(askId, 'no-such-slot')).toEqual([]);
  expect(await h.manager.cancel(askId, 'slow')).toEqual(['slow']);
  expect(await h.manager.cancel(askId, 'slow')).toEqual([]);
  expect(await h.manager.cancel(askId)).toEqual([]);
  await h.settle();

  const events = await h.events(askId);
  expect(events.filter((event) => event.type === 'cancelled')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'ask_done')).toHaveLength(1);
  expect((await h.manager.snapshot(askId)).slots.map((s) => s.status)).toEqual([
    'done',
    'cancelled',
  ]);
});

test('cancelling an unknown ask is not_found', async () => {
  const h = createHarness();
  await expect(h.manager.cancel('missing')).rejects.toMatchObject({ code: 'not_found' });
});

test('a cancel that races the provider result keeps whichever came first', async () => {
  const h = createHarness({ script: answerScript(['ok'], 10) });
  const askId = await h.ask(one);
  await h.clock.advance(20);
  expect(await h.manager.cancel(askId)).toEqual([]);
  expect((await onlySlot(h, askId)).status).toBe('done');

  const second = await h.ask(one);
  await h.clock.advance(10);
  expect(await h.manager.cancel(second)).toEqual(['c1']);
  await h.clock.advance(100);
  expect(types(await h.events(second))).toEqual(['start', 'delta', 'cancelled', 'ask_done']);
});

// ---- output limit ----

const LIMIT = 16 * 1024;

test('output beyond the limit is cut at the limit, flagged once, and the provider still finishes', async () => {
  const h = createHarness({
    settings: withLimits({ maxOutputBytesPerSlot: LIMIT }),
    script: [
      { event: { type: 'start' } },
      { event: { type: 'delta', text: 'a'.repeat(10_000) } },
      { event: { type: 'reasoning', text: 'b'.repeat(6000) } },
      { event: { type: 'delta', text: 'c'.repeat(1000) }, delayMs: 10 },
      { event: { type: 'delta', text: 'more answer' }, delayMs: 10 },
      { event: { type: 'reasoning', text: 'more reasoning' } },
      { event: { type: 'notice', message: 'still reported' } },
      { event: { type: 'done', elapsedMs: 40, usage: { outputTokens: 9000 } }, delayMs: 10 },
    ],
  });
  const askId = await h.ask(one);
  await h.clock.advance(10);
  expect(h.claude.runs[0]!.request.signal.aborted).toBe(false);
  expect(await onlySlot(h, askId)).toMatchObject({ status: 'running', truncated: true });

  await h.clock.advance(20);
  const events = await h.events(askId);
  expect(types(events)).toEqual([
    'start',
    'delta',
    'reasoning',
    'delta',
    'notice',
    'notice',
    'done',
    'ask_done',
  ]);
  const result = await onlySlot(h, askId);
  expect(result.text).toBe('a'.repeat(10_000) + 'c'.repeat(384));
  expect(result.reasoning).toBe('b'.repeat(6000));
  expect(result).toMatchObject({
    status: 'done',
    truncated: true,
    usage: { outputTokens: 9000 },
    notices: [{ code: 'output_truncated' }, { code: 'provider', message: 'still reported' }],
  });
  expect(result.notices[0]!.message).toContain(String(LIMIT));
});

test('output of exactly the limit is not truncated; one more byte is', async () => {
  const exact = createHarness({
    settings: withLimits({ maxOutputBytesPerSlot: LIMIT }),
    script: answerScript(['a'.repeat(LIMIT)]),
  });
  const fits = await exact.ask(one);
  expect(await onlySlot(exact, fits)).toMatchObject({ truncated: false, notices: [] });

  const over = createHarness({
    settings: withLimits({ maxOutputBytesPerSlot: LIMIT }),
    script: answerScript(['a'.repeat(LIMIT), 'x', 'y']),
  });
  const cut = await over.ask(one);
  const result = await onlySlot(over, cut);
  expect(result.text).toBe('a'.repeat(LIMIT));
  expect(result.truncated).toBe(true);
  expect(types(await over.events(cut))).toEqual(['start', 'delta', 'notice', 'done', 'ask_done']);
});

test('truncation counts bytes and never splits a character', async () => {
  const h = createHarness({
    settings: withLimits({ maxOutputBytesPerSlot: LIMIT }),
    script: answerScript(['a'.repeat(LIMIT - 5), '漢😀漢']),
  });
  const askId = await h.ask(one);
  const result = await onlySlot(h, askId);
  // Five bytes of room: the three-byte character fits, the four-byte one after it does not.
  expect(result.text).toBe('a'.repeat(LIMIT - 5) + '漢');
  expect(result.truncated).toBe(true);
});

// ---- adapters that break the contract ----

test('an adapter that throws when started ends the slot as error', async () => {
  const h = createHarness({
    adapters: [
      adapter(() => {
        throw new Error('spawn /home/someone/bin/tool ENOENT');
      }),
    ],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['error', 'ask_done']);
  expect((await onlySlot(h, askId)).error).toEqual({
    code: 'unknown',
    message: 'The provider adapter failed unexpectedly.',
  });
  expect(JSON.stringify(h.logger.entries)).not.toContain('/home/someone');
  expect(h.workDirs.existing.size).toBe(0);
});

test('an adapter whose iteration fails midway keeps the text so far and ends as error', async () => {
  const h = createHarness({
    adapters: [
      adapter(async function* (): AsyncGenerator<ProviderEvent> {
        yield { type: 'start' };
        yield { type: 'delta', text: 'half an ans' };
        throw new Error('pipe broke');
      }),
    ],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['start', 'delta', 'error', 'ask_done']);
  expect(await onlySlot(h, askId)).toMatchObject({
    status: 'error',
    text: 'half an ans',
    error: { code: 'unknown' },
  });
});

test('an adapter that rejects with something that is not an error is handled the same', async () => {
  const h = createHarness({
    adapters: [
      adapter(() => ({
        [Symbol.asyncIterator]: () => ({
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the misbehaviour under test
          next: () => Promise.reject('no'),
        }),
      })),
    ],
  });
  const askId = await h.ask(one);
  expect((await onlySlot(h, askId)).error?.code).toBe('unknown');
});

test.each([undefined, null, 42, {}, { [Symbol.asyncIterator]: () => null }])(
  'an adapter that returns %j instead of an iteration ends the slot as error',
  async (returned) => {
    const h = createHarness({ adapters: [adapter(() => returned)] });
    const askId = await h.ask(one);
    expect(types(await h.events(askId))).toEqual(['error', 'ask_done']);
    expect(h.workDirs.existing.size).toBe(0);
  },
);

test('whatever an adapter yields after its result is ignored', async () => {
  const h = createHarness({
    script: [
      { event: { type: 'start' } },
      { event: { type: 'delta', text: 'answer' } },
      { event: { type: 'done', elapsedMs: 5 } },
      { event: { type: 'delta', text: ' and more' } },
      { event: { type: 'error', code: 'unknown', message: 'late failure' } },
      { event: { type: 'done', elapsedMs: 6 } },
    ],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['start', 'delta', 'done', 'ask_done']);
  expect(await onlySlot(h, askId)).toMatchObject({ status: 'done', text: 'answer', elapsedMs: 5 });
  expect(h.claude.active).toBe(0);
});

test('an adapter that ends without a result ends the slot as bad_output', async () => {
  const h = createHarness({
    script: [{ event: { type: 'start' } }, { event: { type: 'delta', text: 'cut off' } }],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['start', 'delta', 'error', 'ask_done']);
  expect(await onlySlot(h, askId)).toMatchObject({
    status: 'error',
    text: 'cut off',
    error: { code: 'bad_output', message: 'The provider ended without a result.' },
  });
});

test('an adapter that yields nothing at all ends the slot as bad_output', async () => {
  const h = createHarness({ script: [] });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['error', 'ask_done']);
});

test('garbage between valid events is ignored and logged once', async () => {
  const h = createHarness({
    adapters: [
      yielding([
        null,
        42,
        'delta',
        { type: 'tool_call', name: 'shell' },
        { type: 'delta' },
        { type: 'start', streaming: 'token' },
        { type: 'delta', text: 7 },
        { type: 'delta', text: 'fine' },
        { type: 'delta', text: '' },
        { type: 'done', elapsedMs: 'soon', usage: { inputTokens: -4 } },
      ]),
    ],
  });
  const askId = await h.ask(one);
  const events = await h.events(askId);
  expect(types(events)).toEqual(['start', 'delta', 'done', 'ask_done']);
  const result = await onlySlot(h, askId);
  expect(result).toMatchObject({ status: 'done', text: 'fine', elapsedMs: 0 });
  expect(result).not.toHaveProperty('usage');
  expect(h.logger.entries.filter((entry) => entry.message.includes('malformed'))).toHaveLength(1);
});

test('text before a start event starts the slot; a second start is ignored', async () => {
  const h = createHarness({
    adapters: [
      yielding([
        { type: 'delta', text: 'early' },
        { type: 'start', streaming: 'block' },
        { type: 'start', streaming: 'token' },
        { type: 'done', elapsedMs: 1 },
      ]),
    ],
  });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['start', 'delta', 'done', 'ask_done']);
  expect(await onlySlot(h, askId)).toMatchObject({ streaming: 'unknown', text: 'early' });
});

test('a result without a start still starts the slot', async () => {
  const h = createHarness({ adapters: [yielding([{ type: 'done', elapsedMs: 3 }])] });
  const askId = await h.ask(one);
  expect(types(await h.events(askId))).toEqual(['start', 'done', 'ask_done']);
  expect(await onlySlot(h, askId)).toHaveProperty('startedAt');
});

test('an error with an unknown code or no message is reported as unknown', async () => {
  const h = createHarness({ adapters: [yielding([{ type: 'error', code: 'exploded' }])] });
  const askId = await h.ask(one);
  expect((await onlySlot(h, askId)).error).toEqual({
    code: 'unknown',
    message: 'The provider reported an error',
  });
});

test('notices are capped in number and length', async () => {
  const h = createHarness({
    tuning: { maxNoticesPerSlot: 3 },
    adapters: [
      yielding([
        { type: 'start' },
        { type: 'notice', message: 'n'.repeat(5000) },
        ...Array.from({ length: 10 }, (_, index) => ({
          type: 'notice',
          message: `notice ${index}`,
        })),
        { type: 'error', code: 'network', message: 'e'.repeat(5000) },
      ]),
    ],
  });
  const askId = await h.ask(one);
  const result = await onlySlot(h, askId);
  expect(result.notices.map((notice) => notice.message.length)).toEqual([2000, 8, 8]);
  expect(result.error?.message).toHaveLength(2000);
});

test('events an adapter yields after it was aborted are ignored', async () => {
  const h = createHarness({
    adapters: [
      adapter(async function* (_instance, request): AsyncGenerator<ProviderEvent> {
        yield { type: 'start' };
        await aborted(request.signal);
        yield { type: 'delta', text: 'too late' };
        yield { type: 'error', code: 'cancelled', message: 'killed' };
      }),
    ],
  });
  const askId = await h.ask(one);
  await h.manager.cancel(askId);
  await h.settle();
  expect(types(await h.events(askId))).toEqual(['start', 'cancelled', 'ask_done']);
  expect(await onlySlot(h, askId)).toMatchObject({ status: 'cancelled', text: '' });
});

test('an event that arrives in the same tick as the cancel is not emitted after it', async () => {
  let deliver: ((result: IteratorResult<ProviderEvent>) => void) | undefined;
  const h = createHarness({
    adapters: [
      adapter(() => {
        let calls = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              calls++ === 0
                ? Promise.resolve({ done: false, value: { type: 'start' } })
                : new Promise<IteratorResult<ProviderEvent>>((resolve) => (deliver = resolve)),
            return: async () => ({ done: true, value: undefined }),
          }),
        };
      }),
    ],
  });
  const askId = await h.ask(one);

  // The event is already on its way to the runner when the cancel lands.
  deliver!({ done: false, value: { type: 'delta', text: 'too late' } });
  queueMicrotask(() => void h.manager.cancel(askId));
  await h.settle();

  expect(types(await h.events(askId))).toEqual(['start', 'cancelled', 'ask_done']);
  expect(await h.manager.snapshot(askId)).toMatchObject({
    seq: 3,
    slots: [{ status: 'cancelled', text: '' }],
  });
});

test('an adapter that ignores the abort is given up on after the grace period', async () => {
  let returned = 0;
  const stuck = adapter(() => {
    let calls = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          calls++ === 0
            ? Promise.resolve({ done: false, value: { type: 'start' } })
            : new Promise<never>(() => {}),
        return: () => {
          returned++;
          return new Promise<never>(() => {});
        },
      }),
    };
  });
  const h = createHarness({
    adapters: [stuck],
    tuning: { stopGraceMs: 10_000 },
    settings: (s) => (s.providers.find((p) => p.id === 'claude')!.concurrency = 1),
  });
  const askId = await h.ask([...targets('claude', 1), ...targets('codex', 1, 'x')]);
  const next = await h.ask(targets('claude', 1), 'next');

  // The user sees the cancellation at once, and the ask is done.
  expect(await h.manager.cancel(askId, 'c1')).toEqual(['c1']);
  await h.settle();
  expect((await h.manager.snapshot(askId)).status).toBe('done');
  expect(returned).toBe(1);

  // The permit and the work dir stay taken while the provider may still be alive.
  await h.clock.advance(9999);
  expect((await onlySlot(h, next)).status).toBe('queued');
  expect(h.workDirs.existing.size).toBe(1);

  await h.clock.advance(1);
  expect((await onlySlot(h, next)).status).toBe('running');
  expect(
    h.logger.entries.some((entry) => entry.level === 'warn' && /did not stop/.test(entry.message)),
  ).toBe(true);
  await h.manager.cancel(next);
  await h.clock.advance(10_000);
  expect(h.workDirs.existing.size).toBe(0);
  expect(h.clock.pendingTimers).toBe(0);
});

test('an adapter that never ends is stopped by the timeout', async () => {
  const h = createHarness({
    settings: withLimits({ slotTimeoutMs: 5000 }),
    adapters: [
      adapter(async function* (_instance, request): AsyncGenerator<ProviderEvent> {
        yield { type: 'start' };
        for (;;) {
          yield { type: 'delta', text: '.' };
          await new Promise<void>((resolve) => h.clock.schedule(1000, resolve));
          if (request.signal.aborted) return;
        }
      }),
    ],
  });
  const askId = await h.ask(one);
  await h.clock.advance(6000);
  const result = await onlySlot(h, askId);
  expect(result).toMatchObject({ status: 'timeout', text: '.....', elapsedMs: 5000 });
  expect((await h.manager.snapshot(askId)).status).toBe('done');
  expect(h.clock.pendingTimers).toBe(0);
});

// ---- work directories ----

test('every slot gets its own work dir, which is gone once the slot ended, however it ended', async () => {
  const h = createHarness({
    settings: withLimits({ slotTimeoutMs: 5000 }),
    script: (request) => {
      switch (request.model) {
        case 'error':
          return [{ event: { type: 'error', code: 'network', message: 'offline' } }];
        case 'hang':
          return hang;
        default:
          return answerScript(['ok']);
      }
    },
  });
  const askId = await h.ask([
    { slotId: 'ok', providerId: 'claude' },
    { slotId: 'error', providerId: 'codex', model: 'error' },
    { slotId: 'cancel', providerId: 'grok', model: 'hang' },
    { slotId: 'timeout', providerId: 'grok', model: 'hang' },
  ]);
  expect(new Set(h.workDirs.created).size).toBe(4);
  expect(h.workDirs.existing.size).toBe(2);

  await h.manager.cancel(askId, 'cancel');
  await h.settle();
  expect(h.workDirs.existing.size).toBe(1);
  await h.clock.advance(5000);
  expect(h.workDirs.existing.size).toBe(0);
  expect((await h.manager.snapshot(askId)).slots.map((s) => s.status)).toEqual([
    'done',
    'error',
    'cancelled',
    'timeout',
  ]);
});

test('a slot whose work dir cannot be created fails as spawn_failed and frees its permit', async () => {
  const h = createHarness();
  h.workDirs.failCreate = true;
  const askId = await h.ask(targets('claude', 3));
  expect(types(await h.events(askId))).toEqual(['queued', 'error', 'error', 'error', 'ask_done']);
  expect((await onlySlot(h, askId)).error?.code).toBe('spawn_failed');
  expect(h.claude.runs).toHaveLength(0);

  h.workDirs.failCreate = false;
  const next = await h.ask(one);
  expect((await onlySlot(h, next)).status).toBe('done');
});

test('on a real file system the work dir exists and is empty during the run and is removed after it', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'runner-')), 'work');
  try {
    await mkdir(join(root, 'left-by-a-crash'), { recursive: true });
    await writeFile(join(root, 'left-by-a-crash', 'prompt.txt'), 'old');
    const seen: { dir: string; entries: string[] }[] = [];
    const h = createHarness({
      workRoot: root,
      adapters: [
        adapter(async function* (_instance, request): AsyncGenerator<ProviderEvent> {
          seen.push({ dir: request.workDir, entries: await readdir(request.workDir) });
          await writeFile(join(request.workDir, 'prompt.txt'), request.prompt);
          yield { type: 'start' };
          yield { type: 'done', elapsedMs: 1 };
        }),
      ],
    });
    await h.manager.start();
    expect(await readdir(root)).toEqual([]);

    const { askId } = await h.manager.submit({ prompt: 'hi', targets: targets('claude', 2) });
    await vi.waitFor(async () => expect((await h.manager.snapshot(askId)).status).toBe('done'), {
      interval: 1,
    });
    await h.manager.shutdown();

    expect(seen).toHaveLength(2);
    expect(seen[0]!.dir).not.toBe(seen[1]!.dir);
    for (const { dir, entries } of seen) {
      expect(dir.startsWith(root)).toBe(true);
      expect(entries).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    }
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(join(root, '..'), { recursive: true, force: true });
  }
});
