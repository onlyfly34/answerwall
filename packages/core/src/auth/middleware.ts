import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppEnv, AppMiddleware, AuthContext, AuthService, Clock } from '../contracts/index.ts';
import { systemClock } from '../system.ts';

/**
 * Lifetime of the session cookie. Browsers cap cookies at about 400 days;
 * a device in regular use never reaches the end, because the cookie is
 * issued again once per {@link SESSION_RENEW_INTERVAL_MS}.
 *
 * The same values are used by `routes/auth.ts`, which issues the cookie at
 * sign-in; units do not import each other, so they are stated in both.
 */
export const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
export const SESSION_RENEW_INTERVAL_MS = 24 * 60 * 60_000;

export interface RequireAuthOptions {
  /** Times the cookie renewal; the system clock by default. */
  clock?: Clock;
}

type Credential = { token: string; source: 'bearer' | 'cookie' };

function readCredential(c: Context<AppEnv>): Credential | undefined {
  const bearer = /^Bearer +(\S+)$/i.exec(c.req.header('Authorization') ?? '');
  if (bearer?.[1] !== undefined) return { token: bearer[1], source: 'bearer' };
  const cookie = getCookie(c, BRAND.sessionCookie);
  return cookie === undefined ? undefined : { token: cookie, source: 'cookie' };
}

const renewalKey = (caller: AuthContext): string =>
  caller.kind === 'device' ? `device:${caller.deviceId}` : 'static-token';

/** More entries than there can be devices means stale ones: start over. */
const MAX_RENEWAL_ENTRIES = 64;

/**
 * Requires a valid bearer token or session cookie on every route except
 * those listed in `publicRoutes` (`"<METHOD> <path>"`), and sets `auth`.
 * Where the request came from never matters: loopback clients sign in too.
 *
 * A session that authenticated by cookie gets the cookie issued again with a
 * fresh lifetime, at most once a day per device (and once after a restart).
 */
export function requireAuth(
  auth: AuthService,
  publicRoutes: readonly string[],
  options: RequireAuthOptions = {},
): AppMiddleware {
  const clock = options.clock ?? systemClock;
  const renewedAt = new Map<string, number>();

  /** Whether this session's cookie is due for a fresh lifetime; records that it gets one. */
  const renewalDue = (caller: AuthContext): boolean => {
    const key = renewalKey(caller);
    const now = clock.now();
    const last = renewedAt.get(key);
    if (last !== undefined && now - last < SESSION_RENEW_INTERVAL_MS) return false;
    if (renewedAt.size >= MAX_RENEWAL_ENTRIES) renewedAt.clear();
    renewedAt.set(key, now);
    return true;
  };

  return async (c, next) => {
    if (publicRoutes.includes(`${c.req.method} ${c.req.path}`)) return next();
    const credential = readCredential(c);
    const caller = credential === undefined ? null : await auth.authenticate(credential.token);
    if (!credential || !caller) {
      if (credential !== undefined) c.set('authFailure', true);
      if (credential?.source === 'cookie') {
        // A browser would keep presenting the dead cookie and run into the failed-attempt limit.
        deleteCookie(c, BRAND.sessionCookie, { path: '/', secure: c.var.client.secure });
      }
      throw new AppError('unauthorized', 'Sign in to continue');
    }
    c.set('auth', caller);
    // Only on reads: sign-out and revocation clear the cookie themselves.
    const renew = credential.source === 'cookie' && c.req.method === 'GET' && renewalDue(caller);
    await next();
    if (renew) {
      setCookie(c, BRAND.sessionCookie, credential.token, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: c.var.client.secure,
        path: '/',
        maxAge: SESSION_MAX_AGE_SECONDS,
      });
    }
  };
}
