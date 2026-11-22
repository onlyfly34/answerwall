/**
 * Which remote server addresses the app accepts. HTTPS to anything; plain
 * HTTP only to this computer and to private network addresses, where the
 * caller shows a warning. Nothing here touches the network except the name
 * lookup the caller passes in.
 */
import { BlockList, isIP } from 'node:net';
import type { RemoteUrlProblem } from '../shared/ipc.ts';

export type AddressClass = 'loopback' | 'private' | 'public';

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const privateRanges = new BlockList();
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
// Link-local, and the shared range that overlay networks between one's own machines use.
privateRanges.addSubnet('169.254.0.0', 16, 'ipv4');
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');
privateRanges.addSubnet('fe80::', 10, 'ipv6');

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** The class of an IP address literal; anything that is not one counts as public. */
export function classifyAddress(address: string): AddressClass {
  const mapped = MAPPED_IPV4.exec(address);
  const literal = mapped?.[1] ?? address;
  const family = isIP(literal);
  if (family === 0) return 'public';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (loopback.check(literal, type)) return 'loopback';
  if (privateRanges.check(literal, type)) return 'private';
  return 'public';
}

export type ParsedRemoteUrl =
  | { ok: true; origin: string; secure: boolean; host: string }
  | { ok: false; problem: RemoteUrlProblem };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Reads what the user typed as the origin of a server. A bare host name gets
 * `https://`. Anything beyond the origin (path, query, fragment, credentials)
 * is refused rather than dropped, so that what is saved is what was typed.
 */
export function parseRemoteUrl(input: string): ParsedRemoteUrl {
  const text = input.trim();
  if (text === '') return { ok: false, problem: 'empty' };
  if (/\s/.test(text)) return { ok: false, problem: 'invalid' };
  // No part of a server's origin contains this character; in a URL it sets off credentials.
  if (text.includes('@')) return { ok: false, problem: 'credentials' };
  if (!HAS_SCHEME.test(text) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text)) {
    // `javascript:…`, `file:…` and the like; `host:7717` is a port, not a scheme.
    return { ok: false, problem: 'scheme' };
  }
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, problem: 'scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, problem: 'credentials' };
  }
  if (url.hostname === '') return { ok: false, problem: 'invalid' };
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(text)) {
    return { ok: false, problem: 'path' };
  }
  return {
    ok: true,
    origin: url.origin,
    secure: url.protocol === 'https:',
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
  };
}

/** Resolves a host name to every address it has; rejects when it has none. */
export type Resolver = (host: string) => Promise<string[]>;

export type ValidatedRemoteUrl =
  { ok: true; origin: string; insecure: boolean } | { ok: false; problem: RemoteUrlProblem };

const isLocalhostName = (host: string): boolean =>
  host === 'localhost' || host.endsWith('.localhost');

/**
 * {@link parseRemoteUrl}, then the rule for plain HTTP: every address of the
 * host must be loopback or private. A name is resolved to decide that; when
 * it does not resolve, plain HTTP is refused.
 */
export async function validateRemoteUrl(
  input: string,
  resolve: Resolver,
): Promise<ValidatedRemoteUrl> {
  const parsed = parseRemoteUrl(input);
  if (!parsed.ok) return parsed;
  if (parsed.secure) return { ok: true, origin: parsed.origin, insecure: false };

  const { host } = parsed;
  let addresses: string[];
  if (isIP(host) !== 0) addresses = [host];
  else if (isLocalhostName(host)) addresses = ['127.0.0.1'];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      return { ok: false, problem: 'unresolved' };
    }
    if (addresses.length === 0) return { ok: false, problem: 'unresolved' };
  }
  if (addresses.some((address) => classifyAddress(address) === 'public')) {
    return { ok: false, problem: 'insecure_public' };
  }
  return { ok: true, origin: parsed.origin, insecure: true };
}
