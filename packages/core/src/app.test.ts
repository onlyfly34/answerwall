import { describe, expect, test } from 'vitest';
import { BRAND } from './brand.ts';
import {
  API_PATHS,
  ApiErrorBodySchema,
  DevicesResponseSchema,
  HistoryPageSchema,
  ProvidersResponseSchema,
  SettingsResponseSchema,
} from './protocol/index.ts';
import type { PresetInput } from './protocol/index.ts';
import {
  createMemoryLogger,
  createOpenHttpLayer,
  createTestApp,
  TEST_PAIRING_CODE,
} from './testing/index.ts';

// What a browser sends: no bearer token, so the request must name its origin.
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  body: JSON.stringify(body),
});

describe('authentication boundary', () => {
  test.each([
    ['GET', API_PATHS.providers],
    ['GET', API_PATHS.settings],
    ['GET', API_PATHS.history],
    ['GET', API_PATHS.presets],
    ['GET', API_PATHS.authDevices],
    ['POST', API_PATHS.ask],
    ['POST', API_PATHS.authLogout],
    ['POST', API_PATHS.authPairingCodes],
    ['GET', '/api/does-not-exist'],
  ])('%s %s needs a session', async (method, path) => {
    const { app } = createTestApp();
    const response = await app.request(path, { method });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  test('pairing sets an HttpOnly, SameSite=Strict cookie that then authenticates', async () => {
    const { app } = createTestApp();

    const paired = await app.request(
      API_PATHS.authPair,
      json({ code: TEST_PAIRING_CODE, deviceName: 'Phone' }),
    );
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get('Set-Cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${BRAND.sessionCookie}=[^;]+; `));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');

    const devices = await app.request(API_PATHS.authDevices, {
      headers: { Cookie: cookie.split(';')[0] ?? '' },
    });
    expect(DevicesResponseSchema.parse(await devices.json()).devices).toMatchObject([
      { name: 'Phone', current: true },
    ]);
  });

  test('a wrong pairing code is rejected', async () => {
    const { app } = createTestApp();
    const response = await app.request(
      API_PATHS.authPair,
      json({ code: '00000000', deviceName: 'Phone' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_code' } });
  });

  test('only a rejected credential is flagged as a failed attempt', async () => {
    const flagged: string[] = [];
    const http = createOpenHttpLayer(createMemoryLogger());
    const { app } = createTestApp({
      http: {
        ...http,
        authRateLimit: async (c, next) => {
          await next();
          if (c.var.authFailure) flagged.push(`${c.req.method} ${c.req.path}`);
        },
      },
    });

    await app.request(API_PATHS.settings);
    await app.request(API_PATHS.providers, { headers: { Authorization: 'Bearer wrong-token' } });
    await app.request(API_PATHS.presets, { headers: { Cookie: `${BRAND.sessionCookie}=stale` } });
    await app.request(API_PATHS.authPair, json({ code: '00000000', deviceName: 'Phone' }));
    await app.request(API_PATHS.authSession, json({ token: 'wrong-token-0123456789' }));
    await app.request(API_PATHS.authPair, json({ code: TEST_PAIRING_CODE, deviceName: 'Phone' }));

    expect(flagged).toEqual([
      `GET ${API_PATHS.providers}`,
      `GET ${API_PATHS.presets}`,
      `POST ${API_PATHS.authPair}`,
      `POST ${API_PATHS.authSession}`,
    ]);
  });
});

describe('routes delegate to their units', () => {
  test('providers are listed without detection and detected on refresh', async () => {
    const t = createTestApp();

    const listed = ProvidersResponseSchema.parse(
      await (await t.request('GET', API_PATHS.providers)).json(),
    );
    expect(listed.providers.map((p) => [p.instance.id, p.detection])).toEqual([
      ['claude', null],
      ['codex', null],
      ['agy', null],
      ['grok', null],
    ]);

    const refreshed = ProvidersResponseSchema.parse(
      await (await t.request('POST', API_PATHS.providersRefresh, { id: 'codex' })).json(),
    );
    expect(refreshed.providers.find((p) => p.instance.id === 'codex')?.detection?.loggedIn).toBe(
      'yes',
    );
  });

  test('settings round-trip and never return an API key', async () => {
    const t = createTestApp();
    const current = SettingsResponseSchema.parse(
      await (await t.request('GET', API_PATHS.settings)).json(),
    );

    const response = await t.request('PUT', API_PATHS.settings, {
      limits: { maxAsksInFlight: 2 },
      providers: [
        ...current.settings.providers,
        {
          id: 'local',
          kind: 'openai-compat',
          label: 'Local',
          enabled: true,
          concurrency: 4,
          models: [],
          baseUrl: 'http://127.0.0.1:4000',
          apiKey: 'sk-secret',
        },
      ],
    });

    const text = await response.text();
    expect(text).not.toContain('sk-secret');
    const updated = SettingsResponseSchema.parse(JSON.parse(text));
    expect(updated.settings.limits.maxAsksInFlight).toBe(2);
    expect(updated.settings.providers.at(-1)).toMatchObject({ id: 'local', hasApiKey: true });
  });

  test('invalid input is a 400 naming the field', async () => {
    const t = createTestApp();
    const response = await t.request('PUT', API_PATHS.settings, {
      limits: { maxAsksInFlight: 99 },
    });
    expect(response.status).toBe(400);
    const { error } = ApiErrorBodySchema.parse(await response.json());
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('limits.maxAsksInFlight');
  });

  test('presets can be saved, listed and deleted', async () => {
    const t = createTestApp();
    const input: PresetInput = {
      name: 'Quick three',
      slots: [{ slotId: 'a', providerId: 'claude' }],
    };

    const saved = await t.request('PUT', API_PATHS.preset('p1'), input);
    expect(await saved.json()).toMatchObject({ id: 'p1', name: 'Quick three' });
    const listed = (await (await t.request('GET', API_PATHS.presets)).json()) as {
      presets: unknown[];
    };
    expect(listed.presets).toHaveLength(1);

    expect((await t.request('DELETE', API_PATHS.preset('p1'))).status).toBe(200);
    expect((await t.request('GET', API_PATHS.preset('p1'))).status).toBe(404);
  });

  test('history is paged and tolerates empty query parameters', async () => {
    const t = createTestApp();
    const response = await t.request('GET', `${API_PATHS.history}?q=&cursor=&limit=`);
    expect(HistoryPageSchema.parse(await response.json())).toEqual({ items: [], nextCursor: null });
    expect((await t.request('DELETE', API_PATHS.historyEntry('missing'))).status).toBe(404);
  });

  test('deleting a history entry also drops the ask from the runner', async () => {
    const t = createTestApp();
    const { askId } = await t.asks.submit({
      prompt: 'hi',
      targets: [{ slotId: 'a', providerId: 'claude' }],
    });
    t.asks.emit(askId, { type: 'ask_done' });
    await t.deps.storage.turns.create(await t.asks.snapshot(askId));

    expect((await t.request('DELETE', API_PATHS.historyEntry(askId))).status).toBe(200);
    expect((await t.request('GET', API_PATHS.askSnapshot(askId))).status).toBe(404);
  });
});
