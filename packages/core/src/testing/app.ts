import type { Hono } from 'hono';
import { createApp } from '../app.ts';
import type {
  AppConfig,
  AppDeps,
  AppEnv,
  AppMiddleware,
  HttpLayer,
  Logger,
  TlsProvider,
} from '../contracts/index.ts';
import { createErrorHandlers } from '../http/errors.ts';
import { createFakeAskManager } from './asks.ts';
import type { FakeAskManager } from './asks.ts';
import { createFakeAuthService, TEST_TOKEN } from './auth.ts';
import { createMemoryLogger, createSequentialIds, FakeClock } from './platform.ts';
import { createFakeProviderRegistry } from './providers.ts';
import { createFakeSettingsService } from './settings.ts';
import { createFakeStorage } from './storage.ts';

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'server',
    version: '0.0.0-test',
    host: '127.0.0.1',
    port: 0,
    dataDir: 'unused-in-tests',
    publicOrigins: [],
    trustedProxies: [],
    tls: { mode: 'off' },
    allowInsecure: false,
    logLevel: 'debug',
    ...overrides,
  };
}

/** An `HttpLayer` without guards: every request is a loopback client over plain HTTP. */
export function createOpenHttpLayer(logger: Logger): HttpLayer {
  const pass: AppMiddleware = (_c, next) => next();
  return {
    requestLog: pass,
    clientInfo: (c, next) => {
      c.set('client', { address: '127.0.0.1', secure: false });
      return next();
    },
    peerGuard: pass,
    hostGuard: pass,
    securityHeaders: pass,
    originGuard: pass,
    authRateLimit: pass,
    bodyLimit: pass,
    ...createErrorHandlers(logger),
  };
}

export const offTlsProvider: TlsProvider = {
  mode: 'off',
  material: async () => null,
  onChange: () => () => {},
  caCertificatePem: async () => null,
  close: async () => {},
};

export interface TestApp {
  app: Hono<AppEnv>;
  deps: AppDeps;
  clock: FakeClock;
  /** The default ask manager, driven with `emit()`; idle when `asks` is overridden. */
  asks: FakeAskManager;
  /** `app.request()` with the test token and, when `body` is given, a JSON body. */
  request(method: string, path: string, body?: unknown): Promise<Response>;
}

/**
 * The real app over in-memory fakes. Override exactly the dependency under
 * test, sharing the clock with it:
 * `createTestApp({ asks: createAskManager({ clock, ... }) }, clock)`.
 */
export function createTestApp(overrides: Partial<AppDeps> = {}, clock = new FakeClock()): TestApp {
  const ids = createSequentialIds();
  const logger = overrides.logger ?? createMemoryLogger();
  const settings = overrides.settings ?? createFakeSettingsService();
  const asks = createFakeAskManager({ settings, clock, ids });
  const deps: AppDeps = {
    config: createTestConfig(),
    logger,
    clock,
    storage: createFakeStorage(),
    settings,
    providers: createFakeProviderRegistry({ settings, clock }),
    asks,
    auth: createFakeAuthService({ clock, ids }),
    tls: offTlsProvider,
    http: createOpenHttpLayer(logger),
    ...overrides,
  };
  const app = createApp(deps);
  return {
    app,
    deps,
    clock,
    asks,
    request: async (method, path, body) =>
      app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}
