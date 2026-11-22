import type { TLSSocket } from 'node:tls';
import type { AppEnv, AppMiddleware, ClientInfo } from '../contracts/index.ts';
import { formatIp, parseIp } from './addresses.ts';
import type { IpAddress } from './addresses.ts';

/** The peer of a request that did not come through a socket, or whose address cannot be parsed. */
export const UNKNOWN_PEER = 'unknown';

/** `1.2.3.4`, `1.2.3.4:5678`, `[::1]`, `[::1]:5678` or a bare IPv6 literal. */
function parseForwardedEntry(entry: string): IpAddress | null {
  const text = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed?.[1] !== undefined) return parseIp(bracketed[1]);
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
  return parseIp(withPort?.[1] ?? text);
}

/**
 * The client behind a chain of proxies: walking `X-Forwarded-For` from the
 * nearest hop outwards, the first address that is not itself a trusted proxy.
 * Anything left of it was written by someone we do not trust.
 */
function forwardedClient(
  header: string | undefined,
  peer: IpAddress,
  isTrustedProxy: (ip: IpAddress) => boolean,
): IpAddress {
  let client = peer;
  const entries = header === undefined ? [] : header.split(',');
  for (let index = entries.length - 1; index >= 0; index--) {
    const hop = parseForwardedEntry(entries[index] ?? '');
    if (!hop) break;
    client = hop;
    if (!isTrustedProxy(hop)) break;
  }
  return client;
}

/** The scheme the nearest proxy reported: the last value of `X-Forwarded-Proto`. */
function forwardedProto(header: string | undefined): string | undefined {
  return header?.split(',').at(-1)?.trim().toLowerCase();
}

/**
 * Resolves who is talking to us. `X-Forwarded-For` and `X-Forwarded-Proto`
 * are read only when the socket peer is a trusted proxy; from anyone else
 * they are ignored.
 */
export function createClientInfo(isTrustedProxy: (ip: IpAddress) => boolean): AppMiddleware {
  return (c, next) => {
    // `c.env` itself is missing when the app is driven without a socket.
    const bindings = c.env as AppEnv['Bindings'] | undefined;
    const socket = bindings?.incoming?.socket as Partial<TLSSocket> | undefined;
    const peer = parseIp(socket?.remoteAddress ?? '');
    const overTls = socket?.encrypted === true;

    let info: ClientInfo;
    if (!peer) {
      info = { peer: UNKNOWN_PEER, address: UNKNOWN_PEER, secure: overTls };
    } else if (!isTrustedProxy(peer)) {
      const address = formatIp(peer);
      info = { peer: address, address, secure: overTls };
    } else {
      info = {
        peer: formatIp(peer),
        address: formatIp(forwardedClient(c.req.header('X-Forwarded-For'), peer, isTrustedProxy)),
        secure: overTls || forwardedProto(c.req.header('X-Forwarded-Proto')) === 'https',
      };
    }
    c.set('client', info);
    return next();
  };
}
