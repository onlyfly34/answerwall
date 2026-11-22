import { describe, expect, test } from 'vitest';
import { AppError } from '../contracts/index.ts';
import type { ProviderAdapter } from '../contracts/index.ts';
import {
  createDefaultSettings,
  EXECUTED_PROVIDER_KINDS,
  ProvidersResponseSchema,
} from '../protocol/index.ts';
import type {
  ModelInfo,
  ProviderDetection,
  ProviderInstance,
  ExecutedProviderKind,
  Settings,
} from '../protocol/index.ts';
import {
  createFakeSettingsService,
  createMemoryLogger,
  FakeClock,
  FakeProviderAdapter,
  flushPromises,
  READY_DETECTION,
} from '../testing/index.ts';
import { createRegistry } from './registry.ts';

const ENDPOINT: ProviderInstance = {
  id: 'local',
  kind: 'openai-compat',
  label: 'Local',
  enabled: true,
  concurrency: 4,
  models: ['hand-added'],
  baseUrl: 'http://127.0.0.1:4000',
  hasApiKey: false,
};

function settingsWith(change: (settings: Settings) => void = () => undefined): Settings {
  const settings = createDefaultSettings();
  settings.providers.push(structuredClone(ENDPOINT));
  change(settings);
  return settings;
}

const cli = (settings: Settings, kind: ExecutedProviderKind) => {
  const instance = settings.providers.find((candidate) => candidate.kind === kind);
  if (instance === undefined || instance.kind === 'openai-compat' || instance.kind === 'web') {
    throw new Error('no such CLI');
  }
  return instance;
};

function setup(initial = settingsWith(), adapterOverrides: ProviderAdapter[] = []) {
  const clock = new FakeClock(1_700_000_000_000);
  const logger = createMemoryLogger();
  const settings = createFakeSettingsService(initial);
  const fakes = new Map(
    EXECUTED_PROVIDER_KINDS.map((kind) => [
      kind,
      new FakeProviderAdapter({
        kind,
        clock,
        toolAccess: kind === 'openai-compat' ? 'none' : 'disabled',
        models: [{ id: `${kind}-listed`, label: 'Listed' }],
      }),
    ]),
  );
  const adapters: ProviderAdapter[] = EXECUTED_PROVIDER_KINDS.map(
    (kind) => adapterOverrides.find((adapter) => adapter.kind === kind) ?? fake(kind),
  );
  const shutdown = new AbortController();
  const registry = createRegistry({ settings, clock, logger, adapters, shutdown });
  function fake(kind: ExecutedProviderKind): FakeProviderAdapter {
    const adapter = fakes.get(kind);
    if (!adapter) throw new Error('no fake');
    return adapter;
  }
  const status = (id: string) => {
    const found = registry.list().find((entry) => entry.instance.id === id);
    if (!found) throw new Error(`no status for ${id}`);
    return found;
  };
  const detectCalls = () => EXECUTED_PROVIDER_KINDS.map((kind) => fake(kind).detectCalls);
  return { clock, logger, settings, registry, shutdown, fake, status, detectCalls };
}

/** An adapter whose detection and model listing the test resolves by hand. */
function manualAdapter(kind: ExecutedProviderKind) {
  const detections: ((detection: ProviderDetection) => void)[] = [];
  const adapter: ProviderAdapter = {
    kind,
    toolAccess: 'disabled',
    loginCommand: `${kind} login`,
    detect: () => new Promise((resolve) => detections.push(resolve)),
    listModels: async () => [{ id: 'listed' }],
    run: async function* () {},
  };
  return { adapter, detections };
}

describe('provider registry', () => {
  test('list shows every configured instance without ever detecting anything', () => {
    const t = setup();

    const first = t.registry.list();
    t.registry.list();

    expect(first.map((entry) => entry.instance.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'opencode',
      'local',
    ]);
    expect(first.every((entry) => entry.detection === null && entry.detectedAt === null)).toBe(
      true,
    );
    expect(t.detectCalls()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(() => ProvidersResponseSchema.parse({ providers: first })).not.toThrow();
  });

  test('before detection the models are the ones configured by hand', () => {
    const t = setup();

    expect(t.status('claude').models).toEqual([
      { id: 'fable' },
      { id: 'opus' },
      { id: 'sonnet' },
      { id: 'haiku' },
    ]);
    expect(t.status('local').models).toEqual([{ id: 'hand-added' }]);
  });

  test('reports the tool access note and the login command of each adapter', () => {
    const { adapter } = manualAdapter('codex');
    const t = setup(settingsWith(), [adapter]);

    expect(t.status('codex')).toMatchObject({
      toolAccess: 'disabled',
      loginCommand: 'codex login',
    });
    expect(t.status('local').toolAccess).toBe('none');
    expect(t.status('local')).not.toHaveProperty('loginCommand');
  });

  test('says for every provider whether it has a web search switch, and why not', () => {
    const t = setup();

    expect(t.registry.list().map((entry) => [entry.instance.id, entry.webSearch])).toEqual([
      ['claude', 'available'],
      ['codex', 'available'],
      ['agy', 'unconfirmed'],
      ['grok', 'unconfirmed'],
      ['opencode', 'unconfirmed'],
      ['local', 'none'],
    ]);
  });

  test('refresh detects every enabled instance and returns the updated list', async () => {
    const t = setup();
    await t.clock.advance(5_000);

    const list = await t.registry.refresh();

    // agy and opencode are disabled by default.
    expect(t.detectCalls()).toEqual([1, 1, 0, 1, 0, 1]);
    expect(list).toEqual(t.registry.list());
    expect(t.status('codex')).toMatchObject({
      detection: READY_DETECTION,
      detectedAt: 1_700_000_005_000,
    });
    expect(t.status('agy').detection).toBeNull();
    expect(() => ProvidersResponseSchema.parse({ providers: list })).not.toThrow();
  });

  test('detection carries the billing source and the streaming mode to the status', async () => {
    const t = setup();
    t.fake('codex').detection = {
      installed: true,
      version: '0.1.0',
      loggedIn: 'yes',
      billing: 'api-key',
      streaming: 'block',
      hint: 'Passed to the CLI from the environment: OPENAI_API_KEY.',
    };

    await t.registry.refresh('codex');

    expect(t.status('codex').detection).toMatchObject({ billing: 'api-key', streaming: 'block' });
  });

  test('refresh of one instance touches only that one, also when it is disabled', async () => {
    const t = setup(settingsWith((settings) => (cli(settings, 'grok').enabled = false)));

    await t.registry.refresh('grok');

    expect(t.detectCalls()).toEqual([0, 0, 0, 1, 0, 0]);
    expect(t.status('grok').detection).toEqual(READY_DETECTION);
    expect(t.status('claude').detection).toBeNull();
  });

  test('refresh of an unknown id fails with unknown_provider', async () => {
    const t = setup();

    const error = await t.registry.refresh('nope').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('unknown_provider');
    expect(t.detectCalls()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  test('agy is never started before its notice is acknowledged, not even for detection', async () => {
    const t = setup();

    await t.registry.refresh('agy');
    await t.registry.refresh();

    expect(t.fake('agy').detectCalls).toBe(0);
    expect(t.status('agy')).toMatchObject({ detection: null, detectedAt: null });
  });

  test('agy is detected once the notice is acknowledged', async () => {
    const t = setup(
      settingsWith((settings) => {
        cli(settings, 'agy').riskAcknowledged = true;
        cli(settings, 'agy').enabled = true;
      }),
    );

    await t.registry.refresh();

    expect(t.fake('agy').detectCalls).toBe(1);
    expect(t.status('agy').detection).toEqual(READY_DETECTION);
  });

  test('acknowledging the notice later makes the next refresh detect agy', async () => {
    const t = setup();
    await t.registry.refresh('agy');

    await t.settings.update({
      providers: t.settings
        .get()
        .providers.map((instance) =>
          instance.kind === 'agy'
            ? { ...instance, riskAcknowledged: true, enabled: true }
            : instance,
        ),
    });
    await t.registry.refresh('agy');

    expect(t.fake('agy').detectCalls).toBe(1);
  });

  test('merges the hand-added models with the listed ones, hand-added first, without duplicates', async () => {
    const t = setup(
      settingsWith((settings) => (cli(settings, 'codex').models = ['mine', 'codex-listed'])),
    );

    await t.registry.refresh('codex');

    expect(t.status('codex').models).toEqual([
      { id: 'mine' },
      { id: 'codex-listed', label: 'Listed' },
    ]);
  });

  test.each([
    ['is not installed', { installed: false, loggedIn: 'unknown', streaming: 'unknown' }],
    ['is logged out', { installed: true, loggedIn: 'no', streaming: 'token' }],
  ] as const)('does not list models from a provider that %s', async (_, detection) => {
    let listed = 0;
    const { adapter, detections } = manualAdapter('codex');
    adapter.listModels = async () => {
      listed++;
      return [];
    };
    const t = setup(settingsWith(), [adapter]);

    const refreshed = t.registry.refresh('codex');
    await flushPromises();
    detections[0]?.(detection);
    await refreshed;

    expect(listed).toBe(0);
    expect(t.status('codex').detection).toEqual(detection);
  });

  test('a detection that throws is recorded as failed, logged without details, and does not break the others', async () => {
    const { adapter } = manualAdapter('codex');
    adapter.detect = async () => {
      throw new Error('secret path /home/user/.codex/auth.json');
    };
    const t = setup(settingsWith(), [adapter]);

    await t.registry.refresh();

    expect(t.status('codex').detection).toEqual({
      installed: false,
      loggedIn: 'unknown',
      streaming: 'unknown',
      hint: 'Detection failed unexpectedly.',
    });
    expect(t.status('claude').detection).toEqual(READY_DETECTION);
    expect(JSON.stringify(t.logger.entries)).not.toContain('auth.json');
    expect(t.logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  test('a detection that does not fit the protocol is replaced, never passed on', async () => {
    const { adapter, detections } = manualAdapter('codex');
    const t = setup(settingsWith(), [adapter]);

    const refreshed = t.registry.refresh('codex');
    await flushPromises();
    detections[0]?.({
      installed: true,
      loggedIn: 'yes',
      streaming: 'token',
      hint: 'x'.repeat(501),
    });
    await refreshed;

    expect(t.status('codex').detection?.hint).toBe('Detection failed unexpectedly.');
  });

  test('a model listing that throws leaves the detection and an empty listing', async () => {
    const t = setup();
    t.fake('codex').listModels = async () => {
      throw new Error('boom');
    };

    await t.registry.refresh('codex');

    expect(t.status('codex').detection).toEqual(READY_DETECTION);
    expect(t.status('codex').models).toEqual([]);
  });

  test('drops listed models that do not fit the protocol', async () => {
    const t = setup();
    t.fake('codex').listModels = async () =>
      [{ id: 'good' }, { id: '' }, { id: 'x'.repeat(300) }, { nope: true }] as ModelInfo[];

    await t.registry.refresh('codex');

    expect(t.status('codex').models).toEqual([{ id: 'good' }]);
  });

  test('concurrent refreshes of one instance share a single detection', async () => {
    const { adapter, detections } = manualAdapter('codex');
    const t = setup(settingsWith(), [adapter]);

    const first = t.registry.refresh('codex');
    const second = t.registry.refresh('codex');
    await flushPromises();
    expect(detections).toHaveLength(1);
    // A list read meanwhile says that this one is about to change.
    expect(t.status('codex')).toMatchObject({ detection: null, detecting: true });
    expect(t.status('claude').detecting).toBe(false);
    detections[0]?.(READY_DETECTION);
    await Promise.all([first, second]);
    expect(t.status('codex')).toMatchObject({ detection: READY_DETECTION, detecting: false });

    // A refresh after that one has finished detects again.
    const third = t.registry.refresh('codex');
    await flushPromises();
    expect(detections).toHaveLength(2);
    detections[1]?.(READY_DETECTION);
    await third;
  });

  test('a setting that changes what detection would find makes the cached result stale', async () => {
    const t = setup();
    await t.registry.refresh();
    const patch = (change: (instance: ProviderInstance) => ProviderInstance) =>
      t.settings.update({ providers: t.settings.get().providers.map(change) });

    await patch((instance) =>
      instance.id === 'claude' ? { ...instance, label: 'Renamed', concurrency: 3 } : instance,
    );
    expect(t.status('claude').detection).toEqual(READY_DETECTION);

    await patch((instance) =>
      instance.kind === 'claude' ? { ...instance, useEnvApiKey: true } : instance,
    );
    expect(t.status('claude')).toMatchObject({ detection: null, detectedAt: null });
    expect(t.status('claude').models.map((model) => model.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);

    await patch((instance) =>
      instance.kind === 'openai-compat'
        ? { ...instance, baseUrl: 'http://127.0.0.1:5000' }
        : instance,
    );
    expect(t.status('local').detection).toBeNull();
    expect(t.status('codex').detection).toEqual(READY_DETECTION);
    // Staleness never triggers a detection by itself.
    expect(t.detectCalls()).toEqual([1, 1, 0, 1, 0, 1]);
  });

  test('forgets a removed instance, so a new one with the same id starts undetected', async () => {
    const t = setup();
    await t.registry.refresh('local');
    const withoutEndpoint = t.settings
      .get()
      .providers.filter((instance) => instance.id !== 'local');

    await t.settings.update({ providers: withoutEndpoint });
    expect(t.registry.list().map((entry) => entry.instance.id)).not.toContain('local');
    await t.settings.update({ providers: [...withoutEndpoint, ENDPOINT] });

    expect(t.status('local').detection).toBeNull();
  });

  test('a web provider is listed without detection and is never refreshed', async () => {
    const t = setup(
      settingsWith((settings) => {
        settings.providers.push({
          id: 'web-claude',
          kind: 'web',
          site: 'claude',
          label: 'Claude (web)',
          enabled: true,
          concurrency: 2,
          models: [],
        });
      }),
    );
    const before = t.detectCalls();

    await t.registry.refresh('web-claude');
    const all = await t.registry.refresh();

    expect(ProvidersResponseSchema.safeParse({ providers: all }).success).toBe(true);
    expect(t.status('web-claude')).toEqual({
      instance: expect.objectContaining({ id: 'web-claude', kind: 'web' }) as unknown,
      detection: null,
      detectedAt: null,
      detecting: false,
      models: [],
      toolAccess: 'unrestricted',
      webSearch: 'none',
    });
    // Only the enabled providers the server runs itself were detected by the second refresh.
    expect(t.detectCalls().some((calls, index) => calls > (before[index] ?? 0))).toBe(true);
  });

  test('adapter returns the adapter of a kind', () => {
    const t = setup();

    for (const kind of EXECUTED_PROVIDER_KINDS) {
      expect(t.registry.adapter(kind)).toBe(t.fake(kind));
    }
  });

  test('shutdown aborts the shared signal, waits for running detections and discards their results', async () => {
    const { adapter, detections } = manualAdapter('codex');
    const t = setup(settingsWith(), [adapter]);
    const refreshed = t.registry.refresh('codex');
    await flushPromises();

    let stopped = false;
    const stopping = t.registry.shutdown().then(() => (stopped = true));
    await flushPromises();
    expect(t.shutdown.signal.aborted).toBe(true);
    expect(stopped).toBe(false);

    detections[0]?.(READY_DETECTION);
    await stopping;
    await refreshed;

    expect(t.status('codex').detection).toBeNull();
  });

  test('after shutdown a refresh detects nothing', async () => {
    const t = setup();
    await t.registry.shutdown();

    const list = await t.registry.refresh();

    expect(t.detectCalls()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(list.every((entry) => entry.detection === null)).toBe(true);
  });
});
