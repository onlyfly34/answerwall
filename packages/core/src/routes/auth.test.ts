import { beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '../brand.ts';
import type { AppDeps, AppEnv, AppMiddleware, HttpLayer } from '../contracts/index.ts';
import {
  API_PATHS,
  DevicesResponseSchema,
  MAX_DEVICES,
  PairingCodeResponseSchema,
  SessionResponseSchema,
} from '../protocol/index.ts';
import {
  createMemoryLogger,
  createOpenHttpLayer,
  createTestApp,
  TEST_PAIRING_CODE,
  TEST_TOKEN,
} from '../testing/index.ts';
import type { TestApp } from '../testing/index.ts';
import type { Hono } from 'hono';

let secure: boolean;
/** `authFailure` of each request, as the rate limiter would see it. */
let failures: (boolean | undefined)[];
let app: Hono<AppEnv>;
let deps: AppDeps;
let request: TestApp['request'];

beforeEach(() => {
  secure = false;
  failures = [];
  const open = createOpenHttpLayer(createMemoryLogger());
  const clientInfo: AppMiddleware = (c, next) => {
    c.set('client', { peer: '127.0.0.1', address: '127.0.0.1', secure });
    return next();
  };
  const authRateLimit: AppMiddleware = async (c, next) => {
    await next();
    failures.push(c.var.authFailure);
  };
  const http: HttpLayer = { ...open, clientInfo, authRateLimit };
  const testApp = createTestApp({ http });
  ({ app, deps } = testApp);
  request = (method, path, body) => testApp.request(method, path, body);
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', ...headers },
    body: JSON.stringify(body),
  });

const setCookie = (response: Response): string => response.headers.get('Set-Cookie') ?? '';
const cookiePair = (response: Response): string => setCookie(response).split(';')[0] ?? '';
const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error?: { code?: unknown } }).error?.code;

async function pair(deviceName = 'Phone') {
  const response = await post(API_PATHS.authPair, { code: TEST_PAIRING_CODE, deviceName });
  const { device } = SessionResponseSchema.parse(await response.json());
  return { response, cookie: cookiePair(response), deviceId: device?.id ?? '' };
}

describe('POST /api/auth/pair', () => {
  test('pairs a device and sets the session cookie', async () => {
    const { response } = await pair('Kitchen tablet');

    expect(response.status).toBe(200);
    const cookie = setCookie(response);
    expect(cookie).toMatch(new RegExp(`^${BRAND.sessionCookie}=[^;]+; `));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d{7,}/);
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('Domain');
    expect(failures).toEqual([undefined]);
  });

  test('the token is in the cookie only, never in the response body', async () => {
    const response = await post(API_PATHS.authPair, {
      code: TEST_PAIRING_CODE,
      deviceName: 'Phone',
    });
    const token = cookiePair(response).split('=')[1] ?? '';

    const body = await response.text();
    expect(token.length).toBeGreaterThan(0);
    expect(body).not.toContain(token);
    expect(SessionResponseSchema.parse(JSON.parse(body)).device).toMatchObject({
      name: 'Phone',
      current: true,
    });
  });

  test('the cookie is Secure when the request is secure', async () => {
    secure = true;
    expect(setCookie((await pair()).response)).toContain('Secure');
  });

  test('a code typed the way it is shown, in groups, is accepted', async () => {
    const shown = `${TEST_PAIRING_CODE.slice(0, 4)} ${TEST_PAIRING_CODE.slice(4)}`;
    const dashed = `${TEST_PAIRING_CODE.slice(0, 4)}-${TEST_PAIRING_CODE.slice(4)}`;

    expect((await post(API_PATHS.authPair, { code: shown, deviceName: 'A' })).status).toBe(200);
    expect((await post(API_PATHS.authPair, { code: dashed, deviceName: 'B' })).status).toBe(200);
  });

  test('a wrong code is refused, sets no cookie and counts as a failed attempt', async () => {
    const response = await post(API_PATHS.authPair, { code: '00000000', deviceName: 'Phone' });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('invalid_code');
    expect(setCookie(response)).toBe('');
    expect(failures).toEqual([true]);
  });

  test.each([
    ['a missing code', { deviceName: 'Phone' }],
    ['a code that is not eight digits', { code: '1234', deviceName: 'Phone' }],
    ['a code with letters', { code: '1234abcd', deviceName: 'Phone' }],
    ['a numeric code', { code: 12345678, deviceName: 'Phone' }],
    ['a missing device name', { code: TEST_PAIRING_CODE }],
    ['an empty device name', { code: TEST_PAIRING_CODE, deviceName: '   ' }],
    ['an over-long device name', { code: TEST_PAIRING_CODE, deviceName: 'x'.repeat(65) }],
    ['a body that is not an object', [TEST_PAIRING_CODE]],
  ])('%s is a bad request, not a failed attempt', async (_label, body) => {
    const response = await post(API_PATHS.authPair, body);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
    expect(failures).toEqual([undefined]);
  });

  test('a body that is not JSON is a bad request', async () => {
    const response = await app.request(API_PATHS.authPair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  test('the device limit is reported as such and is not a failed attempt', async () => {
    for (let index = 0; index < MAX_DEVICES; index++) await pair(`Device ${index}`);
    failures = [];

    const response = await post(API_PATHS.authPair, {
      code: TEST_PAIRING_CODE,
      deviceName: 'One too many',
    });

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe('device_limit');
    expect(failures).toEqual([undefined]);
  });
});

describe('an allowed browser extension', () => {
  /** What the origin guard sets for the page of an extension on the allowlist. */
  function extensionApp(): TestApp {
    const open = createOpenHttpLayer(createMemoryLogger());
    const originGuard: AppMiddleware = (c, next) => {
      c.set('extensionOrigin', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');
      return next();
    };
    return createTestApp({ http: { ...open, originGuard } });
  }
  const send = (t: TestApp, method: string, path: string, body: unknown, token?: string) =>
    t.app.request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  test('pairing answers with the token and sets no cookie', async () => {
    const t = extensionApp();
    const response = await send(t, 'POST', API_PATHS.authPair, {
      code: TEST_PAIRING_CODE,
      deviceName: 'Browser extension',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    // The fake service's tokens are shorter than real ones, so the body is read as it is.
    const body = (await response.json()) as { device: { id: string }; token: string };
    expect(body.device).toMatchObject({ name: 'Browser extension', current: true });
    expect(await t.deps.auth.authenticate(body.token)).toEqual({
      kind: 'device',
      deviceId: body.device.id,
    });
  });

  test('the token then works as a bearer token, and signing out revokes it', async () => {
    const t = extensionApp();
    const paired = await send(t, 'POST', API_PATHS.authPair, {
      code: TEST_PAIRING_CODE,
      deviceName: 'Browser extension',
    });
    const { token } = (await paired.json()) as { token: string };

    const devices = await t.app.request(API_PATHS.authDevices, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(devices.status).toBe(200);

    const out = await send(t, 'POST', API_PATHS.authLogout, {}, token);
    expect(out.status).toBe(200);
    expect(out.headers.get('Set-Cookie')).toBeNull();
    expect(await t.deps.auth.authenticate(token)).toBeNull();
  });

  test('checking a token it already holds sets no cookie and does not echo the token', async () => {
    const t = extensionApp();
    const response = await send(t, 'POST', API_PATHS.authSession, { token: TEST_TOKEN });

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.json()).toEqual({ device: null });
  });
});

describe('POST /api/auth/session', () => {
  test('trades a valid token for the session cookie', async () => {
    const response = await post(API_PATHS.authSession, { token: TEST_TOKEN });

    expect(response.status).toBe(200);
    expect(SessionResponseSchema.parse(await response.json())).toEqual({ device: null });
    expect(setCookie(response)).toContain(`${BRAND.sessionCookie}=${TEST_TOKEN};`);
    expect(setCookie(response)).toContain('HttpOnly');
    expect(setCookie(response)).toContain('SameSite=Strict');

    const devices = await app.request(API_PATHS.authDevices, {
      headers: { Cookie: cookiePair(response) },
    });
    expect(devices.status).toBe(200);
  });

  test('a wrong token is refused, sets no cookie and counts as a failed attempt', async () => {
    const response = await post(API_PATHS.authSession, { token: 'wrong-token-0123456789' });

    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('unauthorized');
    expect(setCookie(response)).toBe('');
    expect(failures).toEqual([true]);
  });

  test.each([{}, { token: 'short' }, { token: 'x'.repeat(513) }, { token: 42 }])(
    'the malformed body %j is a bad request, not a failed attempt',
    async (body) => {
      const response = await post(API_PATHS.authSession, body);
      expect(response.status).toBe(400);
      expect(failures).toEqual([undefined]);
    },
  );
});

describe('POST /api/auth/logout', () => {
  test('needs a session', async () => {
    const response = await post(API_PATHS.authLogout, {});
    expect(response.status).toBe(401);
  });

  test('revokes the device and clears the cookie', async () => {
    const { cookie } = await pair();

    const response = await post(API_PATHS.authLogout, {}, { Cookie: cookie });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(setCookie(response)).toMatch(new RegExp(`^${BRAND.sessionCookie}=; Max-Age=0; Path=/`));
    const after = await app.request(API_PATHS.authDevices, { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  test('with the static token it clears the cookie and keeps every device', async () => {
    await pair();

    const response = await request('POST', API_PATHS.authLogout);

    expect(response.status).toBe(200);
    expect(setCookie(response)).toContain('Max-Age=0');
    const { devices } = DevicesResponseSchema.parse(
      await (await request('GET', API_PATHS.authDevices)).json(),
    );
    expect(devices).toHaveLength(1);
  });
});

describe('devices', () => {
  test('lists the paired devices with the limit, marking the caller', async () => {
    await pair('First');
    const second = await pair('Second');

    const response = await app.request(API_PATHS.authDevices, {
      headers: { Cookie: second.cookie },
    });

    const { devices, maxDevices } = DevicesResponseSchema.parse(await response.json());
    expect(maxDevices).toBe(MAX_DEVICES);
    expect(devices.map(({ name, current }) => ({ name, current }))).toEqual([
      { name: 'First', current: false },
      { name: 'Second', current: true },
    ]);
  });

  test('revoking another device keeps the caller signed in', async () => {
    const other = await pair('Other');
    const mine = await pair('Mine');

    const response = await app.request(API_PATHS.authDevice(other.deviceId), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: mine.cookie, Origin: 'http://x' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(setCookie(response)).toBe('');
    const stillIn = await app.request(API_PATHS.authDevices, { headers: { Cookie: mine.cookie } });
    expect(stillIn.status).toBe(200);
    const revoked = await app.request(API_PATHS.authDevices, {
      headers: { Cookie: other.cookie },
    });
    expect(revoked.status).toBe(401);
  });

  test('revoking the current device signs it out', async () => {
    const mine = await pair('Mine');

    const response = await app.request(API_PATHS.authDevice(mine.deviceId), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: mine.cookie, Origin: 'http://x' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(setCookie(response)).toMatch(new RegExp(`^${BRAND.sessionCookie}=; Max-Age=0`));
    const after = await app.request(API_PATHS.authDevices, { headers: { Cookie: mine.cookie } });
    expect(after.status).toBe(401);
  });

  test('revoking an unknown device is a 404', async () => {
    const response = await request('DELETE', API_PATHS.authDevice('no-such-device'));
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  test('revoking needs a session', async () => {
    const { deviceId } = await pair();
    const response = await app.request(API_PATHS.authDevice(deviceId), { method: 'DELETE' });
    expect(response.status).toBe(401);
    expect(await deps.auth.listDevices({ kind: 'static-token' })).toHaveLength(1);
  });
});

describe('POST /api/auth/pairing-codes', () => {
  test('a signed-in device gets a code', async () => {
    const response = await request('POST', API_PATHS.authPairingCodes);

    expect(response.status).toBe(200);
    const { code, expiresAt } = PairingCodeResponseSchema.parse(await response.json());
    expect(code).toBe(TEST_PAIRING_CODE);
    expect(expiresAt).toBeGreaterThan(0);
  });

  test('nobody else does', async () => {
    const response = await post(API_PATHS.authPairingCodes, {});
    expect(response.status).toBe(401);
    expect(failures).toEqual([undefined]);
  });
});
