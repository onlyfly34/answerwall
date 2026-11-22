import { describe, expect, test } from 'vitest';
import { SECRET_KEYS } from '../contracts/index.ts';
import type { TlsProvider } from '../contracts/index.ts';
import {
  API_PATHS,
  createDefaultSettings,
  DEFAULT_LIMITS,
  LIMIT_SPECS,
  SettingsResponseSchema,
} from '../protocol/index.ts';
import {
  createFakeSecretStore,
  createFakeSettingsService,
  createTestApp,
  createTestConfig,
  offTlsProvider,
} from '../testing/index.ts';

const endpoint = {
  id: 'local',
  kind: 'openai-compat',
  label: 'Local',
  enabled: true,
  concurrency: 4,
  models: ['some-model'],
  baseUrl: 'http://127.0.0.1:4000/v1',
} as const;

const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('GET /api/settings', () => {
  test('returns the settings and what the server was started with', async () => {
    const t = createTestApp();

    const response = await t.request('GET', API_PATHS.settings);

    expect(response.status).toBe(200);
    expect(SettingsResponseSchema.parse(await response.json())).toEqual({
      settings: createDefaultSettings(),
      server: {
        mode: 'server',
        tls: { mode: 'off', insecure: false, caCertificatePem: null },
        publicOrigins: [],
      },
    });
  });

  test('describes an automatic TLS setup with its CA certificate', async () => {
    const tls: TlsProvider = {
      ...offTlsProvider,
      mode: 'auto',
      caCertificatePem: async () => '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n',
    };
    const t = createTestApp({
      tls,
      config: createTestConfig({
        mode: 'desktop',
        tls: { mode: 'auto', hostnames: ['wall.test'] },
        publicOrigins: ['https://wall.test'],
      }),
    });

    const { server } = SettingsResponseSchema.parse(
      await (await t.request('GET', API_PATHS.settings)).json(),
    );

    expect(server).toEqual({
      mode: 'desktop',
      tls: {
        mode: 'auto',
        insecure: false,
        caCertificatePem: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n',
      },
      publicOrigins: ['https://wall.test'],
    });
  });

  test('flags plain HTTP that was allowed beyond loopback, and only that', async () => {
    const insecure = async (config: Parameters<typeof createTestConfig>[0]) => {
      const t = createTestApp({ config: createTestConfig(config) });
      const body = await (await t.request('GET', API_PATHS.settings)).json();
      return SettingsResponseSchema.parse(body).server.tls.insecure;
    };

    expect(await insecure({ tls: { mode: 'off' }, allowInsecure: true })).toBe(true);
    expect(await insecure({ tls: { mode: 'off' }, allowInsecure: false })).toBe(false);
    expect(
      await insecure({ tls: { mode: 'auto', hostnames: ['wall.test'] }, allowInsecure: true }),
    ).toBe(false);
  });

  test('needs authentication', async () => {
    expect((await createTestApp().app.request(API_PATHS.settings)).status).toBe(401);
  });
});

describe('PUT /api/settings', () => {
  test('applies a partial update and returns the new settings', async () => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.settings, {
      language: 'zh-TW',
      limits: { maxAsksInFlight: 8 },
      layout: { columns: 5 },
    });

    expect(response.status).toBe(200);
    const { settings } = SettingsResponseSchema.parse(await response.json());
    expect(settings).toEqual({
      ...createDefaultSettings(),
      language: 'zh-TW',
      limits: { ...DEFAULT_LIMITS, maxAsksInFlight: 8 },
      layout: { mode: 'auto', minCellWidth: 360, columns: 5 },
    });
    const read = SettingsResponseSchema.parse(
      await (await t.request('GET', API_PATHS.settings)).json(),
    );
    expect(read.settings).toEqual(settings);
  });

  test('an empty body changes nothing', async () => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.settings, {});

    expect(SettingsResponseSchema.parse(await response.json()).settings).toEqual(
      createDefaultSettings(),
    );
  });

  test('an API key is write-only: responses say only that it exists', async () => {
    const secrets = createFakeSecretStore();
    const t = createTestApp({
      settings: createFakeSettingsService(createDefaultSettings(), secrets),
    });

    const response = await t.request('PUT', API_PATHS.settings, {
      providers: [...createDefaultSettings().providers, { ...endpoint, apiKey: 'sk-write-only' }],
    });
    const put = await response.text();
    const get = await (await t.request('GET', API_PATHS.settings)).text();

    expect(response.status).toBe(200);
    expect(await secrets.get(SECRET_KEYS.providerApiKey('local'))).toBe('sk-write-only');
    for (const body of [put, get]) {
      expect(body).not.toContain('sk-write-only');
      expect(body).not.toContain('apiKey');
      const { settings } = SettingsResponseSchema.parse(JSON.parse(body));
      expect(settings.providers.at(-1)).toEqual({ ...endpoint, hasApiKey: true });
    }
  });

  test.each([
    [
      'a limit above its hard maximum',
      { limits: { maxTargetsPerAsk: LIMIT_SPECS.maxTargetsPerAsk.max + 1 } },
    ],
    ['a limit below its minimum', { limits: { maxQueuedSlots: 0 } }],
    ['an unknown language', { language: 'tlh' }],
    ['a provider list without every CLI provider', { providers: [] }],
    [
      'an API key that is not text',
      { providers: [...createDefaultSettings().providers, { ...endpoint, apiKey: 42 }] },
    ],
    ['a value of the wrong type', { updateCheck: 'yes' }],
  ])('rejects %s and changes nothing', async (_, patch) => {
    const t = createTestApp();

    const response = await t.request('PUT', API_PATHS.settings, patch);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
    expect(t.deps.settings.get()).toEqual(createDefaultSettings());
  });

  test('rejects a body that is not JSON', async () => {
    const t = createTestApp();

    const response = await t.app.request(API_PATHS.settings, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-token-0123456789abcdef',
        'Content-Type': 'application/json',
      },
      body: 'language=en',
    });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('bad_request');
  });

  test('needs authentication', async () => {
    const t = createTestApp();

    const response = await t.app.request(API_PATHS.settings, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'zh-TW' }),
    });

    expect(response.status).toBe(401);
    expect(t.deps.settings.get().language).toBe('en');
  });
});
