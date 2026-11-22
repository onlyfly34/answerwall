import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDefaultSettings, initialAskSnapshot } from '@answerwall/core/protocol';
import type { Settings } from '@answerwall/core/protocol';
import { readyProviderStatus } from '../contracts/testing.ts';
import { createServices } from './services.ts';
import {
  errorResponse,
  fakeVisibility,
  jsonResponse,
  memoryStorage,
  scriptedFetch,
  sseConnection,
  TEST_VERSION,
  testMeta,
  testSettingsResponse,
} from './test-support.ts';
import type { RecordedCall, SseConnection } from './test-support.ts';

const request = { prompt: 'hi', targets: [{ slotId: 'a', providerId: 'claude' }] };

function harness(options: { settings?: Settings; stream?: () => Response } = {}) {
  let settings = options.settings ?? createDefaultSettings();
  const streams: SseConnection[] = [];
  const http = scriptedFetch((call: RecordedCall) => {
    const route = `${call.method} ${call.url}`;
    if (call.url.startsWith('/api/ask/ask-1/stream')) {
      if (options.stream) return options.stream();
      const connection = sseConnection(call.init.signal);
      streams.push(connection);
      return connection.response;
    }
    switch (route) {
      case 'GET /api/meta':
        return jsonResponse(testMeta());
      case 'GET /api/settings':
        return jsonResponse(testSettingsResponse({ settings }));
      case 'PUT /api/settings': {
        const patch = call.body as Partial<Settings>;
        settings = { ...settings, ...patch };
        return jsonResponse(testSettingsResponse({ settings }));
      }
      case 'GET /api/providers':
        return jsonResponse({ providers: settings.providers.map(readyProviderStatus) });
      case 'POST /api/ask':
        return jsonResponse({ askId: 'ask-1' });
      case 'GET /api/ask/ask-1':
        return jsonResponse(
          initialAskSnapshot({
            askId: 'ask-1',
            conversationId: 'conv-1',
            prompt: 'hi',
            createdAt: 1,
            targets: [{ slotId: 'a', providerId: 'claude', kind: 'claude' }],
          }),
        );
      case 'POST /api/ask/ask-1/cancel':
        return jsonResponse({ cancelled: ['a'] });
      default:
        return errorResponse('not_found', 404);
    }
  });
  const storage = memoryStorage();
  const services = createServices({
    fetch: http.fetch,
    updater: { apply: async () => true, settled: () => undefined },
    buildVersion: TEST_VERSION,
    visibility: fakeVisibility(),
    language: { storage, preferred: ['en'], root: { lang: '' } },
    random: () => 0,
  });
  const requests = () => http.calls.map((call) => `${call.method} ${call.url}`);
  return { services, http, requests, streams, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the real services, wired together', () => {
  test('nothing is requested until the shell starts', async () => {
    const { services, requests } = harness();
    expect(services.meta()).toBeUndefined();
    expect(services.settings.settings()).toBeUndefined();
    expect(services.providers.providers()).toEqual([]);
    expect(services.asks.current()).toBeUndefined();
    await Promise.resolve();
    expect(requests()).toEqual([]);

    await services.shell.start();

    expect(services.shell.phase()).toBe('ready');
    expect(services.meta()?.version).toBe(TEST_VERSION);
    expect(services.settings.settings()).toEqual(createDefaultSettings());
    expect(services.providers.providers()).toHaveLength(4);
  });

  test('the language of the server settings wins once it is known, and is remembered here', async () => {
    const { services, storage } = harness({
      settings: { ...createDefaultSettings(), language: 'zh-TW' },
    });
    expect(services.i18n.language()).toBe('en');

    await services.shell.start();

    expect(services.i18n.language()).toBe('zh-TW');
    expect([...storage.values.values()]).toEqual(['zh-TW']);
  });

  test('provider statuses are read again after the provider settings change, and only then', async () => {
    const { services, requests } = harness();
    await services.shell.start();
    const providerReads = () => requests().filter((r) => r === 'GET /api/providers').length;
    expect(providerReads()).toBe(1);

    await services.settings.update({ updateCheck: false });
    expect(providerReads()).toBe(1);

    await services.settings.update({ providers: createDefaultSettings().providers });
    await vi.waitFor(() => expect(providerReads()).toBe(2));
    // Reading statuses never asks the server to run a detection.
    expect(requests()).not.toContain('POST /api/providers/refresh');
  });

  test('an ask is submitted, followed over the stream and cancelled through the API', async () => {
    const { services, requests, streams } = harness();
    await services.shell.start();

    const stream = await services.asks.submit(request);
    await vi.waitFor(() => expect(stream.connection()).toBe('live'));
    expect(services.asks.current()).toBe(stream);
    expect(requests()).toContain('GET /api/ask/ask-1/stream?after=0');

    await services.asks.cancel('a');
    expect(requests()).toContain('POST /api/ask/ask-1/cancel');

    streams[0]?.send({
      type: 'cancelled',
      seq: 1,
      slotId: 'a',
      providerId: 'claude',
      elapsedMs: 3,
    });
    streams[0]?.send({ type: 'ask_done', seq: 2 });
    await vi.waitFor(() => expect(stream.connection()).toBe('closed'));
    expect(stream.snapshot()?.slots[0]?.status).toBe('cancelled');
  });

  test('a session that ends while an ask streams returns to sign-in and stops following', async () => {
    const { services } = harness({ stream: () => errorResponse('unauthorized', 401) });
    await services.shell.start();

    const stream = await services.asks.submit(request);

    await vi.waitFor(() => expect(services.shell.phase()).toBe('signed-out'));
    expect(stream.connection()).toBe('failed');
    expect(stream.error()?.status).toBe(401);
    expect(services.asks.current()).toBeUndefined();
    expect(services.notify.toasts()).toEqual([]);
  });

  test('an ask that no longer exists fails its stream without touching the session', async () => {
    const { services } = harness({ stream: () => errorResponse('not_found', 404) });
    await services.shell.start();

    const stream = await services.asks.submit(request);

    await vi.waitFor(() => expect(stream.connection()).toBe('failed'));
    expect(services.shell.phase()).toBe('ready');
    expect(services.asks.current()).toBe(stream);
  });
});
