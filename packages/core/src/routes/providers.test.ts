import { describe, expect, test } from 'vitest';
import { API_PATHS, createDefaultSettings, ProvidersResponseSchema } from '../protocol/index.ts';
import {
  createFakeProviderRegistry,
  createFakeSettingsService,
  createTestApp,
  FakeClock,
  FakeProviderAdapter,
  READY_DETECTION,
} from '../testing/index.ts';

function setup() {
  const clock = new FakeClock();
  const settings = createFakeSettingsService(createDefaultSettings());
  const claude = new FakeProviderAdapter({ kind: 'claude', clock, models: [{ id: 'listed' }] });
  const codex = new FakeProviderAdapter({ kind: 'codex', clock });
  const providers = createFakeProviderRegistry({ settings, clock, adapters: [claude, codex] });
  return { ...createTestApp({ settings, providers }, clock), claude, codex };
}

const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe('GET /api/providers', () => {
  test('returns the cached status of every provider without detecting anything', async () => {
    const t = setup();

    const response = await t.request('GET', API_PATHS.providers);
    await t.request('GET', API_PATHS.providers);

    expect(response.status).toBe(200);
    const { providers } = ProvidersResponseSchema.parse(await response.json());
    expect(providers.map((status) => status.instance.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
    ]);
    expect(providers.every((status) => status.detection === null)).toBe(true);
    expect(t.claude.detectCalls + t.codex.detectCalls).toBe(0);
  });

  test('shows what the last refresh found', async () => {
    const t = setup();
    await t.request('POST', API_PATHS.providersRefresh, { id: 'claude' });

    const { providers } = ProvidersResponseSchema.parse(
      await (await t.request('GET', API_PATHS.providers)).json(),
    );

    expect(providers[0]).toMatchObject({ detection: READY_DETECTION, detectedAt: t.clock.now() });
    expect(providers[0]?.models.at(-1)).toEqual({ id: 'listed' });
    expect(t.claude.detectCalls).toBe(1);
  });

  test('requires authentication', async () => {
    expect((await setup().app.request(API_PATHS.providers)).status).toBe(401);
  });
});

describe('POST /api/providers/refresh', () => {
  test('without an id re-detects every enabled provider and returns the list', async () => {
    const t = setup();

    const response = await t.request('POST', API_PATHS.providersRefresh, {});

    expect(response.status).toBe(200);
    const { providers } = ProvidersResponseSchema.parse(await response.json());
    expect(providers.find((status) => status.instance.id === 'codex')?.detection).toEqual(
      READY_DETECTION,
    );
    expect(providers.find((status) => status.instance.id === 'agy')?.detection).toBeNull();
    expect([t.claude.detectCalls, t.codex.detectCalls]).toEqual([1, 1]);
  });

  test('with an id re-detects only that provider', async () => {
    const t = setup();

    const response = await t.request('POST', API_PATHS.providersRefresh, { id: 'codex' });

    expect(response.status).toBe(200);
    expect([t.claude.detectCalls, t.codex.detectCalls]).toEqual([0, 1]);
  });

  test('rejects an unknown provider id', async () => {
    const response = await setup().request('POST', API_PATHS.providersRefresh, { id: 'nope' });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('unknown_provider');
  });

  test.each([{ id: 'Not A Slug' }, { id: 7 }, { id: '' }])(
    'rejects the malformed body %j',
    async (body) => {
      const t = setup();

      const response = await t.request('POST', API_PATHS.providersRefresh, body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('bad_request');
      expect(t.claude.detectCalls + t.codex.detectCalls).toBe(0);
    },
  );

  test('requires authentication', async () => {
    const response = await setup().app.request(API_PATHS.providersRefresh, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
  });
});
