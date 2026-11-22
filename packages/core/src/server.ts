import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import type { Hono } from 'hono';
import { createApp } from './app.ts';
import { createAuthService } from './auth/index.ts';
import { BRAND } from './brand.ts';
import type { AppConfig, AppEnv, Logger, SecretStore } from './contracts/index.ts';
import { createHttpLayer } from './http/index.ts';
import { createLogger } from './logging/index.ts';
import { createProviderRegistry } from './providers/index.ts';
import { createAskManager } from './runner/index.ts';
import { createFileSecretStore, createSettingsService } from './settings/index.ts';
import { createSqliteStorage } from './storage/index.ts';
import { randomIds, systemClock, systemRandom } from './system.ts';
import { createTlsProvider } from './tls/index.ts';

export interface ServerOverrides {
  logger?: Logger;
  /** The desktop shell injects a store backed by the operating system's keychain. */
  secrets?: SecretStore;
}

export interface ServerHandle {
  readonly app: Hono<AppEnv>;
  readonly logger: Logger;
  /** Binds the socket, then runs the startup hooks (pairing code, provider detection). */
  listen(): Promise<{ port: number; url: string }>;
  /** Stops accepting requests, cancels every ask, kills every child process, closes storage. */
  shutdown(): Promise<void>;
}

/** Builds every unit from `config` and wires them into one app. Does not bind a socket yet. */
export async function createServer(
  config: AppConfig,
  overrides: ServerOverrides = {},
): Promise<ServerHandle> {
  const logger = overrides.logger ?? createLogger({ level: config.logLevel });
  const clock = systemClock;
  await mkdir(config.dataDir, { recursive: true });

  const storage = await createSqliteStorage({
    file: join(config.dataDir, BRAND.databaseFile),
    logger,
  });
  const secrets =
    overrides.secrets ??
    createFileSecretStore({ file: join(config.dataDir, 'secrets.json'), env: process.env });
  const settings = createSettingsService({ storage, secrets });
  await settings.load();
  const providers = createProviderRegistry({ settings, secrets, clock, logger, env: process.env });
  const asks = createAskManager({
    storage,
    settings,
    providers,
    clock,
    ids: randomIds,
    logger,
    workRoot: join(config.dataDir, 'work'),
  });
  await asks.start();
  const auth = createAuthService({
    storage,
    clock,
    ids: randomIds,
    random: systemRandom,
    logger,
    staticToken: config.staticToken,
  });
  const tls = createTlsProvider({ config, secrets, logger });
  const http = createHttpLayer({ config, settings, clock, logger });
  const app = createApp({
    config,
    logger,
    clock,
    storage,
    settings,
    providers,
    asks,
    auth,
    tls,
    http,
  });

  let server: Server | undefined;

  const detectProviders = async () => {
    try {
      await providers.refresh();
    } catch (error) {
      logger.warn('provider detection failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  return {
    app,
    logger,

    async listen() {
      const material = await tls.material();
      const handle = getRequestListener(app.fetch, { overrideGlobalObjects: false });
      const listener: RequestListener = (request, response) => void handle(request, response);
      if (material) {
        const secure = createHttpsServer(material, listener);
        tls.onChange((renewed) => secure.setSecureContext(renewed));
        server = secure;
      } else {
        server = createHttpServer(listener);
      }
      const bound = server;
      await new Promise<void>((resolve, reject) => {
        bound.once('error', reject);
        bound.listen(config.port, config.host, resolve);
      });
      const { port } = bound.address() as AddressInfo;
      const host = config.host.includes(':') ? `[${config.host}]` : config.host;

      await auth.bootstrap();
      void detectProviders();
      return { port, url: `${material ? 'https' : 'http'}://${host}:${port}` };
    },

    async shutdown() {
      const bound = server;
      const closed = bound && new Promise<void>((resolve) => bound.close(() => resolve()));
      await asks.shutdown();
      await providers.shutdown();
      // Open event streams would otherwise keep the server from closing.
      bound?.closeAllConnections();
      await closed;
      await tls.close();
      await storage.close();
    },
  };
}
