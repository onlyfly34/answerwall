import { Buffer } from 'node:buffer';
import { describe, expect, test } from 'vitest';
import { AppError } from '../contracts/index.ts';
import type { AuthContext } from '../contracts/index.ts';
import { API_PATHS, AskSnapshotSchema, WebResultResponseSchema } from '../protocol/index.ts';
import type { AskTarget, Settings, WebResultRequest } from '../protocol/index.ts';
import { createTestApp } from '../testing/index.ts';
import type { ScriptStep } from '../testing/index.ts';
import { createHarness, fold } from './test-harness.ts';
import type { Harness, HarnessOptions } from './test-harness.ts';

const OWNER: AuthContext = { kind: 'device', deviceId: 'extension' };
const OTHER: AuthContext = { kind: 'device', deviceId: 'phone' };

/** Web cells switched on, with the web providers of two sites. */
function withWebCells(change: (settings: Settings) => void = () => undefined) {
  return (settings: Settings): void => {
    settings.webCells = { enabled: true, fillPrompt: true, readAnswer: true, extensionIds: [] };
    for (const site of ['claude', 'chatgpt'] as const) {
      settings.providers.push({
        id: `web-${site}`,
        kind: 'web',
        site,
        label: `${site} (web)`,
        enabled: true,
        concurrency: 2,
        models: [],
      });
    }
    change(settings);
  };
}

const web = (slotId = 'w1', providerId = 'web-claude'): AskTarget => ({ slotId, providerId });

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof AppError)) throw new Error('expected an AppError');
  return error;
}

function setup(options: HarnessOptions = {}): Harness {
  return createHarness({ ...options, settings: withWebCells(options.settings) });
}

async function ask(h: Harness, targets: AskTarget[] = [web()], owner: AuthContext = OWNER) {
  const { askId } = await h.manager.submit(
    { prompt: 'What is 2 + 2?', targets, runsWebSlots: true },
    owner,
  );
  await h.settle();
  return askId;
}

const slotOf = async (h: Harness, askId: string, slotId = 'w1') =>
  (await h.manager.snapshot(askId)).slots.find((slot) => slot.slotId === slotId)!;

describe('creating an ask with a web slot', () => {
  test('the slot is recorded as running at once, and nothing is executed for it', async () => {
    const h = setup();
    const askId = await ask(h);

    expect(await slotOf(h, askId)).toMatchObject({
      slotId: 'w1',
      providerId: 'web-claude',
      kind: 'web',
      status: 'running',
      streaming: 'block',
      startedAt: h.clock.now(),
      text: '',
    });
    expect(h.workDirs.created).toEqual([]);
    for (const adapter of [h.claude, h.codex, h.grok, h.compat]) expect(adapter.runs).toEqual([]);
    expect((await h.storage.turns.get(askId))?.slots[0]).toMatchObject({ kind: 'web' });
  });

  test('a model or effort named for a web slot is not recorded: the site chooses', async () => {
    const h = setup();
    const askId = await ask(h, [{ ...web(), model: 'opus', effort: 'high' }]);

    const slot = await slotOf(h, askId);
    expect(slot).not.toHaveProperty('model');
    expect(slot).not.toHaveProperty('effort');
  });

  test('a client that does not declare it runs web slots is refused', async () => {
    const h = setup();
    const error = await rejection(
      h.manager.submit(
        { prompt: 'hi', targets: [web(), { slotId: 'c', providerId: 'claude' }] },
        OWNER,
      ),
    );

    expect(error.code).toBe('web_client_required');
    expect(error.status).toBe(400);
    expect(h.claude.runs).toEqual([]);
  });

  test('so is a declaration without a known caller', async () => {
    const h = setup();
    const error = await rejection(
      h.manager.submit({ prompt: 'hi', targets: [web()], runsWebSlots: true }),
    );
    expect(error.code).toBe('web_client_required');
  });

  test.each([
    ['web cells', (settings: Settings) => void (settings.webCells.enabled = false)],
    ['reading answers', (settings: Settings) => void (settings.webCells.readAnswer = false)],
    [
      'the provider',
      (settings: Settings) =>
        void (settings.providers.find((provider) => provider.id === 'web-claude')!.enabled = false),
    ],
  ])('with %s switched off it is refused as a disabled provider', async (_label, change) => {
    const h = setup({ settings: change });
    const error = await rejection(
      h.manager.submit({ prompt: 'hi', targets: [web()], runsWebSlots: true }, OWNER),
    );
    expect(error.code).toBe('provider_disabled');
  });

  test("filling in the prompt is the client's business: off, the slot is still accepted", async () => {
    const h = setup({ settings: (settings) => void (settings.webCells.fillPrompt = false) });
    const askId = await ask(h);
    expect((await slotOf(h, askId)).status).toBe('running');
  });

  test('declaring web slots changes nothing for an ask without one', async () => {
    const h = setup();
    const askId = await ask(h, [{ slotId: 'c', providerId: 'claude' }]);
    expect(await slotOf(h, askId, 'c')).toMatchObject({ status: 'done', text: 'ok' });
  });

  test('the concurrency of a web provider queues further slots like any other provider', async () => {
    const h = setup();
    const askId = await ask(h, [web('w1'), web('w2'), web('w3'), web('x1', 'web-chatgpt')]);

    const statuses = async () =>
      Object.fromEntries(
        (await h.manager.snapshot(askId)).slots.map((slot) => [slot.slotId, slot.status]),
      );
    expect(await statuses()).toEqual({ w1: 'running', w2: 'running', w3: 'queued', x1: 'running' });

    await h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'one' }, OWNER);
    await h.settle();
    expect(await statuses()).toEqual({ w1: 'done', w2: 'running', w3: 'running', x1: 'running' });
  });
});

describe('the result of a web slot', () => {
  test('an answer is stored, streamed with the normal events, and ends the ask', async () => {
    const h = setup();
    const askId = await ask(h);
    const initial = await h.manager.snapshot(askId);
    await h.clock.advance(1500);

    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'done', text: '**Four.**' },
      OWNER,
    );
    await h.settle();

    expect(response).toEqual({ status: 'done', truncated: false });
    const events = await h.events(askId);
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'done', 'ask_done']);
    expect(events[1]).toMatchObject({ slotId: 'w1', providerId: 'web-claude', text: '**Four.**' });
    expect(events[2]).toMatchObject({ elapsedMs: 1500 });
    // A client that only followed the stream ends up with what the server stored.
    const stored = (await h.storage.turns.get(askId))!;
    expect(stored.status).toBe('done');
    expect(stored.slots[0]).toMatchObject({ status: 'done', text: '**Four.**', kind: 'web' });
    expect(fold({ ...initial, seq: 0 }, events).slots[0]?.text).toBe('**Four.**');
  });

  test('a failure ends the slot as an error with the given code', async () => {
    const h = setup();
    const askId = await ask(h);

    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'failed', code: 'not_logged_in', message: 'The site shows its sign-in page.' },
      OWNER,
    );

    expect(response).toEqual({ status: 'error', truncated: false });
    expect(await slotOf(h, askId)).toMatchObject({
      status: 'error',
      error: { code: 'not_logged_in', message: 'The site shows its sign-in page.' },
      text: '',
    });
  });

  test('a failure without a message gets one', async () => {
    const h = setup();
    const askId = await ask(h);
    await h.manager.submitWebResult(askId, 'w1', { outcome: 'failed', code: 'bad_output' }, OWNER);
    expect((await slotOf(h, askId)).error?.message).not.toBe('');
  });

  test('a cancellation ends the slot as cancelled and keeps the reason as a notice', async () => {
    const h = setup();
    const askId = await ask(h);

    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'cancelled', reason: 'The wall was closed.' },
      OWNER,
    );

    expect(response).toEqual({ status: 'cancelled', truncated: false });
    expect(await slotOf(h, askId)).toMatchObject({
      status: 'cancelled',
      notices: [{ code: 'provider', message: 'The wall was closed.' }],
    });
  });

  test('an answer beyond the output limit is cut on a character boundary and flagged', async () => {
    const limit = 16 * 1024;
    const h = setup({
      settings: (settings) => void (settings.limits.maxOutputBytesPerSlot = limit),
    });
    const askId = await ask(h);

    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'done', text: '好'.repeat(limit) },
      OWNER,
    );

    expect(response).toEqual({ status: 'done', truncated: true });
    const slot = await slotOf(h, askId);
    expect(slot.status).toBe('done');
    expect(slot.truncated).toBe(true);
    expect(Buffer.byteLength(slot.text)).toBeLessThanOrEqual(limit);
    expect(Buffer.byteLength(slot.text)).toBeGreaterThan(limit - 3);
    expect(slot.text).toMatch(/^好+$/);
    expect(slot.notices.map((notice) => notice.code)).toEqual(['output_truncated']);
  });

  test('the same result sent again is answered the same way and changes nothing', async () => {
    const h = setup();
    const askId = await ask(h);
    const result: WebResultRequest = { outcome: 'done', text: 'four' };

    const first = await h.manager.submitWebResult(askId, 'w1', result, OWNER);
    await h.settle();
    const seq = (await h.manager.snapshot(askId)).seq;
    const again = await h.manager.submitWebResult(askId, 'w1', { ...result }, OWNER);

    expect(again).toEqual(first);
    const after = await h.manager.snapshot(askId);
    expect(after.seq).toBe(seq);
    expect(after.slots[0]?.text).toBe('four');
  });

  test('a second, different result is a conflict', async () => {
    const h = setup();
    const askId = await ask(h);
    await h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'four' }, OWNER);

    for (const other of [
      { outcome: 'done', text: 'five' },
      { outcome: 'failed', code: 'unknown' },
      { outcome: 'cancelled' },
    ] satisfies WebResultRequest[]) {
      const error = await rejection(h.manager.submitWebResult(askId, 'w1', other, OWNER));
      expect(error.code).toBe('conflict');
    }
    expect((await slotOf(h, askId)).text).toBe('four');
  });

  test('only the client that created the ask may submit', async () => {
    const h = setup();
    const askId = await ask(h);

    for (const caller of [OTHER, { kind: 'static-token' }] satisfies AuthContext[]) {
      const error = await rejection(
        h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'forged' }, caller),
      );
      expect(error.code).toBe('forbidden');
    }
    expect(await slotOf(h, askId)).toMatchObject({ status: 'running', text: '' });
  });

  test('the holder of the static token owns what it created', async () => {
    const h = setup();
    const askId = await ask(h, [web()], { kind: 'static-token' });
    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'done', text: 'scripted' },
      { kind: 'static-token' },
    );
    expect(response.status).toBe('done');
  });

  test('a slot that is still queued takes no result', async () => {
    const h = setup({
      settings: (settings) =>
        void (settings.providers.find((provider) => provider.id === 'web-claude')!.concurrency = 1),
    });
    const askId = await ask(h, [web('w1'), web('w2')]);

    const error = await rejection(
      h.manager.submitWebResult(askId, 'w2', { outcome: 'done', text: 'early' }, OWNER),
    );
    expect(error.code).toBe('conflict');
    expect((await slotOf(h, askId, 'w2')).status).toBe('queued');
  });

  test('a result for a slot that is not a web cell, or does not exist, is refused', async () => {
    const hang: ScriptStep[] = [{ event: { type: 'start' } }, { hang: true }];
    const h = setup({ script: hang });
    const askId = await ask(h, [web(), { slotId: 'c', providerId: 'claude' }]);
    const result: WebResultRequest = { outcome: 'done', text: 'x' };

    expect((await rejection(h.manager.submitWebResult(askId, 'c', result, OWNER))).code).toBe(
      'bad_request',
    );
    expect((await rejection(h.manager.submitWebResult(askId, 'nope', result, OWNER))).code).toBe(
      'not_found',
    );
    expect((await rejection(h.manager.submitWebResult('nope', 'w1', result, OWNER))).code).toBe(
      'not_found',
    );
    expect((await slotOf(h, askId, 'c')).status).toBe('running');
  });

  test('an answer is refused once reading answers is switched off; a failure is still taken', async () => {
    const h = setup();
    const askId = await ask(h);
    await h.settings.update({ webCells: { readAnswer: false } });

    const error = await rejection(
      h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'four' }, OWNER),
    );
    expect(error.code).toBe('forbidden');
    expect(await slotOf(h, askId)).toMatchObject({ status: 'running', text: '' });

    const response = await h.manager.submitWebResult(
      askId,
      'w1',
      { outcome: 'cancelled', reason: 'Reading answers was switched off.' },
      OWNER,
    );
    expect(response.status).toBe('cancelled');
  });
});

describe('ending a web slot from the server side', () => {
  test('a cancel from any device cancels it, and a result after that is a conflict', async () => {
    const h = setup();
    const askId = await ask(h);

    // `cancel` takes no caller: whoever is signed in may cancel.
    expect(await h.manager.cancel(askId, 'w1')).toEqual(['w1']);
    await h.settle();

    expect((await slotOf(h, askId)).status).toBe('cancelled');
    expect((await h.manager.snapshot(askId)).status).toBe('done');
    const error = await rejection(
      h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'late' }, OWNER),
    );
    expect(error.code).toBe('conflict');
    expect((await slotOf(h, askId)).text).toBe('');
  });

  test('the slot timeout ends it, and a result after that is a conflict', async () => {
    const h = setup({ settings: (settings) => void (settings.limits.slotTimeoutMs = 60_000) });
    const askId = await ask(h);

    await h.clock.advance(59_999);
    expect((await slotOf(h, askId)).status).toBe('running');
    await h.clock.advance(1);

    expect(await slotOf(h, askId)).toMatchObject({ status: 'timeout', elapsedMs: 60_000 });
    const error = await rejection(
      h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'late' }, OWNER),
    );
    expect(error.code).toBe('conflict');
  });

  test('a result in time disarms the timeout', async () => {
    const h = setup({ settings: (settings) => void (settings.limits.slotTimeoutMs = 60_000) });
    const askId = await ask(h);
    await h.manager.submitWebResult(askId, 'w1', { outcome: 'done', text: 'four' }, OWNER);

    await h.clock.advance(120_000);

    expect((await slotOf(h, askId)).status).toBe('done');
    expect((await h.events(askId)).map((event) => event.type)).toEqual([
      'start',
      'delta',
      'done',
      'ask_done',
    ]);
  });

  test('shutdown fails a running web slot like any other and does not hang', async () => {
    const h = setup();
    const askId = await ask(h);

    await h.manager.shutdown();

    expect((await h.storage.turns.get(askId))?.slots[0]).toMatchObject({
      status: 'error',
      error: { code: 'unknown', message: 'server restarted' },
    });
  });

  test('a web provider disabled while its slot waits fails the slot when its turn comes', async () => {
    const h = setup({
      settings: (settings) =>
        void (settings.providers.find((provider) => provider.id === 'web-claude')!.concurrency = 1),
    });
    const askId = await ask(h, [web('w1'), web('w2')]);
    const providers = h.settings
      .get()
      .providers.map((provider) =>
        provider.id === 'web-claude' ? { ...provider, enabled: false } : provider,
      );
    await h.settings.update({ providers });
    await h.settle();

    expect(await slotOf(h, askId, 'w2')).toMatchObject({
      status: 'error',
      error: { code: 'unsupported' },
    });
  });

  test('once the ask has left memory a result is a conflict, not an error of the server', async () => {
    const h = setup({ tuning: { finishedAsksRetained: 1 } });
    const first = await ask(h);
    await h.manager.submitWebResult(first, 'w1', { outcome: 'done', text: 'one' }, OWNER);
    await h.settle();
    const second = await ask(h);
    await h.manager.submitWebResult(second, 'w1', { outcome: 'done', text: 'two' }, OWNER);
    await h.settle();

    const error = await rejection(
      h.manager.submitWebResult(first, 'w1', { outcome: 'done', text: 'one' }, OWNER),
    );
    expect(error.code).toBe('conflict');
  });
});

describe('over HTTP', () => {
  function app() {
    const h = setup();
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

  test('the client that created the ask submits the result of its web slot', async () => {
    const { h, t } = app();
    const created = await t.request('POST', API_PATHS.ask, {
      prompt: 'What is 2 + 2?',
      targets: [web()],
      runsWebSlots: true,
    });
    expect(created.status).toBe(200);
    const { askId } = (await created.json()) as { askId: string };
    await h.settle();

    const response = await t.request('POST', API_PATHS.askSlotResult(askId, 'w1'), {
      outcome: 'done',
      text: 'Four.',
    });
    expect(response.status).toBe(200);
    expect(WebResultResponseSchema.parse(await response.json())).toEqual({
      status: 'done',
      truncated: false,
    });
    await h.settle();

    const snapshot = AskSnapshotSchema.parse(
      await (await t.request('GET', API_PATHS.askSnapshot(askId))).json(),
    );
    expect(snapshot.status).toBe('done');
    expect(snapshot.slots[0]).toMatchObject({ kind: 'web', status: 'done', text: 'Four.' });

    const again = await t.request('POST', API_PATHS.askSlotResult(askId, 'w1'), {
      outcome: 'done',
      text: 'Four.',
    });
    expect(again.status).toBe(200);
    const other = await t.request('POST', API_PATHS.askSlotResult(askId, 'w1'), {
      outcome: 'done',
      text: 'Five.',
    });
    expect(other.status).toBe(409);
  });

  test('a malformed result is a bad request and leaves the slot running', async () => {
    const { h, t } = app();
    const created = await t.request('POST', API_PATHS.ask, {
      prompt: 'hi',
      targets: [web()],
      runsWebSlots: true,
    });
    const { askId } = (await created.json()) as { askId: string };
    await h.settle();

    for (const body of [{}, { outcome: 'done' }, { outcome: 'failed', code: 'timeout' }]) {
      const response = await t.request('POST', API_PATHS.askSlotResult(askId, 'w1'), body);
      expect(response.status).toBe(400);
    }
    expect((await slotOf(h, askId)).status).toBe('running');
  });

  test('without the declaration the ask is refused with its own error code', async () => {
    const { t } = app();
    const response = await t.request('POST', API_PATHS.ask, { prompt: 'hi', targets: [web()] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'web_client_required',
    );
  });

  test('the result route needs a session', async () => {
    const { t } = app();
    const response = await t.app.request(API_PATHS.askSlotResult('a', 'w1'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'done', text: 'x' }),
    });
    expect(response.status).toBe(401);
  });
});
