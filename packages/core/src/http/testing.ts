import { Hono } from 'hono';
import type { AppConfig, AppEnv, HttpLayer } from '../contracts/index.ts';
import {
  createFakeSettingsService,
  createMemoryLogger,
  createTestApp,
  createTestConfig,
  FakeClock,
} from '../testing/index.ts';
import type { TestApp } from '../testing/index.ts';
import { createHttpLayer } from './index.ts';

export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** The socket's remote address; loopback by default. `null` for a request without a socket. */
  peer?: string | null;
  /** The socket is a TLS socket. */
  encrypted?: boolean;
}

export interface LayerHarness extends TestApp {
  http: HttpLayer;
  logger: ReturnType<typeof createMemoryLogger>;
  settings: ReturnType<typeof createFakeSettingsService>;
  /** A request through the whole pipeline of `createApp`, as it would arrive on a socket. */
  send(path: string, options?: SendOptions): Promise<Response>;
  /** The same against a bare app that runs only `middleware` and answers with `c.var.client`. */
  probe(
    middleware: (keyof HttpLayer)[],
  ): (path: string, options?: SendOptions) => Promise<Response>;
}

function dispatch(app: Hono<AppEnv>, path: string, options: SendOptions = {}): Promise<Response> {
  const { method = 'GET', body, peer = '127.0.0.1', encrypted = false } = options;
  const headers = { Host: 'localhost', ...options.headers };
  const env = peer === null ? {} : { incoming: { socket: { remoteAddress: peer, encrypted } } };
  return Promise.resolve(
    app.request(path, { method, headers, ...(body === undefined ? {} : { body }) }, env),
  );
}

/** The real `HttpLayer` for `config`, mounted in the real app over fakes. */
export function createLayerHarness(config: Partial<AppConfig> = {}): LayerHarness {
  const clock = new FakeClock();
  const logger = createMemoryLogger();
  const settings = createFakeSettingsService();
  const fullConfig = createTestConfig(config);
  const http = createHttpLayer({ config: fullConfig, settings, clock, logger });
  const testApp = createTestApp({ config: fullConfig, settings, logger, http }, clock);
  return {
    ...testApp,
    http,
    logger,
    settings,
    send: (path, options) => dispatch(testApp.app, path, options),
    probe: (names) => {
      const app = new Hono<AppEnv>();
      app.onError(http.onError);
      app.notFound(http.notFound);
      for (const name of names) app.use(http[name] as HttpLayer['clientInfo']);
      app.all('*', (c) => c.json({ client: c.var.client }));
      return (path, options) => dispatch(app, path, options);
    },
  };
}
