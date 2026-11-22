import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../contracts/index.ts';
import { SettingsPatchSchema } from '../protocol/index.ts';
import type { ServerInfo, Settings, SettingsResponse } from '../protocol/index.ts';
import { readJson } from './shared.ts';

export function settingsRoutes({
  config,
  settings,
  tls,
}: Pick<AppDeps, 'config' | 'settings' | 'tls'>): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const respond = async (current: Settings): Promise<SettingsResponse> => {
    const server: ServerInfo = {
      mode: config.mode,
      tls: {
        mode: config.tls.mode,
        insecure: config.tls.mode === 'off' && config.allowInsecure,
        caCertificatePem: await tls.caCertificatePem(),
      },
      publicOrigins: config.publicOrigins,
    };
    return { settings: current, server };
  };

  routes.get('/', async (c) => c.json(await respond(settings.get())));

  routes.put('/', async (c) => {
    const patch = await readJson(c, SettingsPatchSchema);
    return c.json(await respond(await settings.update(patch)));
  });

  return routes;
}
