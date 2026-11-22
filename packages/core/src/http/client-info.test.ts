import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import type { AppConfig, AppEnv, ClientInfo } from '../contracts/index.ts';
import { createLayerHarness } from './testing.ts';
import type { SendOptions } from './testing.ts';

async function clientOf(config: Partial<AppConfig>, options: SendOptions): Promise<ClientInfo> {
  const response = await createLayerHarness(config).probe(['clientInfo'])('/', options);
  return ((await response.json()) as { client: ClientInfo }).client;
}

const PROXIES = { trustedProxies: ['10.0.0.0/8', 'fd00::/8'] };

describe('without trusted proxies', () => {
  test('the client is the socket peer over plain HTTP', async () => {
    expect(await clientOf({}, { peer: '203.0.113.7' })).toEqual({
      peer: '203.0.113.7',
      address: '203.0.113.7',
      secure: false,
    });
  });

  test('forwarded headers are ignored: nobody can pose as another address or claim HTTPS', async () => {
    const client = await clientOf(
      {},
      {
        peer: '203.0.113.7',
        headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https' },
      },
    );
    expect(client).toEqual({ peer: '203.0.113.7', address: '203.0.113.7', secure: false });
  });

  test('even a loopback peer is not a proxy unless it is listed', async () => {
    const client = await clientOf(
      {},
      {
        peer: '127.0.0.1',
        headers: { 'X-Forwarded-For': '8.8.8.8', 'X-Forwarded-Proto': 'https' },
      },
    );
    expect(client).toEqual({ peer: '127.0.0.1', address: '127.0.0.1', secure: false });
  });

  test('a TLS socket makes the request secure', async () => {
    expect((await clientOf({}, { peer: '203.0.113.7', encrypted: true })).secure).toBe(true);
  });

  test('an IPv4-mapped peer is reported as IPv4', async () => {
    expect((await clientOf({}, { peer: '::ffff:192.168.1.20' })).peer).toBe('192.168.1.20');
  });

  test('a request that carries no bindings at all has an unknown peer', async () => {
    const { http } = createLayerHarness();
    const app = new Hono<AppEnv>().use(http.clientInfo).get('/', (c) => c.json(c.var.client));
    expect(await (await app.request('/')).json()).toEqual({
      peer: 'unknown',
      address: 'unknown',
      secure: false,
    });
  });

  test('a request without a socket has an unknown peer', async () => {
    expect(await clientOf({}, { peer: null })).toEqual({
      peer: 'unknown',
      address: 'unknown',
      secure: false,
    });
  });
});

describe('behind a trusted proxy', () => {
  test('the forwarded address and scheme are honoured', async () => {
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' },
    });
    expect(client).toEqual({ peer: '10.0.0.2', address: '203.0.113.7', secure: true });
  });

  test('the proxy is recognised when the socket reports it as IPv4-mapped IPv6', async () => {
    const client = await clientOf(PROXIES, {
      peer: '::ffff:10.0.0.2',
      headers: { 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' },
    });
    expect(client).toEqual({ peer: '10.0.0.2', address: '203.0.113.7', secure: true });
  });

  test('an IPv6 proxy from a trusted range is recognised', async () => {
    const client = await clientOf(PROXIES, {
      peer: 'fd00::5',
      headers: { 'X-Forwarded-For': '2001:db8::7' },
    });
    expect(client.address).toBe('2001:db8:0:0:0:0:0:7');
  });

  test('a peer outside the trusted ranges is not believed', async () => {
    const client = await clientOf(PROXIES, {
      peer: '11.0.0.2',
      headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https' },
    });
    expect(client).toEqual({ peer: '11.0.0.2', address: '11.0.0.2', secure: false });
  });

  test('an address the client put in front of the chain itself is not believed', async () => {
    // The client sent "X-Forwarded-For: 127.0.0.1"; the proxy appended the real address.
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-For': '127.0.0.1, 203.0.113.7' },
    });
    expect(client.address).toBe('203.0.113.7');
  });

  test('a chain of trusted proxies is walked back to the first outside address', async () => {
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-For': '198.51.100.1, 203.0.113.7, 10.0.0.9' },
    });
    expect(client.address).toBe('203.0.113.7');
  });

  test('when every hop is trusted the first one is the client', async () => {
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-For': '10.0.0.7, 10.0.0.9' },
    });
    expect(client.address).toBe('10.0.0.7');
  });

  test.each([
    ['203.0.113.7:51234', '203.0.113.7'],
    ['[2001:db8::7]:51234', '2001:db8:0:0:0:0:0:7'],
    ['[2001:db8::7]', '2001:db8:0:0:0:0:0:7'],
  ])('a forwarded entry with a port (%s) is understood', async (entry, address) => {
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-For': entry },
    });
    expect(client.address).toBe(address);
  });

  test.each(['', 'unknown', 'not-an-address', '203.0.113.7, garbage'])(
    'an unusable forwarded value (%j) falls back to the proxy itself',
    async (value) => {
      const client = await clientOf(PROXIES, {
        peer: '10.0.0.2',
        headers: { 'X-Forwarded-For': value },
      });
      expect(client.address).toBe('10.0.0.2');
    },
  );

  test('without forwarded headers the request is plain HTTP from the proxy', async () => {
    expect(await clientOf(PROXIES, { peer: '10.0.0.2' })).toEqual({
      peer: '10.0.0.2',
      address: '10.0.0.2',
      secure: false,
    });
  });

  test.each([
    ['https', true],
    ['HTTPS', true],
    ['http', false],
    ['wss', false],
    // The value written by the nearest proxy counts, not one a client prepended.
    ['https, http', false],
    ['http, https', true],
  ])('X-Forwarded-Proto %j means secure: %s', async (proto, secure) => {
    const client = await clientOf(PROXIES, {
      peer: '10.0.0.2',
      headers: { 'X-Forwarded-Proto': proto },
    });
    expect(client.secure).toBe(secure);
  });
});
