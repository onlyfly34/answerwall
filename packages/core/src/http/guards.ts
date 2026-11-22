import { getCookie } from 'hono/cookie';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppConfig, AppMiddleware } from '../contracts/index.ts';
import { isLoopbackHost, isLoopbackIp, parseIp } from './addresses.ts';
import type { IpAddress } from './addresses.ts';

const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/**
 * With TLS off on a non-loopback bind, plain HTTP is meant for a reverse
 * proxy only: peers that are neither this machine nor a trusted proxy are
 * refused, unless the operator explicitly allowed insecure access.
 */
export function createPeerGuard(
  config: Pick<AppConfig, 'tls' | 'host' | 'allowInsecure'>,
  isTrustedProxy: (ip: IpAddress) => boolean,
): AppMiddleware {
  const restricted =
    config.tls.mode === 'off' && !isLoopbackHost(config.host) && !config.allowInsecure;
  return (c, next) => {
    if (restricted) {
      const peer = parseIp(c.var.client.peer);
      if (!peer || !(isLoopbackIp(peer) || isTrustedProxy(peer))) {
        throw new AppError(
          'forbidden',
          'Plain HTTP is accepted only from this machine or a trusted proxy',
        );
      }
    }
    return next();
  };
}

interface HostHeader {
  /** Lowercase; IPv6 literals keep their brackets. */
  name: string;
  port: string | undefined;
}

function parseHostHeader(value: string | undefined): HostHeader | null {
  if (value === undefined) return null;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(value.toLowerCase());
  if (match?.[1] === undefined) return null;
  return { name: match[1], port: match[2] };
}

function parseOrigin(origin: string): URL {
  const url = new URL(origin);
  if (!(url.protocol in DEFAULT_PORTS) || url.origin !== origin.toLowerCase()) {
    throw new Error(`Not an origin (scheme://host[:port]): "${origin}"`);
  }
  return url;
}

/**
 * `Host` must be a loopback name (any port) or the host of a public origin
 * with that origin's port. A page on an attacker's domain that resolves to
 * this server (DNS rebinding) sends the attacker's host name and is refused.
 */
export function createHostGuard(publicOrigins: readonly string[]): AppMiddleware {
  const allowed = new Set<string>();
  for (const origin of publicOrigins) {
    const url = parseOrigin(origin);
    const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : url.port;
    allowed.add(`${url.hostname}:${port}`);
    // The default port may be left out of the header.
    if (url.port === '') allowed.add(url.hostname);
  }
  return (c, next) => {
    const host = parseHostHeader(c.req.header('Host'));
    const accepted =
      host !== null &&
      (LOOPBACK_NAMES.has(host.name) ||
        allowed.has(host.port === undefined ? host.name : `${host.name}:${host.port}`));
    if (!accepted) throw new AppError('forbidden', 'This host name is not allowed');
    return next();
  };
}

/** `Origin` names the page's own address on loopback: same scheme, host and port as the request. */
function isSameLoopbackOrigin(origin: string, hostHeader: string | undefined, secure: boolean) {
  const host = parseHostHeader(hostHeader);
  if (!host || !LOOPBACK_NAMES.has(host.name)) return false;
  const protocol = secure ? 'https:' : 'http:';
  const port = host.port ?? DEFAULT_PORTS[protocol];
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.origin === origin &&
    url.protocol === protocol &&
    url.hostname === host.name &&
    (url.port === '' ? DEFAULT_PORTS[protocol] : url.port) === port
  );
}

const isJson = (contentType: string | undefined): boolean =>
  contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/**
 * Cross-site request forgery defence for every state-changing request.
 *
 * - A request with `Origin` (every browser sends it on non-GET requests) must
 *   come from a public origin, or from the very loopback origin it is
 *   addressed to. Another site, another port on localhost, or `null` fails.
 * - A request without `Origin` is not from a browser; it passes only with an
 *   `Authorization` header and no session cookie, so a cookie can never be
 *   used without an origin check.
 * - `Content-Type` must be `application/json`, which no HTML form can send.
 */
export function createOriginGuard(publicOrigins: readonly string[]): AppMiddleware {
  const allowed = new Set(publicOrigins.map((origin) => parseOrigin(origin).origin));
  return (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();

    const origin = c.req.header('Origin');
    if (origin === undefined) {
      const bearerOnly =
        c.req.header('Authorization') !== undefined &&
        getCookie(c, BRAND.sessionCookie) === undefined;
      if (!bearerOnly) throw new AppError('forbidden', 'Origin header required');
    } else if (
      !allowed.has(origin) &&
      !isSameLoopbackOrigin(origin, c.req.header('Host'), c.var.client.secure)
    ) {
      throw new AppError('forbidden', 'Cross-origin requests are not allowed');
    }

    if (!isJson(c.req.header('Content-Type'))) {
      throw new AppError('unsupported_media_type', 'Content-Type must be application/json');
    }
    return next();
  };
}
