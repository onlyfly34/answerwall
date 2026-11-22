import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppEnv, AppMiddleware, AuthService } from '../contracts/index.ts';

function sessionToken(c: Context<AppEnv>): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '');
  return bearer?.[1] ?? getCookie(c, BRAND.sessionCookie);
}

/**
 * Requires a valid bearer token or session cookie on every route except
 * those listed in `publicRoutes` (`"<METHOD> <path>"`), and sets `auth`.
 */
export function requireAuth(auth: AuthService, publicRoutes: readonly string[]): AppMiddleware {
  return async (c, next) => {
    if (publicRoutes.includes(`${c.req.method} ${c.req.path}`)) return next();
    const token = sessionToken(c);
    const context = token === undefined ? null : await auth.authenticate(token);
    if (!context) throw new AppError('unauthorized', 'Sign in to continue');
    c.set('auth', context);
    return next();
  };
}
