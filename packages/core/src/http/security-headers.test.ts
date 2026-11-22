import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import type { AppEnv } from '../contracts/index.ts';
import { API_PATHS } from '../protocol/index.ts';
import { CONTENT_SECURITY_POLICY } from './security-headers.ts';
import { createLayerHarness } from './testing.ts';

const EXPECTED: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const corsHeaders = (response: Response): string[] =>
  [...response.headers.keys()].filter((name) => name.toLowerCase().startsWith('access-control-'));

describe('securityHeaders', () => {
  test('the policy is exactly the documented one', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(EXPECTED['Content-Security-Policy']);
  });

  test.each([
    ['a public route', API_PATHS.meta, {}, 200],
    ['a 401', API_PATHS.providers, {}, 401],
    ['an unknown API path', '/api/nope', { headers: { Authorization: 'Bearer x' } }, 401],
    ['an unknown page without a UI', '/nowhere', {}, 404],
    ['a host the guard refuses', API_PATHS.meta, { headers: { Host: 'evil.example' } }, 403],
    [
      'a cross-site write',
      API_PATHS.authPair,
      { method: 'POST', headers: { Origin: 'https://evil.example' } },
      403,
    ],
  ])('%s carries every fixed header', async (_label, path, options, status) => {
    const response = await createLayerHarness().send(path, options);

    expect(response.status).toBe(status);
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(response.headers.get(name), name).toBe(value);
    }
    expect(response.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(corsHeaders(response)).toEqual([]);
  });

  test('a peer the guard refuses gets the headers too', async () => {
    const response = await createLayerHarness({ host: '0.0.0.0' }).send(API_PATHS.meta, {
      peer: '192.168.1.50',
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
  });

  test('a preflight request is refused and answered without any CORS header', async () => {
    const response = await createLayerHarness().send(API_PATHS.ask, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(response.status).toBe(403);
    expect(corsHeaders(response)).toEqual([]);
  });

  test('a CORS header set by a route is removed', async () => {
    const { http } = createLayerHarness();
    const app = new Hono<AppEnv>();
    app.use(http.securityHeaders, http.clientInfo);
    app.get('/leaky', (c) => {
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Credentials', 'true');
      return c.json({ ok: true });
    });

    const response = await app.request('/leaky');

    expect(response.status).toBe(200);
    expect(corsHeaders(response)).toEqual([]);
  });

  test('API responses are not cacheable unless the route says otherwise', async () => {
    const { http } = createLayerHarness();
    const app = new Hono<AppEnv>();
    app.use(http.securityHeaders, http.clientInfo);
    app.get('/api/plain', (c) => c.json({ ok: true }));
    app.get('/api/own', (c) => c.json({ ok: true }, 200, { 'Cache-Control': 'no-cache' }));
    app.get('/page', (c) => c.text('page'));

    expect((await app.request('/api/plain')).headers.get('Cache-Control')).toBe('no-store');
    expect((await app.request('/api/own')).headers.get('Cache-Control')).toBe('no-cache');
    expect((await app.request('/page')).headers.get('Cache-Control')).toBeNull();
  });

  describe('Strict-Transport-Security', () => {
    const config = {
      publicOrigins: ['https://wall.example.com', 'http://nas.local:8080'],
      trustedProxies: ['10.0.0.2'],
    };
    const hsts = async (options: Parameters<ReturnType<typeof createLayerHarness>['send']>[1]) =>
      (await createLayerHarness(config).send(API_PATHS.meta, options)).headers.get(
        'Strict-Transport-Security',
      );
    const proxied = (host: string, proto: string) => ({
      peer: '10.0.0.2',
      headers: { Host: host, 'X-Forwarded-Proto': proto },
    });

    test('is sent for an HTTPS public origin reached securely', async () => {
      expect(await hsts(proxied('wall.example.com', 'https'))).toBe('max-age=31536000');
      expect(await hsts(proxied('wall.example.com:443', 'https'))).toBe('max-age=31536000');
    });

    test('is not sent over plain HTTP, for an http origin, or for localhost', async () => {
      expect(await hsts(proxied('wall.example.com', 'http'))).toBeNull();
      expect(await hsts(proxied('nas.local:8080', 'https'))).toBeNull();
      expect(await hsts({ headers: { Host: 'localhost' }, encrypted: true })).toBeNull();
    });

    test('a spoofed scheme from an untrusted peer does not produce it', async () => {
      expect(
        await hsts({
          peer: '127.0.0.1',
          headers: { Host: 'wall.example.com', 'X-Forwarded-Proto': 'https' },
        }),
      ).toBeNull();
    });
  });
});
