import { describe, expect, test } from 'vitest';
import type { AppConfig } from '../contracts/index.ts';
import { API_PATHS } from '../protocol/index.ts';
import { FakeClock, TEST_PAIRING_CODE, TEST_TOKEN } from '../testing/index.ts';
import { AUTH_FAILURE_WINDOW_MS, createFailureLimiter } from './rate-limit.ts';
import { createLayerHarness } from './testing.ts';
import type { LayerHarness, SendOptions } from './testing.ts';

describe('createFailureLimiter', () => {
  const setup = (options: { maxKeys?: number; maxFailuresKept?: number } = {}) => {
    const clock = new FakeClock();
    const limiter = createFailureLimiter({ clock, maxFailuresKept: 100, ...options });
    return { clock, limiter };
  };

  test('a key is free until it reaches the limit', () => {
    const { limiter } = setup();
    for (let failure = 0; failure < 3; failure++) {
      expect(limiter.retryAfterMs('a', 3)).toBe(0);
      limiter.record('a');
    }
    expect(limiter.retryAfterMs('a', 3)).toBe(AUTH_FAILURE_WINDOW_MS);
    expect(limiter.retryAfterMs('b', 3)).toBe(0);
  });

  test('the window slides: each failure leaves it one window after it happened', async () => {
    const { clock, limiter } = setup();
    limiter.record('a');
    await clock.advance(20_000);
    limiter.record('a');
    await clock.advance(20_000);
    limiter.record('a');

    // Blocked until the first failure is a minute old.
    expect(limiter.retryAfterMs('a', 3)).toBe(20_000);
    await clock.advance(19_999);
    expect(limiter.retryAfterMs('a', 3)).toBe(1);
    await clock.advance(1);
    expect(limiter.retryAfterMs('a', 3)).toBe(0);

    // One slot is free; using it blocks until the second failure leaves.
    limiter.record('a');
    expect(limiter.retryAfterMs('a', 3)).toBe(20_000);
  });

  test('a lowered limit applies to failures already counted', () => {
    const { limiter } = setup();
    for (let failure = 0; failure < 4; failure++) limiter.record('a');
    expect(limiter.retryAfterMs('a', 10)).toBe(0);
    expect(limiter.retryAfterMs('a', 4)).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('a', 2)).toBeGreaterThan(0);
  });

  test('attempts that are still running count until they finish', () => {
    const { limiter } = setup();
    limiter.record('a');
    const finishFirst = limiter.begin('a');
    const finishSecond = limiter.begin('a');

    expect(limiter.retryAfterMs('a', 3)).toBe(1000);
    finishFirst();
    finishFirst();
    expect(limiter.retryAfterMs('a', 3)).toBe(0);
    finishSecond();
    expect(limiter.retryAfterMs('a', 2)).toBe(0);
    expect(limiter.retryAfterMs('b', 1)).toBe(0);
  });

  test('keys whose failures have all expired are forgotten', async () => {
    const { clock, limiter } = setup();
    limiter.record('a');
    limiter.record('b');
    expect(limiter.size).toBe(2);

    await clock.advance(AUTH_FAILURE_WINDOW_MS);
    expect(limiter.retryAfterMs('a', 1)).toBe(0);
    expect(limiter.size).toBe(1);
  });

  test('memory is bounded: beyond the cap the key that failed longest ago is dropped', async () => {
    const { clock, limiter } = setup({ maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) {
      limiter.record(key);
      await clock.advance(1000);
    }
    limiter.record('a');
    limiter.record('d');

    expect(limiter.size).toBe(3);
    expect(limiter.retryAfterMs('b', 1)).toBe(0);
    for (const key of ['a', 'c', 'd']) expect(limiter.retryAfterMs(key, 1)).toBeGreaterThan(0);
  });

  test('expired keys make room before a live one is dropped', async () => {
    const { clock, limiter } = setup({ maxKeys: 2 });
    limiter.record('old');
    await clock.advance(AUTH_FAILURE_WINDOW_MS);
    limiter.record('a');
    limiter.record('b');

    expect(limiter.size).toBe(2);
    expect(limiter.retryAfterMs('a', 1)).toBeGreaterThan(0);
    expect(limiter.retryAfterMs('b', 1)).toBeGreaterThan(0);
  });

  test('a flood from one key keeps a bounded number of timestamps and stays blocked', () => {
    const { limiter } = setup({ maxFailuresKept: 5 });
    for (let failure = 0; failure < 1000; failure++) limiter.record('a');
    expect(limiter.size).toBe(1);
    expect(limiter.retryAfterMs('a', 5)).toBe(AUTH_FAILURE_WINDOW_MS);
  });

  test('ten thousand distinct clients do not grow the table beyond its cap', () => {
    const { limiter } = setup();
    for (let client = 0; client < 12_000; client++) limiter.record(`client-${client}`);
    expect(limiter.size).toBe(10_000);
  });
});

describe('authRateLimit', () => {
  const LIMIT = 10;
  const json = { 'Content-Type': 'application/json', Origin: 'http://localhost' };

  const pair = (harness: LayerHarness, code: string, options: SendOptions = {}) =>
    harness.send(API_PATHS.authPair, {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: 'Phone' }),
      ...options,
      headers: { ...json, ...options.headers },
    });
  const wrongPair = (harness: LayerHarness, options?: SendOptions) =>
    pair(harness, '00000000', options);
  const rightPair = (harness: LayerHarness, options?: SendOptions) =>
    pair(harness, TEST_PAIRING_CODE, options);

  async function exhaust(harness: LayerHarness, options?: SendOptions, count = LIMIT) {
    for (let attempt = 0; attempt < count; attempt++) {
      expect((await wrongPair(harness, options)).status).toBe(401);
    }
  }

  test('after ten failed attempts in a minute the address is refused, right code or not', async () => {
    const harness = createLayerHarness();
    await exhaust(harness);

    const response = await rightPair(harness);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many failed sign-in attempts. Try again later.',
      },
    });
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  test('nine failures leave room for the right code', async () => {
    const harness = createLayerHarness();
    await exhaust(harness, undefined, LIMIT - 1);
    expect((await rightPair(harness)).status).toBe(200);
  });

  test('the block ends when the oldest failure is a minute old', async () => {
    const harness = createLayerHarness();
    await wrongPair(harness);
    await harness.clock.advance(30_000);
    await exhaust(harness, undefined, LIMIT - 1);

    const blocked = await rightPair(harness);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('30');

    await harness.clock.advance(29_999);
    expect((await rightPair(harness)).status).toBe(429);
    await harness.clock.advance(1);
    expect((await rightPair(harness)).status).toBe(200);
  });

  test('refused requests do not extend the block', async () => {
    const harness = createLayerHarness();
    await exhaust(harness);
    for (let attempt = 0; attempt < 50; attempt++) {
      await harness.clock.advance(1000);
      expect((await wrongPair(harness)).status).toBe(429);
    }
    await harness.clock.advance(10_000);
    expect((await rightPair(harness)).status).toBe(200);
  });

  test('successful sign-ins are not counted', async () => {
    const harness = createLayerHarness();
    for (let attempt = 0; attempt < LIMIT * 2; attempt++) {
      const response = await harness.send(API_PATHS.authSession, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: TEST_TOKEN }),
      });
      expect(response.status).toBe(200);
    }
  });

  test('wrong bearer tokens and wrong session tokens count like wrong codes', async () => {
    const harness = createLayerHarness();
    for (let attempt = 0; attempt < LIMIT / 2; attempt++) {
      const bearer = await harness.send(API_PATHS.providers, {
        headers: { Authorization: 'Bearer wrong-token-0123456789' },
      });
      expect(bearer.status).toBe(401);
      const session = await harness.send(API_PATHS.authSession, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ token: 'wrong-token-0123456789' }),
      });
      expect(session.status).toBe(401);
    }

    const valid = await harness.send(API_PATHS.providers, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(valid.status).toBe(429);
  });

  test('requests without a credential are neither counted nor blocked', async () => {
    const harness = createLayerHarness();
    for (let attempt = 0; attempt < LIMIT * 3; attempt++) {
      expect((await harness.send(API_PATHS.providers)).status).toBe(401);
    }
    expect((await rightPair(harness)).status).toBe(200);

    await exhaust(harness);
    // The sign-in page still loads and can explain what happened.
    expect((await harness.send(API_PATHS.meta)).status).toBe(200);
    expect((await harness.send(API_PATHS.providers)).status).toBe(401);
  });

  test('malformed sign-in requests are not failed attempts', async () => {
    const harness = createLayerHarness();
    for (let attempt = 0; attempt < LIMIT * 2; attempt++) {
      expect((await pair(harness, 'abc')).status).toBe(400);
    }
    expect((await rightPair(harness)).status).toBe(200);
  });

  test('each client address has its own count', async () => {
    const harness = createLayerHarness({ host: '0.0.0.0', allowInsecure: true });
    await exhaust(harness, { peer: '192.168.1.50' });

    expect((await rightPair(harness, { peer: '192.168.1.50' })).status).toBe(429);
    expect((await rightPair(harness, { peer: '192.168.1.51' })).status).toBe(200);
    expect((await rightPair(harness, { peer: '127.0.0.1' })).status).toBe(200);
  });

  test('IPv6 clients are counted per /64', async () => {
    const harness = createLayerHarness({ host: '::', allowInsecure: true });
    for (let attempt = 0; attempt < LIMIT; attempt++) {
      await wrongPair(harness, { peer: `2001:db8:1:2::${(attempt + 1).toString(16)}` });
    }

    expect((await rightPair(harness, { peer: '2001:db8:1:2:ffff::1' })).status).toBe(429);
    expect((await rightPair(harness, { peer: '2001:db8:1:3::1' })).status).toBe(200);
  });

  describe('behind a trusted proxy', () => {
    const PROXIED: Partial<AppConfig> = {
      host: '0.0.0.0',
      trustedProxies: ['10.0.0.2'],
      publicOrigins: ['https://wall.example.com'],
    };
    const through = (client: string): SendOptions => ({
      peer: '10.0.0.2',
      headers: {
        Host: 'wall.example.com',
        Origin: 'https://wall.example.com',
        'X-Forwarded-For': client,
        'X-Forwarded-Proto': 'https',
      },
    });

    test('the forwarded client address is the key, not the proxy', async () => {
      const harness = createLayerHarness(PROXIED);
      await exhaust(harness, through('203.0.113.7'));

      expect((await rightPair(harness, through('203.0.113.7'))).status).toBe(429);
      expect((await rightPair(harness, through('203.0.113.8'))).status).toBe(200);
    });

    test('an attacker cannot reset the count by prepending addresses', async () => {
      const harness = createLayerHarness(PROXIED);
      for (let attempt = 0; attempt < LIMIT; attempt++) {
        // The proxy appends the real address; what the client sent comes first.
        await wrongPair(harness, through(`198.51.100.${attempt}, 203.0.113.7`));
      }
      expect((await rightPair(harness, through('1.2.3.4, 203.0.113.7'))).status).toBe(429);
    });

    test('forwarded headers from an untrusted peer do not change the key', async () => {
      const harness = createLayerHarness({ ...PROXIED, allowInsecure: true });
      const direct = (spoofed: string): SendOptions => ({
        peer: '192.168.1.50',
        headers: { 'X-Forwarded-For': spoofed },
      });
      for (let attempt = 0; attempt < LIMIT; attempt++) {
        await wrongPair(harness, direct(`198.51.100.${attempt}`));
      }

      expect((await rightPair(harness, direct('198.51.100.200'))).status).toBe(429);
      // The address it posed as is not blocked either.
      expect((await rightPair(harness, through('198.51.100.1'))).status).toBe(200);
    });
  });

  test('the limit follows the setting', async () => {
    const harness = createLayerHarness();
    await harness.settings.update({ limits: { authFailuresPerMinute: 3 } });
    await exhaust(harness, undefined, 3);
    expect((await rightPair(harness)).status).toBe(429);

    await harness.settings.update({ limits: { authFailuresPerMinute: 4 } });
    expect((await rightPair(harness)).status).toBe(200);
  });

  test('parallel guesses cannot outrun the counter', async () => {
    const harness = createLayerHarness();
    const responses = await Promise.all(
      Array.from({ length: LIMIT * 3 }, () => wrongPair(harness)),
    );
    const statuses = responses.map((response) => response.status);

    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(LIMIT);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(LIMIT * 2);
  });
});
