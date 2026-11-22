import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import { RefreshProvidersRequestSchema } from '../protocol/index.ts';
import type { ProvidersResponse } from '../protocol/index.ts';
import { readJson } from './shared.ts';

export function providerRoutes({ providers }: Pick<AppDeps, 'providers'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/', (c) => c.json({ providers: providers.list() } satisfies ProvidersResponse));

  routes.post('/refresh', async (c) => {
    const { id } = await readJson(c, RefreshProvidersRequestSchema);
    return c.json({ providers: await providers.refresh(id) } satisfies ProvidersResponse);
  });

  return routes;
}
