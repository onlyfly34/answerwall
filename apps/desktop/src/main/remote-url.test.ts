import { describe, expect, test } from 'vitest';
import { classifyAddress, parseRemoteUrl, validateRemoteUrl } from './remote-url.ts';
import type { Resolver } from './remote-url.ts';

const never: Resolver = () => {
  throw new Error('a name was resolved');
};
const resolvesTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses;

describe('classifyAddress', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.10', 'private'],
    ['100.64.0.1', 'private'],
    ['100.127.255.255', 'private'],
    ['::ffff:192.168.1.20', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['fe80::1', 'private'],
    ['172.15.255.255', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['192.169.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['::ffff:8.8.8.8', 'public'],
    ['0.0.0.0', 'public'],
    ['not an address', 'public'],
    ['', 'public'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('parseRemoteUrl', () => {
  test.each([
    ['https://wall.example.com', 'https://wall.example.com'],
    ['https://wall.example.com/', 'https://wall.example.com'],
    ['  https://Wall.Example.com:7717  ', 'https://wall.example.com:7717'],
    ['https://wall.example.com:443', 'https://wall.example.com'],
    ['wall.example.com', 'https://wall.example.com'],
    ['wall.example.com:7717', 'https://wall.example.com:7717'],
    ['192.168.1.5:7717', 'https://192.168.1.5:7717'],
    ['http://192.168.1.5:7717', 'http://192.168.1.5:7717'],
    ['http://[::1]:7717', 'http://[::1]:7717'],
    ['HTTP://LOCALHOST:80', 'http://localhost'],
  ])('%s is the origin %s', (input, origin) => {
    expect(parseRemoteUrl(input)).toMatchObject({ ok: true, origin });
  });

  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['https://', 'invalid'],
    ['https://exa mple.com', 'invalid'],
    ['http://:7717', 'invalid'],
    ['ftp://wall.example.com', 'scheme'],
    ['file:///C:/Windows', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,hi', 'scheme'],
    ['ws://wall.example.com', 'scheme'],
    ['https://user@wall.example.com', 'credentials'],
    ['https://user:secret@wall.example.com', 'credentials'],
    ['user:secret@wall.example.com', 'credentials'],
    ['https://wall.example.com/app', 'path'],
    ['https://wall.example.com/?token=1', 'path'],
    ['https://wall.example.com?x', 'path'],
    ['https://wall.example.com/#x', 'path'],
    ['https://wall.example.com#', 'path'],
  ])('%s is refused: %s', (input, problem) => {
    expect(parseRemoteUrl(input)).toEqual({ ok: false, problem });
  });

  test('says whether the origin is encrypted and names the bare host', () => {
    expect(parseRemoteUrl('http://[fd00::1]:8080')).toEqual({
      ok: true,
      origin: 'http://[fd00::1]:8080',
      secure: false,
      host: 'fd00::1',
    });
    expect(parseRemoteUrl('https://wall.example.com')).toMatchObject({ secure: true });
  });
});

describe('validateRemoteUrl', () => {
  test('https is accepted for any host without resolving its name', async () => {
    expect(await validateRemoteUrl('https://wall.example.com', never)).toEqual({
      ok: true,
      origin: 'https://wall.example.com',
      insecure: false,
    });
    expect(await validateRemoteUrl('https://8.8.8.8', never)).toMatchObject({ ok: true });
  });

  test.each([
    'http://127.0.0.1:7717',
    'http://[::1]:7717',
    'http://10.0.0.5',
    'http://192.168.1.5',
  ])('plain http is accepted, marked insecure, for %s', async (url) => {
    expect(await validateRemoteUrl(url, never)).toMatchObject({ ok: true, insecure: true });
  });

  test('localhost counts as loopback without a lookup', async () => {
    expect(await validateRemoteUrl('http://localhost:7717', never)).toMatchObject({ ok: true });
    expect(await validateRemoteUrl('http://wall.localhost', never)).toMatchObject({ ok: true });
  });

  test.each(['http://8.8.8.8', 'http://[2001:4860:4860::8888]:7717', 'http://172.32.0.1'])(
    'plain http to the public address %s is refused',
    async (url) => {
      expect(await validateRemoteUrl(url, never)).toEqual({
        ok: false,
        problem: 'insecure_public',
      });
    },
  );

  test('plain http to a name depends on every address the name has', async () => {
    expect(await validateRemoteUrl('http://nas.lan:7717', resolvesTo('192.168.1.9'))).toEqual({
      ok: true,
      origin: 'http://nas.lan:7717',
      insecure: true,
    });
    expect(
      await validateRemoteUrl('http://nas.lan', resolvesTo('192.168.1.9', '203.0.113.7')),
    ).toEqual({ ok: false, problem: 'insecure_public' });
    expect(await validateRemoteUrl('http://example.com', resolvesTo('93.184.215.14'))).toEqual({
      ok: false,
      problem: 'insecure_public',
    });
  });

  test('plain http to a name that does not resolve is refused', async () => {
    const failing: Resolver = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await validateRemoteUrl('http://nas.lan', failing)).toEqual({
      ok: false,
      problem: 'unresolved',
    });
    expect(await validateRemoteUrl('http://nas.lan', resolvesTo())).toEqual({
      ok: false,
      problem: 'unresolved',
    });
  });

  test('a malformed address is refused before anything is resolved', async () => {
    expect(await validateRemoteUrl('http://nas.lan/path', never)).toEqual({
      ok: false,
      problem: 'path',
    });
  });
});
