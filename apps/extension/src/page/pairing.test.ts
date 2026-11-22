import { describe, expect, test } from 'vitest';
import { API_VERSION } from '@answerwall/core/protocol';
import {
  ensurePermission,
  forgetConnection,
  pair,
  parseServerAddress,
  readConnection,
  saveConnection,
  SERVER_KEY,
  TOKEN_KEY,
  tokenStore,
} from './pairing.ts';
import type { PairingEnvironment } from './pairing.ts';

const TOKEN = 'device-token-0123456789abcdef';
const ADDRESS = { origin: 'https://wall.example.com', pattern: 'https://wall.example.com/*' };

describe('the server address as typed', () => {
  test('an origin, with or without a path, becomes the origin and one host permission', () => {
    expect(parseServerAddress(' https://wall.example.com/settings ')).toEqual(ADDRESS);
    expect(parseServerAddress('http://192.168.1.20:7717')).toEqual({
      origin: 'http://192.168.1.20:7717',
      // A match pattern has no port.
      pattern: 'http://192.168.1.20/*',
    });
  });

  test('without a scheme, a loopback name is http and everything else https', () => {
    expect(parseServerAddress('127.0.0.1:7717')?.origin).toBe('http://127.0.0.1:7717');
    expect(parseServerAddress('localhost:7717')?.origin).toBe('http://localhost:7717');
    expect(parseServerAddress('wall.example.com')?.origin).toBe('https://wall.example.com');
    expect(parseServerAddress('wall.example.com:8443')?.origin).toBe(
      'https://wall.example.com:8443',
    );
  });

  test('anything that is not a plain http(s) address is refused', () => {
    for (const input of [
      '',
      '   ',
      'ftp://wall.example.com',
      'chrome-extension://abc/wall.html',
      'javascript:alert(1)',
      'https://user:secret@wall.example.com',
      'https://',
    ]) {
      expect(parseServerAddress(input), input).toBeUndefined();
    }
  });
});

interface Call {
  url: string;
  init: RequestInit;
}

function environment(
  answers: Record<string, () => Response>,
  permission: { held: boolean; grants: boolean } = { held: false, grants: true },
) {
  const calls: Call[] = [];
  const asked: string[][] = [];
  const env: PairingEnvironment = {
    fetch: async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      const answer = answers[`${init.method ?? 'GET'} ${new URL(url).pathname}`];
      if (!answer) throw new TypeError('Failed to fetch');
      return answer();
    },
    permissions: {
      contains: async () => permission.held,
      request: async ({ origins }) => {
        asked.push(origins);
        return permission.grants;
      },
    },
  };
  return { env, calls, asked };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const META = {
  name: 'AnswerWall',
  version: '1.0.0',
  apiVersion: API_VERSION,
  mode: 'server',
  tls: 'off',
  authRequired: true,
};
const DEVICE = {
  id: 'd-1',
  name: 'Browser extension',
  createdAt: 1,
  lastUsedAt: null,
  current: true,
};

describe('pairing', () => {
  test('asks for the one origin, checks that a server of this protocol answers, and returns the token', async () => {
    const { env, calls, asked } = environment({
      'GET /api/meta': () => json(META),
      'POST /api/auth/pair': () => json({ device: DEVICE, token: TOKEN }),
    });
    const result = await pair(env, ADDRESS, ' 1234 5678 ', ' Browser extension ');

    expect(result).toEqual({ ok: true, token: TOKEN });
    expect(asked).toEqual([['https://wall.example.com/*']]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://wall.example.com/api/meta',
      'https://wall.example.com/api/auth/pair',
    ]);
    // Never a cookie, and the body is the code and the name, trimmed.
    for (const call of calls) expect(call.init.credentials).toBe('omit');
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      code: '1234 5678',
      deviceName: 'Browser extension',
    });
  });

  test('a permission that is already held is not asked for again', async () => {
    const { env, asked } = environment(
      {
        'GET /api/meta': () => json(META),
        'POST /api/auth/pair': () => json({ device: DEVICE, token: TOKEN }),
      },
      { held: true, grants: false },
    );
    expect((await pair(env, ADDRESS, '1', 'x')).ok).toBe(true);
    expect(asked).toEqual([]);
  });

  test('without the permission nothing is requested from the server', async () => {
    const { env, calls } = environment({}, { held: false, grants: false });
    expect(await pair(env, ADDRESS, '1', 'x')).toEqual({ ok: false, reason: 'permission' });
    expect(calls).toEqual([]);
  });

  test.each([
    ['nothing answers', {}, 'unreachable'],
    ['something else answers', { 'GET /api/meta': () => json({ hello: 'world' }) }, 'not_a_server'],
    [
      'the page of a web server answers',
      { 'GET /api/meta': () => new Response('<html>', { status: 200 }) },
      'not_a_server',
    ],
    [
      'another protocol version',
      { 'GET /api/meta': () => json({ ...META, apiVersion: API_VERSION + 1 }) },
      'version',
    ],
    [
      'the extension is not listed',
      {
        'GET /api/meta': () => json(META),
        'POST /api/auth/pair': () => json({ error: { code: 'forbidden', message: 'no' } }, 403),
      },
      'not_allowed',
    ],
    [
      'a wrong code',
      {
        'GET /api/meta': () => json(META),
        'POST /api/auth/pair': () => json({ error: { code: 'invalid_code', message: 'no' } }, 401),
      },
      'code',
    ],
    [
      'too many attempts',
      {
        'GET /api/meta': () => json(META),
        'POST /api/auth/pair': () => json({ error: { code: 'rate_limited', message: 'no' } }, 429),
      },
      'rate_limited',
    ],
    [
      'the server failed',
      { 'GET /api/meta': () => json(META), 'POST /api/auth/pair': () => json({}, 500) },
      'failed',
    ],
    [
      'an answer without a token (a cookie session is of no use here)',
      {
        'GET /api/meta': () => json(META),
        'POST /api/auth/pair': () => json({ device: DEVICE }),
      },
      'failed',
    ],
    ['the connection drops during pairing', { 'GET /api/meta': () => json(META) }, 'unreachable'],
  ] as const)('%s', async (_name, answers, reason) => {
    const { env } = environment(answers);
    expect(await pair(env, ADDRESS, '1234 5678', 'x')).toEqual({ ok: false, reason });
  });

  test('a permission API that throws counts as not granted', async () => {
    const granted = await ensurePermission(
      {
        contains: async () => {
          throw new Error('invalid pattern');
        },
        request: async () => true,
      },
      'nonsense',
      true,
    );
    expect(granted).toBe(false);
  });

  test('at start the page only checks the permission; it cannot ask without a click', async () => {
    const asked: unknown[] = [];
    const permissions = {
      contains: async () => false,
      request: async (wanted: unknown) => {
        asked.push(wanted);
        return true;
      },
    };
    expect(await ensurePermission(permissions, ADDRESS.pattern, false)).toBe(false);
    expect(asked).toEqual([]);
  });
});

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(keys: string | string[]) {
      const wanted = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(
        wanted.filter((key) => data.has(key)).map((key) => [key, data.get(key)]),
      );
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === 'string' ? [keys] : keys) data.delete(key);
    },
  };
}

describe('what the extension keeps', () => {
  test('the server and the token, and nothing after forgetting', async () => {
    const storage = memoryStorage();
    expect(await readConnection(storage)).toEqual({ server: undefined });
    await saveConnection(storage, ADDRESS.origin, TOKEN);
    expect(Object.fromEntries(storage.data)).toEqual({
      [SERVER_KEY]: ADDRESS.origin,
      [TOKEN_KEY]: TOKEN,
    });
    expect(await readConnection(storage)).toEqual({ server: ADDRESS.origin });
    await forgetConnection(storage);
    expect(storage.data.size).toBe(0);
  });

  test('the token store of the web UI reads, replaces and removes the token only', async () => {
    const storage = memoryStorage({ [SERVER_KEY]: ADDRESS.origin });
    const tokens = tokenStore(storage);
    expect(await tokens.get()).toBeUndefined();
    await tokens.set(TOKEN);
    expect(await tokens.get()).toBe(TOKEN);
    await tokens.set(undefined);
    expect(await tokens.get()).toBeUndefined();
    expect(storage.data.get(SERVER_KEY)).toBe(ADDRESS.origin);
  });

  test('a stored value of the wrong kind reads as nothing', async () => {
    const storage = memoryStorage({ [SERVER_KEY]: 42, [TOKEN_KEY]: '' });
    expect(await readConnection(storage)).toEqual({ server: undefined });
    expect(await tokenStore(storage).get()).toBeUndefined();
  });
});
