import { describe, expect, test, vi } from 'vitest';
import { createDefaultSettings } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import { createApiClient } from './api.ts';
import {
  errorResponse,
  jsonResponse,
  scriptedFetch,
  testMeta,
  testSettingsResponse,
} from './test-support.ts';

const OK = { ok: true };

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ApiError)) throw new Error('expected the call to reject with ApiError');
  return error;
}

describe('requests', () => {
  test('a read is a same-origin GET without a body or a content type', async () => {
    const http = scriptedFetch(() => jsonResponse(testMeta()));
    const meta = await createApiClient({ fetch: http.fetch }).getMeta();

    expect(meta).toEqual(testMeta());
    expect(http.calls).toHaveLength(1);
    const { url, init } = http.calls[0]!;
    expect(url).toBe('/api/meta');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    expect(new Headers(init.headers).get('Accept')).toBe('application/json');
  });

  test('a write sends its payload as JSON', async () => {
    const http = scriptedFetch(() => jsonResponse({ device: null }));
    const api = createApiClient({ fetch: http.fetch });
    await api.pair({ code: '12345678', deviceName: 'Phone' });

    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/api/auth/pair');
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
    expect(call.init.credentials).toBe('same-origin');
    expect(call.body).toEqual({ code: '12345678', deviceName: 'Phone' });
  });

  test('a write without a payload still sends a JSON object, as the server requires', async () => {
    const http = scriptedFetch(() => jsonResponse(OK));
    const api = createApiClient({ fetch: http.fetch });
    await api.logout();
    await api.revokeDevice('dev-1');
    await api.deletePreset('p 1');
    await api.deleteHistoryEntry('ask-1');

    expect(http.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['POST', '/api/auth/logout', {}],
      ['DELETE', '/api/auth/devices/dev-1', {}],
      ['DELETE', '/api/presets/p%201', {}],
      ['DELETE', '/api/history/ask-1', {}],
    ]);
    for (const call of http.calls) {
      expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
    }
  });

  test('provider calls unwrap the list and pass the id to refresh', async () => {
    const http = scriptedFetch(() => jsonResponse({ providers: [] }));
    const api = createApiClient({ fetch: http.fetch });

    expect(await api.listProviders()).toEqual([]);
    expect(await api.refreshProviders('claude')).toEqual([]);
    await api.refreshProviders();

    expect(http.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['GET', '/api/providers', undefined],
      ['POST', '/api/providers/refresh', { id: 'claude' }],
      ['POST', '/api/providers/refresh', {}],
    ]);
  });

  test('cancel names the slot only when one is given', async () => {
    const http = scriptedFetch(() => jsonResponse({ cancelled: ['a'] }));
    const api = createApiClient({ fetch: http.fetch });

    expect(await api.cancelAsk('ask-1', 'a')).toEqual({ cancelled: ['a'] });
    await api.cancelAsk('ask-1');

    expect(http.calls.map((call) => [call.url, call.body])).toEqual([
      ['/api/ask/ask-1/cancel', { slotId: 'a' }],
      ['/api/ask/ask-1/cancel', {}],
    ]);
  });

  test('history paging and search go into the query string; empty values are left out', async () => {
    const http = scriptedFetch(() => jsonResponse({ items: [], nextCursor: null }));
    const api = createApiClient({ fetch: http.fetch });

    await api.listHistory();
    await api.listHistory({ q: 'a b&c', cursor: 'next', limit: 10 });
    await api.listHistory({ q: '', cursor: undefined });

    expect(http.calls.map((call) => call.url)).toEqual([
      '/api/history',
      '/api/history?q=a+b%26c&cursor=next&limit=10',
      '/api/history',
    ]);
  });

  test('settings are read and patched on the same path', async () => {
    const http = scriptedFetch(() => jsonResponse(testSettingsResponse()));
    const api = createApiClient({ fetch: http.fetch });

    expect((await api.getSettings()).settings).toEqual(createDefaultSettings());
    await api.updateSettings({ language: 'zh-TW' });

    expect(http.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['GET', '/api/settings', undefined],
      ['PUT', '/api/settings', { language: 'zh-TW' }],
    ]);
  });
});

describe('failures', () => {
  test("the server's error body becomes an ApiError with its code, status and message", async () => {
    const http = scriptedFetch(() => errorResponse('queue_full', 429, 'The queue is full'));
    const error = await failure(
      createApiClient({ fetch: http.fetch }).ask({
        prompt: 'hi',
        targets: [{ slotId: 'a', providerId: 'claude' }],
      }),
    );

    expect(error).toMatchObject({ code: 'queue_full', status: 429, message: 'The queue is full' });
  });

  test('a rejected session calls the global handler once and still rejects', async () => {
    const onUnauthorized = vi.fn();
    const http = scriptedFetch(() => errorResponse('unauthorized', 401));
    const api = createApiClient({ fetch: http.fetch, onUnauthorized });

    expect(await failure(api.getSettings())).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test('other errors, a wrong pairing code included, do not end the session', async () => {
    const onUnauthorized = vi.fn();
    const http = scriptedFetch((call) =>
      call.url === '/api/auth/pair'
        ? errorResponse('invalid_code', 401)
        : errorResponse('not_found', 404),
    );
    const api = createApiClient({ fetch: http.fetch, onUnauthorized });

    expect(await failure(api.pair({ code: '00000000', deviceName: 'x' }))).toMatchObject({
      code: 'invalid_code',
      status: 401,
    });
    expect(await failure(api.getAsk('gone'))).toMatchObject({ code: 'not_found', status: 404 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('an error that is not in the protocol (a proxy page) keeps its status', async () => {
    const http = scriptedFetch(
      () => new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const error = await failure(createApiClient({ fetch: http.fetch }).getMeta());

    expect(error).toMatchObject({ code: 'invalid_response', status: 502 });
  });

  test('no response at all is a network error with status 0', async () => {
    const http = scriptedFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const onUnauthorized = vi.fn();
    const error = await failure(createApiClient({ fetch: http.fetch, onUnauthorized }).getMeta());

    expect(error).toMatchObject({ code: 'network', status: 0 });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  test('a success that does not match the protocol is refused and reported as a version hint', async () => {
    const onInvalidResponse = vi.fn();
    const http = scriptedFetch(() => jsonResponse({ ...testMeta(), apiVersion: 'two' }));
    const api = createApiClient({ fetch: http.fetch, onInvalidResponse });

    expect(await failure(api.getMeta())).toMatchObject({ code: 'invalid_response', status: 200 });
    expect(onInvalidResponse).toHaveBeenCalledTimes(1);
  });

  test('a success that is not JSON is refused', async () => {
    const http = scriptedFetch(() => new Response('<!doctype html>', { status: 200 }));
    const error = await failure(createApiClient({ fetch: http.fetch }).listPresets());

    expect(error).toMatchObject({ code: 'invalid_response', status: 200 });
  });

  test('responses are validated: an unknown field value in a list is refused', async () => {
    const http = scriptedFetch(() =>
      jsonResponse({ devices: [{ id: 'd', name: '', createdAt: 0 }], maxDevices: 8 }),
    );
    const error = await failure(createApiClient({ fetch: http.fetch }).listDevices());

    expect(error.code).toBe('invalid_response');
  });
});
