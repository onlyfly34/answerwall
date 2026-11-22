import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { BRAND } from '../brand.ts';
import { AppError } from '../contracts/index.ts';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import {
  EmptyBodySchema,
  MAX_DEVICES,
  PairRequestSchema,
  SessionRequestSchema,
} from '../protocol/index.ts';
import type {
  DevicesResponse,
  OkResponse,
  PairingCodeResponse,
  SessionResponse,
} from '../protocol/index.ts';
import { readJson } from './shared.ts';
import type { AppContext } from './shared.ts';

/** Browsers cap cookie lifetimes at about 400 days; the cookie is renewed on every sign-in. */
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function setSessionCookie(c: AppContext, token: string): void {
  setCookie(c, BRAND.sessionCookie, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: c.var.client.secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function authRoutes({ auth }: Pick<AppDeps, 'auth'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/pair', async (c) => {
    const { token, device } = await auth.pair(await readJson(c, PairRequestSchema));
    setSessionCookie(c, token);
    return c.json({ device } satisfies SessionResponse);
  });

  routes.post('/session', async (c) => {
    const { token } = await readJson(c, SessionRequestSchema);
    const caller = await auth.authenticate(token);
    if (!caller) throw new AppError('unauthorized', 'Invalid token');
    setSessionCookie(c, token);
    return c.json({ device: await auth.getDevice(caller) } satisfies SessionResponse);
  });

  routes.post('/logout', async (c) => {
    await readJson(c, EmptyBodySchema);
    await auth.logout(c.var.auth);
    deleteCookie(c, BRAND.sessionCookie, { path: '/' });
    return c.json({ ok: true } satisfies OkResponse);
  });

  routes.get('/devices', async (c) =>
    c.json({
      devices: await auth.listDevices(c.var.auth),
      maxDevices: MAX_DEVICES,
    } satisfies DevicesResponse),
  );

  routes.delete('/devices/:id', async (c) => {
    const id = c.req.param('id');
    if (!(await auth.revokeDevice(id))) throw new AppError('not_found', 'No such device');
    const caller = c.var.auth;
    if (caller.kind === 'device' && caller.deviceId === id) {
      deleteCookie(c, BRAND.sessionCookie, { path: '/' });
    }
    return c.json({ ok: true } satisfies OkResponse);
  });

  routes.post('/pairing-codes', async (c) => {
    await readJson(c, EmptyBodySchema);
    return c.json((await auth.createPairingCode()) satisfies PairingCodeResponse);
  });

  return routes;
}
