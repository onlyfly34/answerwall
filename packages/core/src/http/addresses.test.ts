import { describe, expect, test } from 'vitest';
import {
  createAddressMatcher,
  formatIp,
  isLoopbackHost,
  isLoopbackIp,
  parseIp,
  rateLimitKey,
} from './addresses.ts';

const ip = (text: string) => {
  const parsed = parseIp(text);
  if (!parsed) throw new Error(`not an address: ${text}`);
  return parsed;
};

describe('parseIp', () => {
  test.each([
    ['127.0.0.1', '127.0.0.1'],
    [' 10.1.2.3 ', '10.1.2.3'],
    ['::1', '0:0:0:0:0:0:0:1'],
    ['[::1]', '0:0:0:0:0:0:0:1'],
    ['2001:DB8::8a2e:370:7334', '2001:db8:0:0:0:8a2e:370:7334'],
    ['fe80::1%eth0', 'fe80:0:0:0:0:0:0:1'],
    ['::', '0:0:0:0:0:0:0:0'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['64:ff9b::192.0.2.33', '64:ff9b:0:0:0:0:c000:221'],
    // IPv4-mapped IPv6, as dual-stack sockets report IPv4 peers.
    ['::ffff:192.168.1.9', '192.168.1.9'],
    ['::ffff:c0a8:109', '192.168.1.9'],
    ['0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
  ])('%s is %s', (text, canonical) => {
    expect(formatIp(ip(text))).toBe(canonical);
  });

  test.each([
    '',
    'unknown',
    'localhost',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    ':::',
    'gggg::1',
    '10.0.0.0/8',
  ])('%j is not an address', (text) => {
    expect(parseIp(text)).toBeNull();
  });
});

describe('loopback', () => {
  test.each(['127.0.0.1', '127.255.255.254', '::1', '::ffff:127.0.0.1'])('%s is loopback', (a) => {
    expect(isLoopbackIp(ip(a))).toBe(true);
  });

  test.each(['128.0.0.1', '10.0.0.1', '0.0.0.0', '::', '::2', 'fe80::1'])(
    '%s is not loopback',
    (a) => {
      expect(isLoopbackIp(ip(a))).toBe(false);
    },
  );

  test.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['::1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.5', false],
    ['my-host.example', false],
  ])('binding %s keeps the socket local: %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe('createAddressMatcher', () => {
  test.each([
    [['10.0.0.1'], '10.0.0.1', true],
    [['10.0.0.1'], '10.0.0.2', false],
    [['10.0.0.0/8'], '10.255.3.4', true],
    [['10.0.0.0/8'], '11.0.0.1', false],
    [['172.16.0.0/12'], '172.31.255.255', true],
    [['172.16.0.0/12'], '172.32.0.0', false],
    [['192.168.1.128/25'], '192.168.1.129', true],
    [['192.168.1.128/25'], '192.168.1.127', false],
    [['0.0.0.0/0'], '8.8.8.8', true],
    [['10.0.0.0/8', '192.168.0.0/16'], '192.168.4.4', true],
    // A dual-stack socket reports an IPv4 proxy as an IPv4-mapped address.
    [['10.0.0.0/8'], '::ffff:10.1.2.3', true],
    [['10.0.0.0/8'], '::ffff:a01:203', true],
    [['::ffff:10.0.0.0/104'], '10.1.2.3', true],
    [['::ffff:10.0.0.0/104'], '11.1.2.3', false],
    [['fd00::/8'], 'fd12:3456::1', true],
    [['fd00::/8'], 'fe80::1', false],
    [['2001:db8::/32'], '2001:db8:ffff::1', true],
    [['2001:db8::/32'], '2001:db9::1', false],
    [['2001:db8::1'], '2001:db8:0:0::1', true],
    [['::1'], '::1', true],
    // Families never match each other.
    [['0.0.0.0/0'], '2001:db8::1', false],
    [['::/0'], '10.0.0.1', false],
    [[], '127.0.0.1', false],
  ])('%j contains %s: %s', (entries, address, expected) => {
    expect(createAddressMatcher(entries)(ip(address))).toBe(expected);
  });

  test.each([
    'proxy.internal',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    '10.0.0.0/',
    '::1/129',
    '1.2.3/8',
    '10.0.0.0/8/8',
    '::ffff:10.0.0.0/64',
  ])('refuses the entry %j', (entry) => {
    expect(() => createAddressMatcher([entry])).toThrow(`"${entry}"`);
  });
});

describe('rateLimitKey', () => {
  test('an IPv4 client is its address, however it is written', () => {
    expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  test('IPv6 clients in one /64 share a key', () => {
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe(rateLimitKey('2001:db8:1:2:bbbb::2'));
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe(rateLimitKey('2001:db8:1:3::1'));
  });

  test('something that is not an address is its own key', () => {
    expect(rateLimitKey('unknown')).toBe('unknown');
  });
});
