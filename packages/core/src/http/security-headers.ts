import type { AppMiddleware } from '../contracts/index.ts';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const FIXED_HEADERS: readonly (readonly [string, string])[] = [
  ['Content-Security-Policy', CONTENT_SECURITY_POLICY],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Cross-Origin-Resource-Policy', 'same-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
];

const HSTS = 'max-age=31536000';

/**
 * Sets the fixed response headers on every response, including the ones the
 * error handler builds for a rejected request. There is no CORS support:
 * any `Access-Control-*` header is removed.
 *
 * `Strict-Transport-Security` is sent only for the HTTPS public origins.
 * Browsers apply it to a host name on every port, so sending it for
 * `localhost` would break other local servers.
 */
export function createSecurityHeaders(publicOrigins: readonly string[]): AppMiddleware {
  const hstsHosts = new Set(
    publicOrigins
      .map((origin) => new URL(origin))
      .filter((url) => url.protocol === 'https:')
      .flatMap((url) => [url.host, url.port === '' ? `${url.hostname}:443` : url.host]),
  );
  return async (c, next) => {
    await next();
    for (const [name, value] of FIXED_HEADERS) c.header(name, value);
    for (const name of [...c.res.headers.keys()]) {
      if (name.toLowerCase().startsWith('access-control-')) c.header(name, undefined);
    }
    if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store');
    }
    // `client` is missing only if a middleware in front of clientInfo answered.
    const secure = (c.var.client as { secure: boolean } | undefined)?.secure === true;
    if (secure && hstsHosts.has((c.req.header('Host') ?? '').toLowerCase())) {
      c.header('Strict-Transport-Security', HSTS);
    }
  };
}
