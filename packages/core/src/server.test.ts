import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { BRAND } from './brand.ts';
import { apiKeyOriginEnvName, SECRET_KEYS, secretEnvName } from './contracts/index.ts';
import { API_PATHS, MetaSchema, SettingsResponseSchema } from './protocol/index.ts';
import { createServer } from './server.ts';
import type { ServerHandle } from './server.ts';
import { createMemoryLogger, createTestConfig } from './testing/index.ts';

let server: ServerHandle | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.shutdown();
  server = undefined;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

test('the server starts on a free port, serves meta over HTTP and shuts down', async () => {
  dataDir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-`));
  // Startup detection must find no real CLI on the machine running the tests.
  const emptyBin = join(dataDir, 'bin');
  await mkdir(emptyBin);
  server = await createServer(createTestConfig({ dataDir }), {
    logger: createMemoryLogger(),
    env: { PATH: emptyBin },
  });

  const { url, port } = await server.listen();

  expect(port).toBeGreaterThan(0);
  const response = await fetch(new URL(API_PATHS.meta, url));
  expect(MetaSchema.parse(await response.json()).name).toBe(BRAND.name);
});

describe('an API key never follows its endpoint to another origin', () => {
  const TOKEN = 'static-test-token-0123456789abcdef0123456789';
  const KEY = 'sk-SECRETKEY-abcdef';
  let listeners: Server[] = [];

  afterEach(async () => {
    for (const listener of listeners) {
      listener.closeAllConnections();
      await new Promise((resolve) => listener.close(resolve));
    }
    listeners = [];
  });

  /** An OpenAI-compatible stub that records the `Authorization` header of every request. */
  async function listen() {
    const authorizations: (string | undefined)[] = [];
    const listener = createHttpServer((request, response) => {
      authorizations.push(request.headers.authorization);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'some-model' }] }));
    });
    listeners.push(listener);
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as AddressInfo;
    return { authorizations, baseUrl: `http://127.0.0.1:${port}` };
  }

  async function start(env: NodeJS.ProcessEnv = {}) {
    dataDir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-`));
    const emptyBin = join(dataDir, 'bin');
    await mkdir(emptyBin);
    server = await createServer(createTestConfig({ dataDir, staticToken: TOKEN }), {
      logger: createMemoryLogger(),
      env: { PATH: emptyBin, ...env },
    });
    const { url } = await server.listen();
    const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(new URL(path, url), {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status, `${method} ${path}`).toBe(200);
      return response.json();
    };
    const cliProviders = SettingsResponseSchema.parse(await call('GET', API_PATHS.settings))
      .settings.providers;
    const putEndpoint = (endpoint: Record<string, unknown>) =>
      call('PUT', API_PATHS.settings, {
        providers: [
          ...cliProviders,
          {
            id: 'ep1',
            kind: 'openai-compat',
            label: 'Endpoint',
            enabled: true,
            concurrency: 4,
            models: [],
            ...endpoint,
          },
        ],
      });
    const refresh = () => call('POST', API_PATHS.providersRefresh, { id: 'ep1' });
    return { putEndpoint, refresh };
  }

  test('a stored key is deleted when the address moves to another origin', async () => {
    const original = await listen();
    const other = await listen();
    const { putEndpoint, refresh } = await start();

    await putEndpoint({ baseUrl: original.baseUrl, apiKey: KEY });
    await refresh();
    expect(original.authorizations).toContain(`Bearer ${KEY}`);

    await putEndpoint({ baseUrl: other.baseUrl });
    await refresh();

    expect(other.authorizations.length).toBeGreaterThan(0);
    expect(other.authorizations.every((value) => value === undefined)).toBe(true);
  });

  test('a key from the environment reaches only the origin pinned for it', async () => {
    const pinned = await listen();
    const other = await listen();
    const { putEndpoint, refresh } = await start({
      [secretEnvName(SECRET_KEYS.providerApiKey('ep1'))]: KEY,
      [apiKeyOriginEnvName('ep1')]: pinned.baseUrl,
    });

    await putEndpoint({ baseUrl: `${pinned.baseUrl}/v1` });
    await refresh();
    expect(pinned.authorizations).toContain(`Bearer ${KEY}`);

    await putEndpoint({ baseUrl: other.baseUrl });
    await refresh();

    expect(other.authorizations.every((value) => value === undefined)).toBe(true);
  });
});
