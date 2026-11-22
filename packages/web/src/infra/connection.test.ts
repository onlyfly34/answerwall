import { describe, expect, test } from 'vitest';
import { createDefaultSettings, initialAskSnapshot } from '@answerwall/core/protocol';
import { ApiError } from '../contracts/services.ts';
import type { WebCellHost } from '../contracts/services.ts';
import { createApiClient } from './api.ts';
import { createRemoteConnection, withRemoteSession } from './connection.ts';
import type { TokenStore } from './connection.ts';
import { createServices } from './services.ts';
import {
  errorResponse,
  fakeVisibility,
  jsonResponse,
  memoryStorage,
  scriptedFetch,
  sseConnection,
  testMeta,
  testSettingsResponse,
} from './test-support.ts';
import type { RecordedCall } from './test-support.ts';

const SERVER = 'https://wall.example.com';
const TOKEN = 'device-token-0123456789abcdef';

function memoryTokens(initial?: string): TokenStore & { value: string | undefined; reads: number } {
  const store = {
    value: initial,
    reads: 0,
    async get() {
      store.reads++;
      return store.value;
    },
    async set(token: string | undefined) {
      store.value = token;
    },
  };
  return store;
}

const authorization = (call: RecordedCall | undefined): string | null =>
  new Headers(call?.init.headers).get('Authorization');

describe('the fetch of a remote connection', () => {
  test('sends every request to the server with the bearer token and without cookies', async () => {
    const http = scriptedFetch(() => jsonResponse(testMeta()));
    const connection = createRemoteConnection({
      base: `${SERVER}/some/page`,
      tokens: memoryTokens(TOKEN),
      fetch: http.fetch,
    });

    await connection.fetch('/api/meta', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    const call = http.calls[0];
    expect(connection.origin).toBe(SERVER);
    expect(call?.url).toBe(`${SERVER}/api/meta`);
    expect(authorization(call)).toBe(`Bearer ${TOKEN}`);
    expect(call?.init.credentials).toBe('omit');
    expect(new Headers(call?.init.headers).get('Accept')).toBe('application/json');
  });

  test('without a token it sends no Authorization header', async () => {
    const http = scriptedFetch(() => jsonResponse(testMeta()));
    const connection = createRemoteConnection({
      base: SERVER,
      tokens: memoryTokens(),
      fetch: http.fetch,
    });
    await connection.fetch('/api/meta');
    expect(authorization(http.calls[0])).toBeNull();
    expect(http.calls[0]?.init.credentials).toBe('omit');
  });

  test.each([
    'https://evil.example/api/meta',
    '//evil.example/api/meta',
    'http://wall.example.com/api/meta',
    'https://wall.example.com:8443/api/meta',
  ])('refuses %s: the token goes to the one origin only', async (url) => {
    const http = scriptedFetch(() => jsonResponse({}));
    const connection = createRemoteConnection({
      base: SERVER,
      tokens: memoryTokens(TOKEN),
      fetch: http.fetch,
    });
    await expect(connection.fetch(url)).rejects.toBeInstanceOf(TypeError);
    expect(http.calls).toEqual([]);
  });

  test('refuses a server address that is not http or https', () => {
    for (const base of ['chrome-extension://abc', 'file:///tmp/x', 'javascript:alert(1)']) {
      expect(() => createRemoteConnection({ base, tokens: memoryTokens() })).toThrow();
    }
  });

  test('reads the stored token once and follows later changes', async () => {
    const http = scriptedFetch(() => jsonResponse({}));
    const tokens = memoryTokens(TOKEN);
    const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });

    await connection.fetch('/api/meta');
    await connection.fetch('/api/meta');
    await connection.setToken('another-token-0123456789');
    await connection.fetch('/api/meta');

    expect(tokens.reads).toBe(1);
    expect(tokens.value).toBe('another-token-0123456789');
    expect(http.calls.map(authorization)).toEqual([
      `Bearer ${TOKEN}`,
      `Bearer ${TOKEN}`,
      'Bearer another-token-0123456789',
    ]);
  });

  test('a 401 for the current token forgets it, so a dead token is presented once', async () => {
    const http = scriptedFetch(() => errorResponse('unauthorized', 401));
    const tokens = memoryTokens(TOKEN);
    const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });

    await connection.fetch('/api/settings');
    await connection.fetch('/api/settings');

    expect(tokens.value).toBeUndefined();
    expect(http.calls.map(authorization)).toEqual([`Bearer ${TOKEN}`, null]);
  });

  test('a late 401 for an older token does not forget a newer one', async () => {
    let release: (response: Response) => void = () => undefined;
    const http = scriptedFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const tokens = memoryTokens(TOKEN);
    const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });

    const pending = connection.fetch('/api/settings');
    await Promise.resolve();
    await Promise.resolve();
    await connection.setToken('newer-token-0123456789ab');
    release(errorResponse('unauthorized', 401));
    await pending;

    expect(tokens.value).toBe('newer-token-0123456789ab');
  });

  describe('when another page of the extension has stored a newer token', () => {
    const NEWER = 'newer-token-0123456789ab';

    /** A page that read `TOKEN` before another page signed out and paired again. */
    async function stalePage(respond: (call: RecordedCall) => Response) {
      const http = scriptedFetch(respond);
      const tokens = memoryTokens(TOKEN);
      const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });
      await connection.fetch('/api/meta');
      tokens.value = NEWER;
      http.calls.length = 0;
      return { http, tokens, connection };
    }
    const knowsOnly =
      (token: string) =>
      (call: RecordedCall): Response =>
        authorization(call) === `Bearer ${token}`
          ? jsonResponse(testMeta())
          : errorResponse('unauthorized', 401);

    test('a 401 for the old one does not delete the new one: it is taken over and the request repeated', async () => {
      let signedOut = false;
      const { http, tokens, connection } = await stalePage((call) =>
        signedOut ? knowsOnly(NEWER)(call) : jsonResponse(testMeta()),
      );
      signedOut = true;

      const response = await connection.fetch('/api/settings', { method: 'PUT', body: '{}' });

      expect(tokens.value).toBe(NEWER);
      expect(response.status).toBe(200);
      expect(http.calls.map(authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEWER}`]);
      expect(http.calls[1]?.init.body).toBe('{}');
      await connection.fetch('/api/meta');
      expect(authorization(http.calls[2])).toBe(`Bearer ${NEWER}`);
    });

    test('a newer token that is refused as well is forgotten, after one attempt', async () => {
      let signedOut = false;
      const { http, tokens, connection } = await stalePage(() =>
        signedOut ? errorResponse('unauthorized', 401) : jsonResponse(testMeta()),
      );
      signedOut = true;

      expect((await connection.fetch('/api/meta')).status).toBe(401);
      expect(http.calls.map(authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${NEWER}`]);
      expect(tokens.value).toBeUndefined();
    });

    test('only a request without a body or with a string body is repeated', async () => {
      let signedOut = false;
      const { http, tokens, connection } = await stalePage((call) =>
        signedOut ? knowsOnly(NEWER)(call) : jsonResponse(testMeta()),
      );
      signedOut = true;

      const init: RequestInit = { method: 'PUT', body: new FormData() };
      expect((await connection.fetch('/api/settings', init)).status).toBe(401);
      expect(http.calls).toHaveLength(1);
      expect(tokens.value).toBe(NEWER);
    });
  });

  test('other failures keep the token', async () => {
    const http = scriptedFetch(() => errorResponse('forbidden', 403));
    const tokens = memoryTokens(TOKEN);
    const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });
    await connection.fetch('/api/settings');
    expect(tokens.value).toBe(TOKEN);
  });
});

describe('the session of a remote page', () => {
  function remote(respond: (call: RecordedCall) => Response, stored?: string) {
    const http = scriptedFetch(respond);
    const tokens = memoryTokens(stored);
    const connection = createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch });
    const api = withRemoteSession(createApiClient({ fetch: connection.fetch }), connection);
    return { http, tokens, api };
  }

  test('pairing keeps the token the server returns and does not pass it on', async () => {
    const { api, tokens, http } = remote(() => jsonResponse({ device: null, token: TOKEN }));

    const response = await api.pair({ code: '12345678', deviceName: 'Extension' });

    expect(response).toEqual({ device: null });
    expect(tokens.value).toBe(TOKEN);
    expect(http.calls[0]?.url).toBe(`${SERVER}/api/auth/pair`);
  });

  test('a pairing answer without a token is an error: a cookie would be of no use here', async () => {
    const { api, tokens } = remote(() => jsonResponse({ device: null }));

    const error: unknown = await api
      .pair({ code: '12345678', deviceName: 'Extension' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_response');
    expect(tokens.value).toBeUndefined();
  });

  test('signing in with an access token keeps it once the server has accepted it', async () => {
    const accepted = remote(() => jsonResponse({ device: null }));
    await accepted.api.signIn({ token: TOKEN });
    expect(accepted.tokens.value).toBe(TOKEN);
    // The token to check travels in the body; nothing is presented as a credential yet.
    expect(authorization(accepted.http.calls[0])).toBeNull();

    const refused = remote(() => errorResponse('unauthorized', 401));
    await expect(refused.api.signIn({ token: TOKEN })).rejects.toBeInstanceOf(ApiError);
    expect(refused.tokens.value).toBeUndefined();
  });

  test('signing out forgets the token after the server revoked the device', async () => {
    const { api, tokens, http } = remote(() => jsonResponse({ ok: true }), TOKEN);
    await api.logout();
    expect(authorization(http.calls[0])).toBe(`Bearer ${TOKEN}`);
    expect(tokens.value).toBeUndefined();
  });

  test('a failed sign-out keeps the token', async () => {
    const { api, tokens } = remote(() => errorResponse('internal', 500), TOKEN);
    await expect(api.logout()).rejects.toBeInstanceOf(ApiError);
    expect(tokens.value).toBe(TOKEN);
  });
});

describe('the services of a remote page', () => {
  function harness(
    options: { meta?: Parameters<typeof testMeta>[0]; webCells?: WebCellHost } = {},
  ) {
    const settings = createDefaultSettings();
    settings.providers.push({
      id: 'web-claude',
      kind: 'web',
      site: 'claude',
      label: 'Claude (web)',
      enabled: true,
      concurrency: 2,
      models: [],
    });
    const http = scriptedFetch((call) => {
      const path = new URL(call.url).pathname;
      if (path === '/api/ask/ask-1/stream') return sseConnection(call.init.signal).response;
      switch (`${call.method} ${path}`) {
        case 'GET /api/meta':
          return jsonResponse(testMeta(options.meta));
        case 'GET /api/settings':
          return jsonResponse(testSettingsResponse({ settings }));
        case 'GET /api/providers':
          return jsonResponse({
            providers: settings.providers.map((instance) => ({
              instance,
              detection: null,
              detectedAt: null,
              detecting: false,
              models: [],
              toolAccess: instance.kind === 'web' ? 'unrestricted' : 'disabled',
              webSearch: 'none',
            })),
          });
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
        default:
          return errorResponse('not_found', 404);
      }
    });
    const tokens = memoryTokens(TOKEN);
    const services = createServices({
      connection: createRemoteConnection({ base: SERVER, tokens, fetch: http.fetch }),
      ...(options.webCells === undefined ? {} : { webCells: options.webCells }),
      buildVersion: '9.9.9-extension',
      visibility: fakeVisibility(),
      language: { storage: memoryStorage(), preferred: ['en'], root: { lang: '' } },
      random: () => 0,
    });
    return { services, http, tokens };
  }

  test('every request, the event stream included, goes to the server with the token', async () => {
    const { services, http } = harness();
    await services.shell.start();
    expect(services.shell.phase()).toBe('ready');
    expect(services.remote).toBe(true);

    await services.asks.submit({ prompt: 'hi', targets: [{ slotId: 'a', providerId: 'claude' }] });
    await expect.poll(() => http.calls.some((call) => call.url.includes('/stream'))).toBe(true);
    services.asks.clear();

    expect(http.calls.length).toBeGreaterThan(4);
    for (const call of http.calls) {
      expect(call.url.startsWith(`${SERVER}/api/`), call.url).toBe(true);
      expect(authorization(call), call.url).toBe(`Bearer ${TOKEN}`);
      expect(call.init.credentials, call.url).toBe('omit');
    }
  });

  test('another build of the same protocol is not stale; another protocol is, without reloading', async () => {
    const sameProtocol = harness({ meta: { version: '1.0.0-server' } });
    await sameProtocol.services.shell.start();
    expect(sameProtocol.services.shell.phase()).toBe('ready');

    const otherProtocol = harness({ meta: { apiVersion: 999 } });
    await otherProtocol.services.shell.start();
    expect(otherProtocol.services.shell.phase()).toBe('stale');
  });

  test('web providers are listed on every page; only a page with a host can show their cells', async () => {
    const plain = harness();
    await plain.services.shell.start();
    expect(plain.services.providers.providers().map((status) => status.instance.id)).toContain(
      'web-claude',
    );
    expect(plain.services.webCells).toBeUndefined();

    const host: WebCellHost = {
      site: () => undefined,
      attach: () => ({
        connection: () => 'loading',
        run: async () => ({ outcome: 'aborted' }),
        dispose: () => undefined,
      }),
    };
    const capable = harness({ webCells: host });
    await capable.services.shell.start();
    expect(capable.services.webCells).toBe(host);
  });
});
