import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppError, SECRET_KEYS, secretEnvName } from '../contracts/index.ts';
import type { SecretStore, Storage } from '../contracts/index.ts';
import {
  CLI_PROVIDER_KINDS,
  createDefaultSettings,
  DEFAULT_LIMITS,
  LIMIT_SPECS,
  SettingsSchema,
} from '../protocol/index.ts';
import type { ProviderInstanceInput, Settings, SettingsPatch } from '../protocol/index.ts';
import { createFakeSecretStore, createFakeStorage, createMemoryLogger } from '../testing/index.ts';
import { createFileSecretStore } from './secret-store.ts';
import { createSettingsService } from './service.ts';

const KEY = SECRET_KEYS.providerApiKey;

const cliInputs = (): ProviderInstanceInput[] => createDefaultSettings().providers;

const endpoint = (
  id: string,
  overrides: Partial<Extract<ProviderInstanceInput, { kind: 'openai-compat' }>> = {},
): ProviderInstanceInput => ({
  id,
  kind: 'openai-compat',
  label: `Endpoint ${id}`,
  enabled: true,
  concurrency: 4,
  models: ['some-model'],
  baseUrl: 'http://127.0.0.1:4000/v1',
  ...overrides,
});

const withEndpoints = (...endpoints: ProviderInstanceInput[]): SettingsPatch => ({
  providers: [...cliInputs(), ...endpoints],
});

interface Harness {
  storage: Storage;
  secrets: SecretStore;
  logger: ReturnType<typeof createMemoryLogger>;
  service: ReturnType<typeof createSettingsService>;
}

async function setup(
  options: { document?: unknown; secrets?: SecretStore; storage?: Storage } = {},
): Promise<Harness> {
  const storage = options.storage ?? createFakeStorage();
  if (options.document !== undefined) await storage.settings.save(options.document);
  const secrets = options.secrets ?? createFakeSecretStore();
  const logger = createMemoryLogger();
  const service = createSettingsService({ storage, secrets, logger });
  await service.load();
  return { storage, secrets, logger, service };
}

const hasApiKey = (settings: Settings, id: string): boolean | undefined => {
  const provider = settings.providers.find((candidate) => candidate.id === id);
  return provider?.kind === 'openai-compat' ? provider.hasApiKey : undefined;
};

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );

describe('load', () => {
  test('before load, and on a first run, the settings are the defaults', async () => {
    const storage = createFakeStorage();
    const service = createSettingsService({ storage, secrets: createFakeSecretStore() });
    expect(service.get()).toEqual(createDefaultSettings());

    await service.load();

    expect(service.get()).toEqual(createDefaultSettings());
    expect(await storage.settings.load()).toBeUndefined();
  });

  test('stored settings are returned, with hasApiKey taken from the secret store', async () => {
    const document = {
      ...createDefaultSettings(),
      language: 'zh-TW',
      providers: [
        ...createDefaultSettings().providers,
        { ...endpoint('with-key') },
        { ...endpoint('without-key') },
      ],
    };

    const { service, logger } = await setup({
      document,
      secrets: createFakeSecretStore({ [KEY('with-key')]: 'sk-stored' }),
    });

    const settings = service.get();
    expect(SettingsSchema.parse(settings)).toEqual(settings);
    expect(settings.language).toBe('zh-TW');
    expect(hasApiKey(settings, 'with-key')).toBe(true);
    expect(hasApiKey(settings, 'without-key')).toBe(false);
    expect(logger.entries).toEqual([]);
  });

  test('a valid stored document is not written again', async () => {
    const storage = createFakeStorage();
    await storage.settings.save({ ...createDefaultSettings(), language: 'zh-TW' });
    let saves = 0;
    const counting: Storage = {
      ...storage,
      settings: {
        load: () => storage.settings.load(),
        save: (document) => {
          saves++;
          return storage.settings.save(document);
        },
      },
    };

    await setup({ storage: counting });

    expect(saves).toBe(0);
  });

  test.each(CLI_PROVIDER_KINDS)(
    'a stored document missing %s is repaired, saved back and reported',
    async (kind) => {
      const defaults = createDefaultSettings();
      const document = {
        ...defaults,
        updateCheck: false,
        providers: defaults.providers.filter((provider) => provider.id !== kind),
      };

      const { service, storage, logger } = await setup({ document });

      const restored = service.get().providers.find((provider) => provider.id === kind);
      expect(restored).toEqual(defaults.providers.find((provider) => provider.id === kind));
      expect(service.get().updateCheck).toBe(false);
      expect(SettingsSchema.safeParse(service.get()).success).toBe(true);
      expect(SettingsSchema.safeParse(await storage.settings.load()).success).toBe(true);
      expect(logger.entries.map((entry) => entry.level)).toEqual(['warn']);
    },
  );

  test('stored limits beyond the hard maxima are pulled back inside', async () => {
    const { service } = await setup({
      document: {
        ...createDefaultSettings(),
        limits: { ...DEFAULT_LIMITS, maxTargetsPerAsk: 5000, maxAsksInFlight: 99 },
      },
    });

    expect(service.get().limits).toEqual({
      ...DEFAULT_LIMITS,
      maxTargetsPerAsk: LIMIT_SPECS.maxTargetsPerAsk.max,
      maxAsksInFlight: LIMIT_SPECS.maxAsksInFlight.max,
    });
  });

  test('a stored document of the wrong shape becomes the defaults', async () => {
    const { service } = await setup({ document: 'not settings at all' });

    expect(service.get()).toEqual(createDefaultSettings());
  });

  test('a key flag or a key that leaked into the stored document is removed from it', async () => {
    const document = {
      ...createDefaultSettings(),
      providers: [
        ...createDefaultSettings().providers,
        { ...endpoint('local'), hasApiKey: true, apiKey: 'sk-leaked' },
      ],
    };

    const { service, storage } = await setup({ document });

    expect(hasApiKey(service.get(), 'local')).toBe(false);
    expect(JSON.stringify(await storage.settings.load())).not.toMatch(/sk-leaked|hasApiKey/);
  });
});

describe('get', () => {
  test('returns a copy: changing it does not change the settings', async () => {
    const { service } = await setup();

    const copy = service.get();
    copy.language = 'zh-TW';
    copy.providers.length = 0;
    copy.limits.maxAsksInFlight = 1;

    expect(service.get()).toEqual(createDefaultSettings());
  });
});

describe('update', () => {
  test('changes only the fields that are given', async () => {
    const { service } = await setup();

    const updated = await service.update({ language: 'zh-TW' });

    expect(updated).toEqual({ ...createDefaultSettings(), language: 'zh-TW' });
    expect(service.get()).toEqual(updated);
  });

  test('an empty patch changes nothing', async () => {
    const { service } = await setup();

    expect(await service.update({})).toEqual(createDefaultSettings());
  });

  test('limits and layout are merged field by field', async () => {
    const { service } = await setup();

    await service.update({ limits: { maxAsksInFlight: 8 }, layout: { mode: 'fixed' } });
    const updated = await service.update({
      limits: { historyMaxAsks: 50 },
      layout: { columns: 5 },
      updateCheck: false,
    });

    expect(updated.limits).toEqual({ ...DEFAULT_LIMITS, maxAsksInFlight: 8, historyMaxAsks: 50 });
    expect(updated.layout).toEqual({ mode: 'fixed', minCellWidth: 360, columns: 5 });
    expect(updated.updateCheck).toBe(false);
  });

  test('an update is persisted: the next service on the same storage starts with it', async () => {
    const first = await setup();
    await first.service.update({
      language: 'zh-TW',
      limits: { slotTimeoutMs: 10_000 },
      ...withEndpoints(endpoint('local', { apiKey: 'sk-persisted' })),
    });

    const second = await setup({ storage: first.storage, secrets: first.secrets });

    expect(second.service.get()).toEqual(first.service.get());
    expect(hasApiKey(second.service.get(), 'local')).toBe(true);
    expect(second.logger.entries).toEqual([]);
  });

  test('the result is a copy', async () => {
    const { service } = await setup();

    const updated = await service.update({ language: 'zh-TW' });
    updated.language = 'en';

    expect(service.get().language).toBe('zh-TW');
  });

  describe('validation', () => {
    const invalid: [string, unknown, RegExp][] = [
      ['an unknown language', { language: 'tlh' }, /language/],
      [
        'targets per ask above the hard maximum',
        { limits: { maxTargetsPerAsk: LIMIT_SPECS.maxTargetsPerAsk.max + 1 } },
        /limits\.maxTargetsPerAsk/,
      ],
      [
        'asks in flight above the hard maximum',
        { limits: { maxAsksInFlight: LIMIT_SPECS.maxAsksInFlight.max + 1 } },
        /limits\.maxAsksInFlight/,
      ],
      [
        'queued slots above the hard maximum',
        { limits: { maxQueuedSlots: LIMIT_SPECS.maxQueuedSlots.max + 1 } },
        /limits\.maxQueuedSlots/,
      ],
      ['a limit below its minimum', { limits: { historyMaxAsks: 0 } }, /limits\.historyMaxAsks/],
      ['a fractional limit', { limits: { maxAsksInFlight: 1.5 } }, /limits\.maxAsksInFlight/],
      ['a limit that is not a number', { limits: { maxAsksInFlight: '4' } }, /maxAsksInFlight/],
      [
        'a prompt limit that reaches the body limit once merged',
        { limits: { maxPromptBytes: DEFAULT_LIMITS.maxRequestBodyBytes } },
        /maxPromptBytes must be smaller/,
      ],
      ['a layout out of range', { layout: { columns: 13 } }, /layout\.columns/],
      [
        'a provider list without every CLI provider',
        { providers: cliInputs().filter((provider) => provider.id !== 'grok') },
        /every CLI provider/,
      ],
      [
        'concurrency outside the bounds of the kind',
        {
          providers: cliInputs().map((p) => (p.id === 'claude' ? { ...p, concurrency: 6 } : p)),
        },
        /concurrency/,
      ],
      [
        'agy enabled without its acknowledgement',
        { providers: cliInputs().map((p) => (p.id === 'agy' ? { ...p, enabled: true } : p)) },
        /acknowledged/,
      ],
      ['two providers with one id', withEndpoints(endpoint('same'), endpoint('same')), /unique/],
      [
        'an endpoint with a URL that is not http',
        withEndpoints(endpoint('local', { baseUrl: 'file:///etc/passwd' })),
        /baseUrl/,
      ],
      ['something that is not an object', 'language=en', /./],
    ];

    test.each(invalid)('%s is a bad request and changes nothing', async (_, patch, message) => {
      const { service, storage, secrets } = await setup();
      const notified: Settings[] = [];
      service.subscribe((settings) => notified.push(settings));

      const error = await rejection(service.update(patch as SettingsPatch));

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'bad_request' });
      expect((error as AppError).message).toMatch(message);
      expect(service.get()).toEqual(createDefaultSettings());
      expect(await storage.settings.load()).toBeUndefined();
      expect(await secrets.get(KEY('local'))).toBeUndefined();
      expect(notified).toEqual([]);
    });

    test('a rejected update with an API key stores no key', async () => {
      const { service, secrets } = await setup();

      await rejection(
        service.update({
          ...withEndpoints(endpoint('local', { apiKey: 'sk-must-not-land' })),
          limits: { maxAsksInFlight: 1000 },
        }),
      );

      expect(await secrets.get(KEY('local'))).toBeUndefined();
    });

    test('every limit accepts its hard maximum and its minimum', async () => {
      const { service } = await setup();

      const atMax = await service.update({
        limits: {
          maxTargetsPerAsk: LIMIT_SPECS.maxTargetsPerAsk.max,
          maxAsksInFlight: LIMIT_SPECS.maxAsksInFlight.max,
          maxQueuedSlots: LIMIT_SPECS.maxQueuedSlots.max,
        },
      });
      const atMin = await service.update({
        limits: { maxTargetsPerAsk: 1, maxAsksInFlight: 1, maxQueuedSlots: 1 },
      });

      expect(atMax.limits).toMatchObject({
        maxTargetsPerAsk: 64,
        maxAsksInFlight: 16,
        maxQueuedSlots: 256,
      });
      expect(atMin.limits).toMatchObject({
        maxTargetsPerAsk: 1,
        maxAsksInFlight: 1,
        maxQueuedSlots: 1,
      });
    });
  });

  describe('credentials in an endpoint address', () => {
    test.each([
      ['a user name and password', 'https://alice:s3cretpass@llm.example/v1'],
      ['a user name', 'https://token-abcdef@llm.example/v1'],
      ['a query string', 'https://llm.example/v1?api-key=sk-abcdef123456'],
      ['a fragment', 'https://llm.example/v1#sk-abcdef123456'],
    ])('an address with %s is refused and nothing of it is stored', async (_, baseUrl) => {
      const { service, storage } = await setup();
      const before = service.get();

      const error = await rejection(service.update(withEndpoints(endpoint('local', { baseUrl }))));

      expect(error).toMatchObject({ name: 'AppError', code: 'bad_request' });
      expect((error as Error).message).toMatch(/providers\.\d+\.baseUrl: .*API key/);
      expect((error as Error).message).not.toMatch(/s3cretpass|abcdef/);
      expect(service.get()).toEqual(before);
      expect(await storage.settings.load()).toBeUndefined();
    });

    test('a stored address loses its credentials on load, and the cleaned document is saved', async () => {
      const document = {
        ...createDefaultSettings(),
        providers: [
          ...createDefaultSettings().providers,
          endpoint('local', {
            baseUrl: 'https://alice:s3cretpass@llm.example/v1?api-key=sk-abcdef123456',
          }),
        ],
      };

      const { service, storage, logger } = await setup({ document });

      const stored = JSON.stringify(await storage.settings.load());
      expect(stored).not.toMatch(/s3cretpass|abcdef|alice/);
      expect(service.get().providers.find((provider) => provider.id === 'local')).toMatchObject({
        baseUrl: 'https://llm.example/v1',
      });
      expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
    });
  });

  describe('providers', () => {
    test('a CLI provider can be disabled and reconfigured, never removed', async () => {
      const { service } = await setup();

      const updated = await service.update({
        providers: cliInputs().map((provider) =>
          provider.id === 'codex'
            ? {
                ...provider,
                enabled: false,
                concurrency: 5,
                models: ['gpt-x'],
                defaultModel: 'gpt-x',
              }
            : provider,
        ),
      });

      expect(updated.providers.find((provider) => provider.id === 'codex')).toMatchObject({
        enabled: false,
        concurrency: 5,
        models: ['gpt-x'],
        defaultModel: 'gpt-x',
      });
      expect(updated.providers.map((provider) => provider.id)).toEqual([...CLI_PROVIDER_KINDS]);
    });

    test('agy can be enabled together with its acknowledgement', async () => {
      const { service } = await setup();

      const updated = await service.update({
        providers: cliInputs().map((provider) =>
          provider.id === 'agy' ? { ...provider, enabled: true, riskAcknowledged: true } : provider,
        ),
      });

      expect(updated.providers.find((provider) => provider.id === 'agy')).toMatchObject({
        enabled: true,
      });
    });

    test('web search can be switched on for the tools that have the switch, and only for those', async () => {
      const { service, storage } = await setup();
      const withSearch = (id: string): SettingsPatch => ({
        providers: cliInputs().map((provider) =>
          provider.id === id ? { ...provider, webSearch: true } : provider,
        ),
      });

      const updated = await service.update(withSearch('codex'));

      expect(
        updated.providers.map((provider) => 'webSearch' in provider && provider.webSearch),
      ).toEqual([false, true, false, false, false]);
      expect(JSON.stringify(await storage.settings.load())).toContain('"webSearch":true');
      for (const id of ['agy', 'grok', 'opencode']) {
        expect(await rejection(service.update(withSearch(id)))).toMatchObject({
          code: 'bad_request',
        });
      }
      expect(service.get()).toEqual(updated);
    });

    test('settings stored before the web search switch existed load with it off', async () => {
      const old = createDefaultSettings().providers.map((provider) => {
        const fields: Record<string, unknown> = { ...provider };
        delete fields.webSearch;
        return fields;
      });

      const { service } = await setup({ document: { ...createDefaultSettings(), providers: old } });

      expect(service.get().providers).toEqual(createDefaultSettings().providers);
    });

    test('the list replaces the old one: an endpoint left out is removed', async () => {
      const { service } = await setup();
      await service.update(withEndpoints(endpoint('one'), endpoint('two')));

      const updated = await service.update(withEndpoints(endpoint('two')));

      expect(updated.providers.map((provider) => provider.id)).toEqual([
        ...CLI_PROVIDER_KINDS,
        'two',
      ]);
    });
  });

  describe('API keys', () => {
    test('a key goes to the secret store; settings and storage only know that it exists', async () => {
      const { service, storage, secrets } = await setup();

      const updated = await service.update(
        withEndpoints(endpoint('local', { apiKey: 'sk-write-only' })),
      );

      expect(await secrets.get(KEY('local'))).toBe('sk-write-only');
      expect(hasApiKey(updated, 'local')).toBe(true);
      expect(JSON.stringify(updated)).not.toContain('sk-write-only');
      expect(JSON.stringify(service.get())).not.toContain('sk-write-only');
      expect(JSON.stringify(await storage.settings.load())).not.toMatch(/sk-write-only|apiKey/);
    });

    test('an endpoint added without a key has none', async () => {
      const { service } = await setup();

      expect(hasApiKey(await service.update(withEndpoints(endpoint('local'))), 'local')).toBe(
        false,
      );
    });

    test('omitting the key keeps it, a string replaces it, null deletes it', async () => {
      const { service, secrets } = await setup();
      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-one' })));

      const kept = await service.update(withEndpoints(endpoint('local', { label: 'Renamed' })));
      expect(hasApiKey(kept, 'local')).toBe(true);
      expect(await secrets.get(KEY('local'))).toBe('sk-one');

      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-two' })));
      expect(await secrets.get(KEY('local'))).toBe('sk-two');

      const cleared = await service.update(withEndpoints(endpoint('local', { apiKey: null })));
      expect(hasApiKey(cleared, 'local')).toBe(false);
      expect(await secrets.get(KEY('local'))).toBeUndefined();
    });

    test('an update without a provider list leaves every key alone', async () => {
      const { service, secrets } = await setup();
      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-one' })));

      const updated = await service.update({ language: 'zh-TW' });

      expect(hasApiKey(updated, 'local')).toBe(true);
      expect(await secrets.get(KEY('local'))).toBe('sk-one');
    });

    test('removing an endpoint deletes its key, so a later endpoint with that id starts without one', async () => {
      const { service, secrets } = await setup();
      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-old' })));

      await service.update({ providers: cliInputs() });
      expect(await secrets.get(KEY('local'))).toBeUndefined();

      const again = await service.update(withEndpoints(endpoint('local')));
      expect(hasApiKey(again, 'local')).toBe(false);
    });

    test('a new endpoint does not inherit a key left behind under its id', async () => {
      const { service, secrets } = await setup({
        secrets: createFakeSecretStore({ [KEY('local')]: 'sk-orphan' }),
      });

      const updated = await service.update(withEndpoints(endpoint('local')));

      expect(hasApiKey(updated, 'local')).toBe(false);
      expect(await secrets.get(KEY('local'))).toBeUndefined();
    });

    test('pointing an endpoint at another origin without a new key drops the stored key', async () => {
      const { service, secrets } = await setup();
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );

      const moved = await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://elsewhere.example/v1' })),
      );

      expect(hasApiKey(moved, 'local')).toBe(false);
      expect(await secrets.get(KEY('local'))).toBeUndefined();
    });

    test.each([
      ['another host', 'https://other.example/v1'],
      ['another port', 'https://llm.example:8443/v1'],
      ['another scheme', 'http://llm.example/v1'],
      ['a look-alike host', 'https://llm.example.evil.test/v1'],
    ])('%s is another origin', async (_, baseUrl) => {
      const { service, secrets } = await setup();
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );

      await service.update(withEndpoints(endpoint('local', { baseUrl })));

      expect(await secrets.get(KEY('local'))).toBeUndefined();
    });

    test.each([
      ['another path', 'https://llm.example/openai/v1'],
      ['the default port spelled out', 'https://llm.example:443/v1'],
      ['another letter case', 'HTTPS://LLM.EXAMPLE/v1'],
    ])('%s on the same origin keeps the key', async (_, baseUrl) => {
      const { service, secrets } = await setup();
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );

      const updated = await service.update(withEndpoints(endpoint('local', { baseUrl })));

      expect(hasApiKey(updated, 'local')).toBe(true);
      expect(await secrets.get(KEY('local'))).toBe('sk-one');
    });

    test('a key sent together with the new origin is stored for it', async () => {
      const { service, secrets } = await setup();
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );

      const moved = await service.update(
        withEndpoints(
          endpoint('local', { baseUrl: 'https://elsewhere.example/v1', apiKey: 'sk-two' }),
        ),
      );

      expect(hasApiKey(moved, 'local')).toBe(true);
      expect(await secrets.get(KEY('local'))).toBe('sk-two');
    });

    test('the key is gone before the new origin is saved, and no subscriber sees both', async () => {
      const inner = createFakeStorage();
      const secrets = createFakeSecretStore();
      const keyWhenSaved: (string | undefined)[] = [];
      const storage: Storage = {
        ...inner,
        settings: {
          load: () => inner.settings.load(),
          save: async (document) => {
            keyWhenSaved.push(await secrets.get(KEY('local')));
            await inner.settings.save(document);
          },
        },
      };
      const { service } = await setup({ storage, secrets });
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );
      const seen: Settings[] = [];
      service.subscribe((settings) => seen.push(settings));

      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://elsewhere.example/v1' })),
      );

      expect(keyWhenSaved.at(-1)).toBeUndefined();
      expect(seen.map((settings) => hasApiKey(settings, 'local'))).toEqual([false]);
    });

    test('when the key of a moved endpoint cannot be deleted, the endpoint does not move', async () => {
      const inner = createFakeSecretStore();
      const secrets: SecretStore = {
        get: (key) => inner.get(key),
        set: (key, value) => inner.set(key, value),
        delete: async () => {
          throw new Error('cannot write secrets');
        },
      };
      const { service, storage } = await setup({ secrets });
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );
      const before = service.get();

      await expect(
        service.update(
          withEndpoints(endpoint('local', { baseUrl: 'https://elsewhere.example/v1' })),
        ),
      ).rejects.toThrow('cannot write secrets');

      expect(service.get()).toEqual(before);
      expect(JSON.stringify(await storage.settings.load())).not.toContain('elsewhere.example');
    });

    test('when the moved endpoint cannot be saved, its key is put back', async () => {
      const inner = createFakeStorage();
      let failing = false;
      const storage: Storage = {
        ...inner,
        settings: {
          load: () => inner.settings.load(),
          save: async (document) => {
            if (failing) throw new Error('disk full');
            await inner.settings.save(document);
          },
        },
      };
      const { service, secrets } = await setup({ storage });
      await service.update(
        withEndpoints(endpoint('local', { baseUrl: 'https://llm.example/v1', apiKey: 'sk-one' })),
      );
      const before = service.get();

      failing = true;
      await expect(
        service.update(
          withEndpoints(endpoint('local', { baseUrl: 'https://elsewhere.example/v1' })),
        ),
      ).rejects.toThrow('disk full');

      expect(service.get()).toEqual(before);
      expect(await secrets.get(KEY('local'))).toBe('sk-one');
    });

    test('keys of several endpoints are kept apart', async () => {
      const { service, secrets } = await setup();

      const updated = await service.update(
        withEndpoints(endpoint('one', { apiKey: 'sk-one' }), endpoint('two')),
      );

      expect([hasApiKey(updated, 'one'), hasApiKey(updated, 'two')]).toEqual([true, false]);
      expect(await secrets.get(KEY('two'))).toBeUndefined();
    });
  });

  describe('keys supplied by the environment', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'settings-service-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const fileSecrets = (env: NodeJS.ProcessEnv) =>
      createFileSecretStore({ file: join(dir, 'secrets.json'), env });
    const fromEnv = { [secretEnvName(KEY('managed'))]: 'sk-from-env' };

    test('such an endpoint reports a key without one being stored', async () => {
      const { service } = await setup({ secrets: fileSecrets(fromEnv) });

      const updated = await service.update(withEndpoints(endpoint('managed')));

      expect(hasApiKey(updated, 'managed')).toBe(true);
      expect(await fileSecrets({}).get(KEY('managed'))).toBeUndefined();
    });

    test('sending a key for it is a conflict that changes nothing at all', async () => {
      const { service, storage } = await setup({ secrets: fileSecrets(fromEnv) });
      await service.update(withEndpoints(endpoint('other', { apiKey: 'sk-before' })));
      const before = service.get();
      const notified: Settings[] = [];
      service.subscribe((settings) => notified.push(settings));

      const error = await rejection(
        service.update({
          language: 'zh-TW',
          ...withEndpoints(
            endpoint('other', { apiKey: 'sk-replaced' }),
            endpoint('fresh', { apiKey: 'sk-fresh' }),
            endpoint('managed', { apiKey: 'sk-refused' }),
          ),
        }),
      );

      expect(error).toMatchObject({ name: 'AppError', code: 'conflict' });
      expect((error as Error).message).not.toMatch(/sk-/);
      expect(service.get()).toEqual(before);
      expect(notified).toEqual([]);
      expect(JSON.stringify(await storage.settings.load())).not.toContain('managed');
      // The keys this update had already written are back to what they were.
      expect(await fileSecrets({}).get(KEY('other'))).toBe('sk-before');
      expect(await fileSecrets({}).get(KEY('fresh'))).toBeUndefined();
    });

    test('clearing its key is accepted and the environment still supplies one', async () => {
      const { service } = await setup({ secrets: fileSecrets(fromEnv) });
      await service.update(withEndpoints(endpoint('managed')));

      const updated = await service.update(withEndpoints(endpoint('managed', { apiKey: null })));

      expect(hasApiKey(updated, 'managed')).toBe(true);
    });
  });

  describe('failures while saving', () => {
    test('when the document cannot be saved, the keys are put back and nothing changes', async () => {
      const inner = createFakeStorage();
      let failing = false;
      const storage: Storage = {
        ...inner,
        settings: {
          load: () => inner.settings.load(),
          save: async (document) => {
            if (failing) throw new Error('disk full');
            await inner.settings.save(document);
          },
        },
      };
      const { service, secrets } = await setup({ storage });
      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-before' })));
      const before = service.get();
      const notified: Settings[] = [];
      service.subscribe((settings) => notified.push(settings));

      failing = true;
      await expect(
        service.update({
          language: 'zh-TW',
          ...withEndpoints(
            endpoint('local', { apiKey: 'sk-after' }),
            endpoint('new', { apiKey: 'sk-new' }),
          ),
        }),
      ).rejects.toThrow('disk full');

      expect(service.get()).toEqual(before);
      expect(await secrets.get(KEY('local'))).toBe('sk-before');
      expect(await secrets.get(KEY('new'))).toBeUndefined();
      expect(notified).toEqual([]);

      failing = false;
      expect((await service.update({ language: 'zh-TW' })).language).toBe('zh-TW');
    });

    test('when deleting a key fails, the saved settings still say that the key exists', async () => {
      const inner = createFakeSecretStore();
      const secrets: SecretStore = {
        get: (key) => inner.get(key),
        set: (key, value) => inner.set(key, value),
        delete: async () => {
          throw new Error('cannot write secrets');
        },
      };
      const { service } = await setup({ secrets });
      await service.update(withEndpoints(endpoint('local', { apiKey: 'sk-stuck' })));

      await expect(
        service.update(withEndpoints(endpoint('local', { apiKey: null, label: 'Renamed' }))),
      ).rejects.toThrow('cannot write secrets');

      const provider = service.get().providers.find((candidate) => candidate.id === 'local');
      expect(provider).toMatchObject({ label: 'Renamed', hasApiKey: true });
    });
  });

  test('updates made at the same time are applied one after the other, losing none', async () => {
    const { service } = await setup();

    const results = await Promise.all([
      service.update({ limits: { maxAsksInFlight: 2 } }),
      service.update({ limits: { maxQueuedSlots: 3 } }),
      service.update({ layout: { columns: 7 } }),
      service.update(withEndpoints(endpoint('local', { apiKey: 'sk-one' }))),
    ]);

    expect(results.at(-1)).toEqual(service.get());
    expect(service.get().limits).toMatchObject({ maxAsksInFlight: 2, maxQueuedSlots: 3 });
    expect(service.get().layout.columns).toBe(7);
    expect(hasApiKey(service.get(), 'local')).toBe(true);
  });

  test('a failed update does not block the ones after it', async () => {
    const { service } = await setup();

    const [failed, succeeded] = await Promise.allSettled([
      service.update({ limits: { maxAsksInFlight: 0 } }),
      service.update({ limits: { maxAsksInFlight: 3 } }),
    ]);

    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
    expect(service.get().limits.maxAsksInFlight).toBe(3);
  });
});

describe('subscribe', () => {
  test('subscribers get the new settings after every successful update', async () => {
    const { service } = await setup();
    const seen: Settings[] = [];
    service.subscribe((settings) => seen.push(settings));

    const first = await service.update({ language: 'zh-TW' });
    const second = await service.update({ updateCheck: false });

    expect(seen).toEqual([first, second]);
  });

  test('a subscriber is notified once the new settings are readable', async () => {
    const { service } = await setup();
    const readDuringCallback: string[] = [];
    service.subscribe(() => readDuringCallback.push(service.get().language));

    await service.update({ language: 'zh-TW' });

    expect(readDuringCallback).toEqual(['zh-TW']);
  });

  test('unsubscribing stops the notifications, for that subscriber only', async () => {
    const { service } = await setup();
    const first: Settings[] = [];
    const second: Settings[] = [];
    const unsubscribe = service.subscribe((settings) => first.push(settings));
    service.subscribe((settings) => second.push(settings));

    await service.update({ language: 'zh-TW' });
    unsubscribe();
    unsubscribe();
    await service.update({ language: 'en' });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  test('a subscriber cannot change the settings through what it is given', async () => {
    const { service } = await setup();
    service.subscribe((settings) => {
      settings.language = 'en';
      settings.providers.length = 0;
    });
    const seen: Settings[] = [];
    service.subscribe((settings) => seen.push(settings));

    await service.update({ language: 'zh-TW' });

    expect(service.get().language).toBe('zh-TW');
    expect(seen[0]?.providers).toHaveLength(CLI_PROVIDER_KINDS.length);
  });

  test('a throwing subscriber neither fails the update nor starves the others, and is logged', async () => {
    const { service, logger } = await setup();
    const seen: Settings[] = [];
    service.subscribe(() => {
      throw new TypeError('subscriber bug with sk-secret-looking text');
    });
    service.subscribe((settings) => seen.push(settings));

    const updated = await service.update({ language: 'zh-TW' });

    expect(updated.language).toBe('zh-TW');
    expect(seen).toEqual([updated]);
    expect(logger.entries).toEqual([
      { level: 'error', message: 'settings subscriber failed', fields: { error: 'TypeError' } },
    ]);
  });
});
