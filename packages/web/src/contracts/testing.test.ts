import { createEffect, createRoot } from 'solid-js';
import { expect, test } from 'vitest';
import type { AskSnapshot } from '@answerwall/core/protocol';
import { ApiError } from './services.ts';
import { createFakeServices } from './testing.ts';

const slot = { slotId: 'a', providerId: 'claude' };

test('a submitted ask is followed and folds stream events into its snapshot', async () => {
  const services = createFakeServices();
  const stream = await services.asks.submit({ prompt: 'hi', targets: [{ ...slot }] });
  const texts: (string | undefined)[] = [];
  const dispose = createRoot((disposeRoot) => {
    createEffect(() => texts.push(stream.snapshot()?.slots[0]?.text));
    return disposeRoot;
  });

  expect(services.asks.current()).toBe(stream);
  expect(stream.snapshot()?.slots[0]).toMatchObject({ kind: 'claude', status: 'queued' });

  stream.apply({ type: 'start', seq: 1, ...slot, at: 5, streaming: 'token' });
  stream.apply({ type: 'delta', seq: 2, ...slot, text: 'Hel' });
  stream.apply({ type: 'delta', seq: 3, ...slot, text: 'lo' });
  expect(stream.connection()).toBe('live');
  stream.apply({ type: 'done', seq: 4, ...slot, elapsedMs: 9 });
  stream.apply({ type: 'ask_done', seq: 5 });

  expect(stream.snapshot()).toMatchObject({ status: 'done', seq: 5 });
  expect(stream.snapshot()?.slots[0]).toMatchObject({ status: 'done', text: 'Hello' });
  expect(stream.connection()).toBe('closed');
  expect(texts).toEqual(['', 'Hel', 'Hello']);
  dispose();
});

test('a followed ask starts empty, takes a snapshot event and can fail for good', () => {
  const services = createFakeServices();
  const stream = services.asks.follow('ask-9');
  expect(stream.snapshot()).toBeUndefined();
  expect(stream.connection()).toBe('connecting');

  const snapshot: AskSnapshot = {
    askId: 'ask-9',
    conversationId: 'c',
    prompt: 'hi',
    createdAt: 0,
    status: 'done',
    seq: 3,
    slots: [],
  };
  stream.apply({ type: 'snapshot', seq: 3, snapshot });
  expect(stream.snapshot()).toEqual(snapshot);
  expect(stream.connection()).toBe('closed');

  const gone = services.asks.follow('ask-10');
  gone.fail(new ApiError('not_found', 404, 'No such ask'));
  expect(gone.connection()).toBe('failed');
  expect(gone.error()?.code).toBe('not_found');
});

test('api calls are recorded and answered only by the handlers given', async () => {
  const services = createFakeServices({ api: { listPresets: async () => [] } });

  expect(await services.api.listPresets()).toEqual([]);
  await expect(services.api.deletePreset('p1')).rejects.toThrow('api.deletePreset');
  expect(services.apiCalls).toEqual([
    { method: 'listPresets', args: [] },
    { method: 'deletePreset', args: ['p1'] },
  ]);
});

test('settings updates are recorded and applied', async () => {
  const services = createFakeServices();
  await services.settings.update({ layout: { columns: 2 }, language: 'zh-TW' });
  expect(services.settings.settings()).toMatchObject({
    language: 'zh-TW',
    layout: { columns: 2, mode: 'auto' },
  });
  expect(services.settingsUpdates).toHaveLength(1);
});
