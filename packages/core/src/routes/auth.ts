import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
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

/**
 * Browsers cap cookie lifetimes at about 400 days. The auth middleware issues
 * the cookie again while the device stays in use; it states the same
 * attributes, because units do not import each other.
 */
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * The page of an allowed browser extension is on another origin and signs in
 * with `Authorization: Bearer`: it is never given the cookie, and has none to clear.
 */
const isExtension = (c: AppContext): boolean => c.var.extensionOrigin !== undefined;

function setSessionCookie(c: AppContext, token: string): void {
  if (isExtension(c)) return;
  setCookie(c, BRAND.sessionCookie, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: c.var.client.secure,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

function clearSessionCookie(c: AppContext): void {
  if (isExtension(c)) return;
  deleteCookie(c, BRAND.sessionCookie, { path: '/', secure: c.var.client.secure });
}

/**
 * People read the code off a log line or another screen, where it is shown
 * in two groups; spaces and dashes typed along with the digits are dropped
 * before validation.
 */
const TypedPairRequestSchema = z.preprocess((body) => {
  if (typeof body !== 'object' || body === null) return body;
  const { code } = body as { code?: unknown };
  return typeof code === 'string' ? { ...body, code: code.replace(/[\s-]/g, '') } : body;
}, PairRequestSchema);

export function authRoutes({ auth }: Pick<AppDeps, 'auth'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post('/pair', async (c) => {
    const request = await readJson(c, TypedPairRequestSchema);
    const { token, device } = await auth.pair(request).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'invalid_code') c.set('authFailure', true);
      throw error;
    });
    setSessionCookie(c, token);
    // The one case in which a token is shown to its client: the extension
    // keeps it in its own storage, where no web page can read it.
    return c.json({ device, ...(isExtension(c) ? { token } : {}) } satisfies SessionResponse);
  });

  routes.post('/session', async (c) => {
    const { token } = await readJson(c, SessionRequestSchema);
    const caller = await auth.authenticate(token);
    if (!caller) {
      c.set('authFailure', true);
      throw new AppError('unauthorized', 'Invalid token');
    }
    setSessionCookie(c, token);
    return c.json({ device: await auth.getDevice(caller) } satisfies SessionResponse);
  });

  routes.post('/logout', async (c) => {
    await readJson(c, EmptyBodySchema);
    await auth.logout(c.var.auth);
    clearSessionCookie(c);
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
      clearSessionCookie(c);
    }
    return c.json({ ok: true } satisfies OkResponse);
  });

  routes.post('/pairing-codes', async (c) => {
    await readJson(c, EmptyBodySchema);
    return c.json((await auth.createPairingCode()) satisfies PairingCodeResponse);
  });

  return routes;
}
