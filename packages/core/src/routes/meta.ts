import { Hono } from 'hono';
import { BRAND } from '../brand.ts';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import { API_VERSION } from '../protocol/index.ts';
import type { Meta } from '../protocol/index.ts';

export function metaRoutes({ config }: Pick<AppDeps, 'config'>): Hono<AppEnv> {
  const meta: Meta = {
    name: BRAND.name,
    version: config.version,
    apiVersion: API_VERSION,
    mode: config.mode,
    tls: config.tls.mode,
    authRequired: true,
  };
  return new Hono<AppEnv>().get('/', (c) => c.json(meta));
}
