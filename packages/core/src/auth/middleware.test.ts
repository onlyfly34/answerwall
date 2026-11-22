import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppEnv, AuthContext, AuthService, Storage } from '../contracts/index.ts';
import { systemRandom } from '../system.ts';
import {
  createFakeStorage,
  createMemoryLogger,
  createSequentialIds,
  FakeClock,
} from '../testing/index.ts';
import { requireAuth, SESSION_MAX_AGE_SECONDS, SESSION_RENEW_INTERVAL_MS } from './middleware.ts';
import { createAuthService } from './service.ts';

const STATIC_TOKEN = 'automation-token-0123456789';
const PUBLIC_ROUTES = ['GET /public', 'POST /sign-in'];

let storage: Storage;
let clock: FakeClock;
let auth: AuthService;
let app: Hono<AppEnv>;
/** What the route saw, and what the request ended with. */
let seen: { auth?: AuthContext; authFailure?: boolean | undefined };
let secure: boolean;
/** The event stream route: what it is told, and how the test makes it write. */
let events: { aborted: boolean; write: (text: string) => Promise<unknown>; close: () => void };

beforeEach(() => {
  storage = createFakeStorage();
  clock = new FakeClock();
  secure = false;
  seen = {};
  auth = createAuthService({
    storage,
    clock,
    ids: createSequentialIds(),
    random: systemRandom,
    logger: createMemoryLogger(),
    mode: 'server',
    staticToken: STATIC_TOKEN,
  });
  app = new Hono<AppEnv>();
  app.onError((error, c) =>
    c.json(
      { code: error instanceof AppError ? error.code : 'internal' },
      (error instanceof AppError ? error.status : 500) as ContentfulStatusCode,
    ),
  );
  app.use(async (c, next) => {
    // The loopback address on purpose: where a request comes from must not matter.
    c.set('client', { peer: '127.0.0.1', address: '127.0.0.1', secure });
    await next();
    seen.authFailure = c.var.authFailure;
  });
  app.use(requireAuth(auth, PUBLIC_ROUTES, { clock }));
  events = { aborted: false, write: async () => undefined, close: () => undefined };
  app.get('/events', (c) => {
    c.header('Content-Type', 'text/event-stream; charset=utf-8');
    return stream(c, async (out) => {
      out.onAbort(() => {
        events.aborted = true;
      });
      events.write = (text) => out.write(text);
      await new Promise<void>((resolve) => {
        events.close = resolve;
      });
    });
  });
  app.all('*', (c) => {
    seen.auth = c.var.auth;
    return c.json({ ok: true });
  });
});

async function pairDevice() {
  const { code } = await auth.createPairingCode();
  return auth.pair({ code, deviceName: 'Phone' });
}

const cookieHeader = (token: string) => ({ Cookie: `${BRAND.sessionCookie}=${token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const setCookie = (response: Response): string => response.headers.get('Set-Cookie') ?? '';

describe('requireAuth', () => {
  test('a request without a credential is refused and is not an auth failure', async () => {
    const response = await app.request('/private');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'unauthorized' });
    expect(seen).toEqual({ authFailure: undefined });
    expect(setCookie(response)).toBe('');
  });

  test('being on loopback does not replace a credential', async () => {
    const response = await app.request('http://127.0.0.1/private', {
      headers: { Host: '127.0.0.1' },
    });
    expect(response.status).toBe(401);
  });

  test('public routes pass without a credential, matched by method and exact path', async () => {
    expect((await app.request('/public')).status).toBe(200);
    expect((await app.request('/sign-in', { method: 'POST' })).status).toBe(200);
    expect(seen.auth).toBeUndefined();

    expect((await app.request('/public', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/public/more')).status).toBe(401);
    expect((await app.request('/sign-in')).status).toBe(401);
  });

  test('a device token is accepted as bearer and as session cookie', async () => {
    const { token, device } = await pairDevice();

    expect((await app.request('/private', { headers: bearer(token) })).status).toBe(200);
    expect(seen.auth).toEqual({ kind: 'device', deviceId: device.id });

    expect((await app.request('/private', { headers: cookieHeader(token) })).status).toBe(200);
    expect(seen.auth).toEqual({ kind: 'device', deviceId: device.id });
    expect(seen.authFailure).toBeUndefined();
  });

  test('the static token is accepted', async () => {
    expect((await app.request('/private', { headers: bearer(STATIC_TOKEN) })).status).toBe(200);
    expect(seen.auth).toEqual({ kind: 'static-token' });
  });

  test.each([
    ['an unknown bearer token', { Authorization: 'Bearer not-a-real-token-0123456789' }],
    ['an unknown cookie', { Cookie: `${BRAND.sessionCookie}=not-a-real-token-0123456789` }],
  ])('%s is refused and flagged as an auth failure', async (_label, headers) => {
    const response = await app.request('/private', { headers });

    expect(response.status).toBe(401);
    expect(seen).toEqual({ authFailure: true });
  });

  test('a revoked device is refused, flagged, and its dead cookie is cleared', async () => {
    const { token, device } = await pairDevice();
    await auth.revokeDevice(device.id);

    const response = await app.request('/private', { headers: cookieHeader(token) });

    expect(response.status).toBe(401);
    expect(seen.authFailure).toBe(true);
    expect(setCookie(response)).toMatch(new RegExp(`^${BRAND.sessionCookie}=; Max-Age=0; Path=/`));
  });

  test('a rejected bearer token does not touch cookies', async () => {
    const response = await app.request('/private', { headers: bearer('wrong-token-0123456789') });
    expect(setCookie(response)).toBe('');
  });

  test.each(['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer two words', 'Token abc'])(
    'the header "%s" is not a bearer credential',
    async (authorization) => {
      const response = await app.request('/private', { headers: { Authorization: authorization } });
      expect(response.status).toBe(401);
      expect(seen.authFailure).toBeUndefined();
    },
  );

  test('the bearer token wins over a cookie sent along with it', async () => {
    const { token } = await pairDevice();

    const response = await app.request('/private', {
      headers: { ...bearer(STATIC_TOKEN), ...cookieHeader(token) },
    });

    expect(response.status).toBe(200);
    expect(seen.auth).toEqual({ kind: 'static-token' });
  });

  test('a valid cookie does not rescue a wrong bearer token', async () => {
    const { token } = await pairDevice();

    const response = await app.request('/private', {
      headers: { ...bearer('wrong-token-0123456789'), ...cookieHeader(token) },
    });

    expect(response.status).toBe(401);
    expect(seen.authFailure).toBe(true);
  });

  test('a cookie of another name is no credential', async () => {
    const { token } = await pairDevice();
    const response = await app.request('/private', { headers: { Cookie: `session=${token}` } });
    expect(response.status).toBe(401);
    expect(seen.authFailure).toBeUndefined();
  });
});

describe('session cookie renewal', () => {
  test('a cookie session gets a fresh cookie on a read, once per interval', async () => {
    const { token } = await pairDevice();
    const read = () => app.request('/private', { headers: cookieHeader(token) });

    const first = setCookie(await read());
    expect(first).toContain(`${BRAND.sessionCookie}=${token};`);
    expect(first).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(first).toContain('HttpOnly');
    expect(first).toContain('SameSite=Strict');
    expect(first).toContain('Path=/');
    expect(first).not.toContain('Secure');

    expect(setCookie(await read())).toBe('');
    await clock.advance(SESSION_RENEW_INTERVAL_MS - 1);
    expect(setCookie(await read())).toBe('');
    await clock.advance(1);
    expect(setCookie(await read())).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });

  test('the renewed cookie is Secure when the request is', async () => {
    const { token } = await pairDevice();
    secure = true;

    const response = await app.request('/private', { headers: cookieHeader(token) });

    expect(setCookie(response)).toContain('Secure');
  });

  test('each device is renewed on its own schedule', async () => {
    const first = await pairDevice();
    const second = await pairDevice();

    expect(setCookie(await app.request('/a', { headers: cookieHeader(first.token) }))).not.toBe('');
    expect(setCookie(await app.request('/a', { headers: cookieHeader(second.token) }))).not.toBe(
      '',
    );
  });

  test('bearer clients and writes never get a cookie', async () => {
    const { token } = await pairDevice();

    expect(setCookie(await app.request('/private', { headers: bearer(token) }))).toBe('');
    expect(
      setCookie(await app.request('/private', { method: 'POST', headers: cookieHeader(token) })),
    ).toBe('');
    // The write did not use up the renewal.
    expect(setCookie(await app.request('/private', { headers: cookieHeader(token) }))).not.toBe('');
  });
});

describe('an open event stream', () => {
  const decoder = new TextDecoder();
  async function open(headers: Record<string, string>) {
    const response = await app.request('/events', { headers });
    expect(response.status).toBe(200);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const next = async (): Promise<string | null> => {
      const { done, value } = await reader.read();
      return done ? null : decoder.decode(value);
    };
    return { response, next };
  }

  test('ends when its device is revoked, and the route is told like for a lost client', async () => {
    const { token, device } = await pairDevice();
    const { next } = await open(cookieHeader(token));
    await events.write('first');
    expect(await next()).toBe('first');

    await auth.revokeDevice(device.id);

    expect(await next()).toBeNull();
    await expect.poll(() => events.aborted).toBe(true);
    expect((await app.request('/events', { headers: cookieHeader(token) })).status).toBe(401);
  });

  test('ends when its device signs out, also while a read is waiting', async () => {
    const { token, device } = await pairDevice();
    const { next } = await open(bearer(token));
    const waiting = next();

    await auth.logout({ kind: 'device', deviceId: device.id });

    expect(await waiting).toBeNull();
  });

  test.each(['another device', 'the static token'])('of %s stays open', async (holder) => {
    const revoked = await pairDevice();
    const other = await pairDevice();
    const { next } = await open(
      holder === 'the static token' ? bearer(STATIC_TOKEN) : cookieHeader(other.token),
    );

    await auth.revokeDevice(revoked.device.id);
    await events.write('still here');

    expect(await next()).toBe('still here');
    expect(events.aborted).toBe(false);
  });

  test('that ends by itself is passed through unchanged, with the renewed cookie', async () => {
    const { token } = await pairDevice();
    const { response, next } = await open(cookieHeader(token));
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(setCookie(response)).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);

    await events.write('only');
    events.close();

    expect(await next()).toBe('only');
    expect(await next()).toBeNull();
    expect(events.aborted).toBe(false);
  });

  test('a response that is not an event stream is not touched', async () => {
    const { token, device } = await pairDevice();
    const response = await app.request('/private', { headers: cookieHeader(token) });

    await auth.revokeDevice(device.id);

    expect(await response.json()).toEqual({ ok: true });
  });
});
