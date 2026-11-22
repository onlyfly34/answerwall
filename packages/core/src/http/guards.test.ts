import { describe, expect, test } from 'vitest';
import { BRAND } from '../brand.ts';
import type { AppConfig, TlsConfig } from '../contracts/index.ts';
import { API_PATHS } from '../protocol/index.ts';
import { TEST_PAIRING_CODE, TEST_TOKEN } from '../testing/index.ts';
import { createHttpLayer } from './index.ts';
import { createLayerHarness } from './testing.ts';
import type { SendOptions } from './testing.ts';

const errorOf = async (response: Response): Promise<{ code?: string; message?: string }> =>
  ((await response.json()) as { error?: { code?: string; message?: string } }).error ?? {};

describe('peerGuard', () => {
  const status = async (config: Partial<AppConfig>, options: SendOptions): Promise<number> =>
    (await createLayerHarness(config).probe(['clientInfo', 'peerGuard'])('/', options)).status;

  const LAN = { host: '0.0.0.0' } satisfies Partial<AppConfig>;

  test.each(['192.168.1.50', '10.1.2.3', '203.0.113.7', '::ffff:192.168.1.50', 'fe80::1', '::'])(
    'plain HTTP on a non-loopback bind refuses the peer %s',
    async (peer) => {
      const response = await createLayerHarness(LAN).probe(['clientInfo', 'peerGuard'])('/', {
        peer,
      });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        code: 'forbidden',
        message: 'Plain HTTP is accepted only from this machine or a trusted proxy',
      });
    },
  );

  test.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'])(
    'the loopback peer %s is always accepted',
    async (peer) => {
      expect(await status(LAN, { peer })).toBe(200);
    },
  );

  test('a trusted proxy is accepted, an address next to its range is not', async () => {
    const config = { ...LAN, trustedProxies: ['172.18.0.0/16', 'fd00::5'] };
    expect(await status(config, { peer: '172.18.0.2' })).toBe(200);
    expect(await status(config, { peer: '::ffff:172.18.255.255' })).toBe(200);
    expect(await status(config, { peer: 'fd00::5' })).toBe(200);
    expect(await status(config, { peer: '172.19.0.2' })).toBe(403);
    expect(await status(config, { peer: 'fd00::6' })).toBe(403);
  });

  test('forwarded headers do not turn a stranger into a local or trusted client', async () => {
    const config = { ...LAN, trustedProxies: ['172.18.0.2'] };
    const headers = {
      'X-Forwarded-For': '127.0.0.1, 172.18.0.2',
      'X-Forwarded-Proto': 'https',
      'X-Real-IP': '127.0.0.1',
      Forwarded: 'for=127.0.0.1;proto=https',
    };
    expect(await status(config, { peer: '192.168.1.50', headers })).toBe(403);
  });

  test('a request whose peer cannot be determined is refused', async () => {
    expect(await status(LAN, { peer: null })).toBe(403);
  });

  test('allow-insecure lifts the restriction', async () => {
    expect(await status({ ...LAN, allowInsecure: true }, { peer: '192.168.1.50' })).toBe(200);
  });

  test.each<[string, TlsConfig]>([
    ['cert', { mode: 'cert', certFile: 'c.pem', keyFile: 'k.pem' }],
    ['auto', { mode: 'auto', hostnames: ['nas.local'] }],
  ])('with TLS %s any peer may connect', async (_mode, tls) => {
    expect(await status({ ...LAN, tls }, { peer: '192.168.1.50', encrypted: true })).toBe(200);
  });

  test.each(['127.0.0.1', '::1', '[::1]', 'localhost', '127.0.0.53'])(
    'a bind on %s needs no restriction',
    async (host) => {
      expect(await status({ host }, { peer: '192.168.1.50' })).toBe(200);
    },
  );

  test.each(['0.0.0.0', '::', '192.168.1.10', 'nas.local'])(
    'a bind on %s is restricted',
    async (host) => {
      expect(await status({ host }, { peer: '192.168.1.50' })).toBe(403);
    },
  );

  test('the whole app is closed to a LAN peer, including public routes and the UI', async () => {
    const harness = createLayerHarness(LAN);
    expect((await harness.send(API_PATHS.meta, { peer: '192.168.1.50' })).status).toBe(403);
    expect((await harness.send('/', { peer: '192.168.1.50' })).status).toBe(403);
    expect((await harness.send(API_PATHS.meta, { peer: '127.0.0.1' })).status).toBe(200);
  });
});

describe('hostGuard', () => {
  const ORIGINS = {
    publicOrigins: [
      'https://wall.example.com',
      'http://nas.local:8080',
      'https://[2001:db8::1]:8443',
    ],
  };
  const status = async (config: Partial<AppConfig>, host: string | null): Promise<number> => {
    const { http } = createLayerHarness(config);
    // Driven directly, so that a request without any Host header can be expressed too.
    const headers = new Headers(host === null ? {} : { Host: host });
    let passed = false;
    try {
      await http.hostGuard(
        { req: { header: (name: string) => headers.get(name) ?? undefined } } as never,
        async () => {
          passed = true;
        },
      );
    } catch {
      return 403;
    }
    return passed ? 200 : 500;
  };

  test.each([
    'localhost',
    'localhost:7717',
    'LOCALHOST:7717',
    '127.0.0.1',
    '127.0.0.1:49152',
    '[::1]',
    '[::1]:7717',
  ])('the loopback name %s is allowed on any port', async (host) => {
    expect(await status({}, host)).toBe(200);
  });

  test.each([
    'wall.example.com',
    'wall.example.com:443',
    'Wall.Example.COM',
    'nas.local:8080',
    '[2001:db8::1]:8443',
  ])('the configured public host %s is allowed', async (host) => {
    expect(await status(ORIGINS, host)).toBe(200);
  });

  test.each([
    // DNS rebinding: the attacker's name resolves to this server.
    'evil.example',
    'evil.example:7717',
    'localhost.evil.example',
    '127.0.0.1.nip.io',
    'wall.example.com.evil.example',
    'evilwall.example.com',
    // The right name on a port that was not configured.
    'wall.example.com:8443',
    'wall.example.com:80',
    'nas.local',
    'nas.local:80',
    '[2001:db8::1]',
    '[2001:db8::2]:8443',
    // Addresses that were never configured.
    '192.168.1.10',
    '192.168.1.10:7717',
    '0.0.0.0:7717',
    '127.0.0.2',
    // Malformed values.
    '',
    'localhost.',
    'localhost:',
    'localhost:http',
    'localhost:7717:7717',
    'localhost:123456',
    'user@localhost',
    'localhost/evil.example',
    'localhost evil.example',
    'localhost,evil.example',
    '::1',
  ])('the host "%s" is refused', async (host) => {
    expect(await status(ORIGINS, host)).toBe(403);
  });

  test('a request without a Host header is refused', async () => {
    expect(await status({}, null)).toBe(403);
  });

  test('without public origins only loopback names get in', async () => {
    expect(await status({}, 'wall.example.com')).toBe(403);
    expect(await status({}, 'localhost:7717')).toBe(200);
  });

  test('a refused host gets a JSON 403 from the app, before any route or file', async () => {
    const harness = createLayerHarness();
    for (const path of [API_PATHS.meta, '/', API_PATHS.authPair]) {
      const response = await harness.send(path, { headers: { Host: 'evil.example' } });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        code: 'forbidden',
        message: 'This host name is not allowed',
      });
    }
    expect((await harness.send(API_PATHS.meta)).status).toBe(200);
  });

  test.each([
    'wall.example.com',
    'https://wall.example.com/path',
    'ftp://wall.example.com',
    'https://',
  ])('the malformed public origin "%s" is a configuration error', (origin) => {
    const harness = createLayerHarness();
    expect(() =>
      createHttpLayer({
        config: { ...harness.deps.config, publicOrigins: [origin] },
        settings: harness.settings,
        clock: harness.clock,
        logger: harness.logger,
      }),
    ).toThrow();
  });
});

describe('originGuard', () => {
  const PUBLIC = { publicOrigins: ['https://wall.example.com'], trustedProxies: ['10.0.0.2'] };
  const pairBody = JSON.stringify({ code: TEST_PAIRING_CODE, deviceName: 'Phone' });
  const json = { 'Content-Type': 'application/json' };

  /** A pairing request: public, so the origin guard alone decides. */
  const pair = (config: Partial<AppConfig>, options: SendOptions) =>
    createLayerHarness(config).send(API_PATHS.authPair, {
      method: 'POST',
      body: pairBody,
      ...options,
      headers: { ...json, ...options.headers },
    });

  test('a same-origin browser request on loopback passes', async () => {
    const response = await pair(
      {},
      { headers: { Host: 'localhost:7717', Origin: 'http://localhost:7717' } },
    );
    expect(response.status).toBe(200);
  });

  test.each([
    ['127.0.0.1:7717', 'http://127.0.0.1:7717'],
    ['[::1]:7717', 'http://[::1]:7717'],
    ['localhost', 'http://localhost'],
    ['localhost:80', 'http://localhost'],
  ])('host %s with origin %s is same-origin', async (host, origin) => {
    expect((await pair({}, { headers: { Host: host, Origin: origin } })).status).toBe(200);
  });

  test('HTTPS on loopback needs an https origin', async () => {
    const headers = { Host: 'localhost:7717', Origin: 'https://localhost:7717' };
    expect((await pair({}, { headers, encrypted: true })).status).toBe(200);
    expect((await pair({}, { headers, encrypted: false })).status).toBe(403);
  });

  test.each([
    ['another site', 'https://evil.example'],
    ['a look-alike of the host', 'http://localhost.evil.example:7717'],
    ['another port on this machine', 'http://localhost:3000'],
    ['another loopback name for the same port', 'http://127.0.0.1:7717'],
    ['the wrong scheme', 'https://localhost:7717'],
    ['an opaque origin', 'null'],
    ['an empty origin', ''],
    ['an origin with a path', 'http://localhost:7717/'],
    ['something that is not a URL', 'localhost:7717'],
  ])('a request from %s is refused', async (_label, origin) => {
    const response = await pair({}, { headers: { Host: 'localhost:7717', Origin: origin } });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
  });

  test('a public origin is accepted through the proxy, and only that one', async () => {
    const proxied = { peer: '10.0.0.2', headers: { Host: 'wall.example.com' } };
    const withOrigin = (origin: string) =>
      pair(PUBLIC, { ...proxied, headers: { ...proxied.headers, Origin: origin } });

    expect((await withOrigin('https://wall.example.com')).status).toBe(200);
    expect((await withOrigin('http://wall.example.com')).status).toBe(403);
    expect((await withOrigin('https://wall.example.com:8443')).status).toBe(403);
    expect((await withOrigin('https://other.example.com')).status).toBe(403);
  });

  test('a cross-site form post with a valid session cookie never reaches the route', async () => {
    const harness = createLayerHarness();
    const paired = await harness.send(API_PATHS.authPair, {
      method: 'POST',
      headers: { ...json, Origin: 'http://localhost' },
      body: pairBody,
    });
    const cookie = (paired.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain(BRAND.sessionCookie);

    const forged = await harness.send(API_PATHS.authLogout, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://evil.example',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'a=b',
    });
    expect(forged.status).toBe(403);

    // The session is still alive: the forged logout did nothing.
    const devices = await harness.send(API_PATHS.authDevices, { headers: { Cookie: cookie } });
    expect(devices.status).toBe(200);
  });

  describe('the page of a browser extension', () => {
    const ID = 'abcdefghijklmnopabcdefghijklmnop';
    const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
    const origin = (id: string) => ({ Origin: `chrome-extension://${id}` });

    async function harnessWith(webCells: { enabled: boolean; extensionIds: string[] }) {
      const harness = createLayerHarness();
      await harness.settings.update({ webCells });
      return harness;
    }
    const allowed = () => harnessWith({ enabled: true, extensionIds: [ID] });
    const pairFrom = (
      harness: Awaited<ReturnType<typeof allowed>>,
      headers: Record<string, string>,
    ) =>
      harness.send(API_PATHS.authPair, {
        method: 'POST',
        body: pairBody,
        headers: { ...json, ...headers },
      });

    test('is refused by default, on writes and on reads', async () => {
      const harness = createLayerHarness();
      expect((await pairFrom(harness, origin(ID))).status).toBe(403);
      const read = await harness.send(API_PATHS.meta, { headers: origin(ID) });
      expect(read.status).toBe(403);
      expect((await errorOf(read)).code).toBe('forbidden');
    });

    test('passes when web cells are on and its id is on the allowlist', async () => {
      const harness = await allowed();
      const paired = await pairFrom(harness, origin(ID));
      expect(paired.status).toBe(200);
      expect((await harness.send(API_PATHS.meta, { headers: origin(ID) })).status).toBe(200);
      const authed = await harness.send(API_PATHS.settings, {
        headers: { ...origin(ID), Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(authed.status).toBe(200);
    });

    test('is not answered with any CORS header, allowed or not', async () => {
      const harness = await allowed();
      for (const id of [ID, OTHER_ID]) {
        const responses = [
          await pairFrom(harness, origin(id)),
          await harness.send(API_PATHS.meta, { headers: origin(id) }),
          await harness.send(API_PATHS.authPair, {
            method: 'OPTIONS',
            headers: {
              ...origin(id),
              'Access-Control-Request-Method': 'POST',
              'Access-Control-Request-Headers': 'authorization,content-type',
            },
          }),
        ];
        for (const response of responses) {
          const names = [...response.headers.keys()].filter((name) =>
            name.toLowerCase().startsWith('access-control-'),
          );
          expect(names).toEqual([]);
        }
      }
    });

    test('another extension is refused while one is allowed', async () => {
      const harness = await allowed();
      expect((await pairFrom(harness, origin(OTHER_ID))).status).toBe(403);
      expect((await harness.send(API_PATHS.meta, { headers: origin(OTHER_ID) })).status).toBe(403);
    });

    test('the allowlist means nothing while web cells are off', async () => {
      const harness = await harnessWith({ enabled: false, extensionIds: [ID] });
      expect((await pairFrom(harness, origin(ID))).status).toBe(403);
    });

    test('a change of the settings takes effect on the next request', async () => {
      const harness = await allowed();
      expect((await pairFrom(harness, origin(ID))).status).toBe(200);
      await harness.settings.update({ webCells: { extensionIds: [] } });
      expect((await pairFrom(harness, origin(ID))).status).toBe(403);
    });

    test.each([
      ['an id with a path', `chrome-extension://${ID}/`],
      ['an id as a subdomain of something else', `chrome-extension://${ID}.evil.example`],
      ['the id under a web scheme', `https://${ID}`],
      ['an extension of another browser family', `moz-extension://${ID}`],
      ['an upper-case id', `chrome-extension://${ID.toUpperCase()}`],
    ])('%s does not match the allowlist', async (_label, value) => {
      const harness = await allowed();
      expect((await pairFrom(harness, { Origin: value })).status).toBe(403);
    });

    test('never together with the session cookie, not even when allowed', async () => {
      const harness = await allowed();
      const browser = await harness.send(API_PATHS.authPair, {
        method: 'POST',
        headers: { ...json, Origin: 'http://localhost' },
        body: pairBody,
      });
      const cookie = (browser.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
      expect(cookie).toContain(BRAND.sessionCookie);

      const read = await harness.send(API_PATHS.authDevices, {
        headers: { ...origin(ID), Cookie: cookie },
      });
      expect(read.status).toBe(403);
      const write = await harness.send(API_PATHS.authLogout, {
        method: 'POST',
        headers: { ...json, ...origin(ID), Cookie: cookie },
        body: '{}',
      });
      expect(write.status).toBe(403);
      // The cookie's session is untouched.
      const own = await harness.send(API_PATHS.authDevices, { headers: { Cookie: cookie } });
      expect(own.status).toBe(200);
    });

    test('still needs a JSON body on writes and a credential on protected routes', async () => {
      const harness = await allowed();
      const form = await harness.send(API_PATHS.authPair, {
        method: 'POST',
        headers: { ...origin(ID), 'Content-Type': 'text/plain' },
        body: pairBody,
      });
      expect(form.status).toBe(415);
      const anonymous = await harness.send(API_PATHS.settings, { headers: origin(ID) });
      expect(anonymous.status).toBe(401);
    });

    test('the same-origin browser path is unchanged by an allowlist', async () => {
      const harness = await allowed();
      const sameOrigin = await harness.send(API_PATHS.authPair, {
        method: 'POST',
        headers: { ...json, Host: 'localhost:7717', Origin: 'http://localhost:7717' },
        body: pairBody,
      });
      expect(sameOrigin.status).toBe(200);
      expect(sameOrigin.headers.get('Set-Cookie')).toContain(BRAND.sessionCookie);
      expect(await sameOrigin.json()).not.toHaveProperty('token');
      const crossSite = await harness.send(API_PATHS.authPair, {
        method: 'POST',
        headers: { ...json, Host: 'localhost:7717', Origin: 'https://evil.example' },
        body: pairBody,
      });
      expect(crossSite.status).toBe(403);
    });
  });

  describe('without an Origin header', () => {
    const bearer = { Authorization: `Bearer ${TEST_TOKEN}` };
    const cookie = { Cookie: `${BRAND.sessionCookie}=${TEST_TOKEN}` };
    const logout = (headers: Record<string, string>) =>
      createLayerHarness().send(API_PATHS.authLogout, {
        method: 'POST',
        headers: { ...json, ...headers },
        body: '{}',
      });

    test('a bearer-only client passes', async () => {
      expect((await logout(bearer)).status).toBe(200);
    });

    test('a session cookie alone is refused', async () => {
      const response = await logout(cookie);
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        code: 'forbidden',
        message: 'Origin header required',
      });
    });

    test('a bearer token next to a session cookie is refused', async () => {
      expect((await logout({ ...bearer, ...cookie })).status).toBe(403);
    });

    test('a request with no credential at all is refused', async () => {
      expect((await logout({})).status).toBe(403);
      expect((await pair({}, {})).status).toBe(403);
    });

    test('an unrelated cookie does not block a bearer client', async () => {
      expect((await logout({ ...bearer, Cookie: 'theme=dark' })).status).toBe(200);
    });
  });

  describe('Content-Type', () => {
    const send = (contentType: string | undefined, method = 'POST') =>
      createLayerHarness().send(API_PATHS.authLogout, {
        method,
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
        },
        ...(contentType === undefined ? {} : { body: '{}' }),
      });

    test.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
      '%s is accepted',
      async (contentType) => {
        expect((await send(contentType)).status).toBe(200);
      },
    );

    test.each([
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/jsonp',
      'text/json',
      undefined,
    ])('%s is refused with 415', async (contentType) => {
      const response = await send(contentType);
      expect(response.status).toBe(415);
      expect((await errorOf(response)).code).toBe('unsupported_media_type');
    });

    test.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s is held to the same rules', async (m) => {
      expect((await send(undefined, m)).status).toBe(415);
      const anonymous = await createLayerHarness().send(API_PATHS.settings, { method: m });
      expect(anonymous.status).toBe(403);
    });
  });

  test('reads need neither an origin nor a content type', async () => {
    const harness = createLayerHarness();
    expect((await harness.send(API_PATHS.meta)).status).toBe(200);
    expect((await harness.send(API_PATHS.meta, { method: 'HEAD' })).status).not.toBe(403);
    const cross = await harness.send(API_PATHS.meta, {
      headers: { Origin: 'https://evil.example' },
    });
    // Readable only by same-origin pages: no CORS header is ever sent.
    expect(cross.status).toBe(200);
    expect(cross.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
