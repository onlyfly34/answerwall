import { describe, expect, test } from 'vitest';
import {
  CLI_PROVIDER_KINDS,
  createDefaultSettings,
  DEFAULT_LAYOUT,
  DEFAULT_LIMITS,
  LIMIT_SPECS,
  MAX_PROVIDER_INSTANCES,
  SettingsSchema,
} from '../protocol/index.ts';
import type { LimitName } from '../protocol/index.ts';
import { repairSettings } from './repair.ts';
import type { StoredProvider, StoredSettings } from './repair.ts';

const defaults = (): StoredSettings => createDefaultSettings();

const endpoint = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'openai-compat',
  label: `Endpoint ${id}`,
  enabled: true,
  concurrency: 4,
  models: ['some-model'],
  baseUrl: 'http://127.0.0.1:4000/v1',
  ...overrides,
});

/** The repaired document in the API's shape must always pass the protocol schema. */
const expectValid = (repaired: StoredSettings): void => {
  const result = SettingsSchema.safeParse({
    ...repaired,
    providers: repaired.providers.map((provider) =>
      provider.kind === 'openai-compat' ? { ...provider, hasApiKey: false } : provider,
    ),
  });
  expect(result.error?.issues ?? []).toEqual([]);
};

const provider = (repaired: StoredSettings, id: string): StoredProvider | undefined =>
  repaired.providers.find((candidate) => candidate.id === id);

describe('repairSettings', () => {
  test('a valid document comes back unchanged', () => {
    const document: StoredSettings = {
      ...defaults(),
      language: 'zh-TW',
      updateCheck: false,
      limits: { ...DEFAULT_LIMITS, maxTargetsPerAsk: 64, historyMaxAsks: 5 },
      layout: { mode: 'fixed', minCellWidth: 500, columns: 4 },
      providers: [
        ...defaults().providers.map((p) =>
          p.id === 'claude' ? { ...p, defaultModel: 'opus', concurrency: 5 } : p,
        ),
        endpoint('local', { defaultModel: 'some-model' }) as StoredProvider,
      ],
    };

    expect(repairSettings(structuredClone(document))).toEqual(document);
  });

  test.each([undefined, null, 'text', 42, [], true])(
    'a document that is not an object (%j) becomes the defaults',
    (document) => {
      expect(repairSettings(document)).toEqual(defaults());
    },
  );

  test('an empty object becomes the defaults', () => {
    expect(repairSettings({})).toEqual(defaults());
  });

  test('each invalid top-level value falls back alone; the valid ones are kept', () => {
    const repaired = repairSettings({
      language: 'klingon',
      updateCheck: 'yes',
      limits: 'none',
      layout: { mode: 'fixed', minCellWidth: 10, columns: 2 },
      providers: defaults().providers,
    });

    expect(repaired).toEqual({
      ...defaults(),
      layout: { mode: 'fixed', minCellWidth: DEFAULT_LAYOUT.minCellWidth, columns: 2 },
    });
  });

  test('unknown keys from another version are dropped', () => {
    const repaired = repairSettings({ ...defaults(), futureFeature: { on: true } });

    expect(repaired).toEqual(defaults());
  });

  describe('limits', () => {
    test.each(Object.keys(LIMIT_SPECS) as LimitName[])(
      '%s above its hard maximum is pulled down to it, below its minimum up to it',
      (name) => {
        const spec = LIMIT_SPECS[name];
        // The pair of byte limits is checked against each other below.
        const others = { maxPromptBytes: LIMIT_SPECS.maxPromptBytes.min };

        const high = repairSettings({ limits: { ...others, [name]: spec.max + 1 } });
        const low = repairSettings({ limits: { ...others, [name]: spec.min - 1 } });

        if (name !== 'maxPromptBytes') {
          expect(high.limits[name]).toBe(spec.max);
          expect(low.limits[name]).toBe(spec.min);
        }
        expectValid(high);
        expectValid(low);
      },
    );

    test('a missing or non-numeric limit takes its default', () => {
      const repaired = repairSettings({
        limits: { maxTargetsPerAsk: '12', maxAsksInFlight: null, maxQueuedSlots: Number.NaN },
      });

      expect(repaired.limits).toEqual(DEFAULT_LIMITS);
    });

    test('a fractional limit is truncated', () => {
      expect(repairSettings({ limits: { maxAsksInFlight: 3.9 } }).limits.maxAsksInFlight).toBe(3);
    });

    test('a prompt limit that is not below the body limit resets both', () => {
      const repaired = repairSettings({
        limits: { maxPromptBytes: 4 * 1024 * 1024, maxRequestBodyBytes: 1024 * 1024 },
      });

      expect(repaired.limits.maxPromptBytes).toBe(DEFAULT_LIMITS.maxPromptBytes);
      expect(repaired.limits.maxRequestBodyBytes).toBe(DEFAULT_LIMITS.maxRequestBodyBytes);
      expectValid(repaired);
    });

    test('valid custom limits are kept', () => {
      const limits = { ...DEFAULT_LIMITS, maxAsksInFlight: 16, slotTimeoutMs: 5000 };

      expect(repairSettings({ limits }).limits).toEqual(limits);
    });
  });

  describe('CLI providers', () => {
    test.each(CLI_PROVIDER_KINDS)(
      'a document missing %s gets it back with its defaults',
      (kind) => {
        const without = defaults().providers.filter((p) => p.id !== kind);

        const repaired = repairSettings({ ...defaults(), providers: without });

        expect(provider(repaired, kind)).toEqual(provider(defaults(), kind));
        expect(repaired.providers.map((p) => p.id).sort()).toEqual([...CLI_PROVIDER_KINDS].sort());
        expectValid(repaired);
      },
    );

    test('a document written before the web search switch existed reads as off', () => {
      const old = defaults().providers.map((stored) => {
        const fields: Record<string, unknown> = { ...stored };
        delete fields.webSearch;
        return fields;
      });

      const repaired = repairSettings({ ...defaults(), providers: old });

      expect(repaired.providers).toEqual(defaults().providers);
      expect(repaired.providers.every((p) => 'webSearch' in p && p.webSearch === false)).toBe(true);
      expectValid(repaired);
    });

    test('a stored web search switch is kept where the tool has one and dropped elsewhere', () => {
      const stored = defaults().providers.map((p) => ({ ...p, webSearch: true }));

      const repaired = repairSettings({ ...defaults(), providers: stored });

      expect(repaired.providers.map((p) => [p.id, 'webSearch' in p && p.webSearch])).toEqual([
        ['claude', true],
        ['codex', true],
        ['agy', false],
        ['grok', false],
        ['opencode', false],
      ]);
      expect(
        provider(repairSettings({ providers: [{ id: 'claude', webSearch: 'yes' }] }), 'claude'),
      ).toMatchObject({ webSearch: false });
      expectValid(repaired);
    });

    test('providers that are not a list give every CLI provider its defaults', () => {
      expect(repairSettings({ providers: { claude: {} } }).providers).toEqual(defaults().providers);
    });

    test('the stored order is kept and a restored provider is appended', () => {
      const repaired = repairSettings({
        providers: [
          endpoint('local'),
          { id: 'grok', kind: 'grok' },
          { id: 'claude', kind: 'claude' },
        ],
      });

      expect(repaired.providers.map((p) => p.id)).toEqual([
        'local',
        'grok',
        'claude',
        'codex',
        'agy',
        'opencode',
      ]);
    });

    test('valid fields of a partly damaged provider are kept', () => {
      const repaired = repairSettings({
        providers: [
          {
            id: 'codex',
            kind: 'codex',
            label: '  My Codex  ',
            enabled: false,
            concurrency: 'many',
            models: ['gpt-x', '', 7, '  spaced  '],
            defaultModel: 'gpt-x',
            useEnvApiKey: true,
            riskAcknowledged: 'no',
          },
        ],
      });

      expect(provider(repaired, 'codex')).toEqual({
        id: 'codex',
        kind: 'codex',
        label: 'My Codex',
        enabled: false,
        concurrency: 2,
        models: ['gpt-x', 'spaced'],
        defaultModel: 'gpt-x',
        useEnvApiKey: true,
        riskAcknowledged: false,
        webSearch: false,
      });
    });

    test('concurrency is pulled into the bounds of the kind', () => {
      const repaired = repairSettings({
        providers: [
          { id: 'claude', kind: 'claude', concurrency: 50 },
          { id: 'codex', kind: 'codex', concurrency: 0 },
          { id: 'agy', kind: 'agy', concurrency: 3 },
        ],
      });

      expect(provider(repaired, 'claude')?.concurrency).toBe(5);
      expect(provider(repaired, 'codex')?.concurrency).toBe(1);
      expect(provider(repaired, 'agy')?.concurrency).toBe(1);
    });

    test('agy stored as enabled without the acknowledgement is switched off', () => {
      const repaired = repairSettings({
        providers: [{ id: 'agy', kind: 'agy', enabled: true, riskAcknowledged: false }],
      });

      expect(provider(repaired, 'agy')).toMatchObject({ enabled: false, riskAcknowledged: false });
      expectValid(repaired);
    });

    test('agy enabled with the acknowledgement stays enabled', () => {
      const repaired = repairSettings({
        providers: [{ id: 'agy', kind: 'agy', enabled: true, riskAcknowledged: true }],
      });

      expect(provider(repaired, 'agy')).toMatchObject({ enabled: true, riskAcknowledged: true });
    });

    test('a CLI provider is recognised by its id when the kind is damaged, and the reverse', () => {
      const repaired = repairSettings({
        providers: [
          { id: 'claude', kind: 'nonsense', label: 'By id' },
          { id: 'renamed', kind: 'grok', label: 'By kind' },
        ],
      });

      expect(provider(repaired, 'claude')).toMatchObject({ kind: 'claude', label: 'By id' });
      expect(provider(repaired, 'grok')).toMatchObject({ id: 'grok', label: 'By kind' });
      expect(provider(repaired, 'renamed')).toBeUndefined();
    });

    test('of two entries for one CLI provider the first wins', () => {
      const repaired = repairSettings({
        providers: [
          { id: 'claude', kind: 'claude', label: 'First' },
          { id: 'claude', kind: 'claude', label: 'Second' },
        ],
      });

      expect(repaired.providers.filter((p) => p.id === 'claude')).toHaveLength(1);
      expect(provider(repaired, 'claude')?.label).toBe('First');
    });

    test('an invalid default model is dropped', () => {
      const repaired = repairSettings({
        providers: [{ id: 'claude', kind: 'claude', defaultModel: '   ' }],
      });

      expect(provider(repaired, 'claude')).not.toHaveProperty('defaultModel');
    });
  });

  describe('OpenAI-compatible endpoints', () => {
    test('a valid endpoint is kept, without any stored key flag', () => {
      const repaired = repairSettings({
        providers: [endpoint('local', { hasApiKey: true, apiKey: 'sk-leftover' })],
      });

      expect(provider(repaired, 'local')).toEqual(endpoint('local'));
      expect(JSON.stringify(repaired)).not.toContain('sk-leftover');
    });

    test('damaged optional fields fall back; the endpoint survives, disabled unless it says otherwise', () => {
      const repaired = repairSettings({
        providers: [
          {
            id: 'local',
            kind: 'openai-compat',
            baseUrl: 'https://llm.example/v1',
            concurrency: 99,
          },
        ],
      });

      expect(provider(repaired, 'local')).toEqual({
        id: 'local',
        kind: 'openai-compat',
        label: 'local',
        enabled: false,
        concurrency: 32,
        models: [],
        baseUrl: 'https://llm.example/v1',
      });
      expectValid(repaired);
    });

    test.each([
      ['an invalid id', endpoint('Not Valid!')],
      ['a missing URL', endpoint('local', { baseUrl: undefined })],
      ['a URL that is not http', endpoint('local', { baseUrl: 'ftp://files.example' })],
      ['an unknown kind', endpoint('local', { kind: 'telepathy' })],
      ['no kind', { id: 'local', baseUrl: 'http://127.0.0.1:1' }],
    ])('an endpoint with %s is dropped', (_, entry) => {
      const repaired = repairSettings({ providers: [entry] });

      expect(repaired.providers).toEqual(defaults().providers);
    });

    test.each([
      ['https://alice:s3cretpass@llm.example/v1', 'https://llm.example/v1'],
      ['https://token-abcdef@llm.example:8443/openai', 'https://llm.example:8443/openai'],
      ['https://llm.example/v1?api-key=sk-abcdef', 'https://llm.example/v1'],
      ['https://llm.example/v1#sk-abcdef', 'https://llm.example/v1'],
      ['http://u:p@127.0.0.1:4000?k=sk-abcdef#f', 'http://127.0.0.1:4000/'],
    ])('credentials, query and fragment are cut from the address %s', (baseUrl, cleaned) => {
      const repaired = repairSettings({
        ...defaults(),
        providers: [...defaults().providers, endpoint('local', { baseUrl })],
      });

      expect(provider(repaired, 'local')).toMatchObject({ baseUrl: cleaned });
      expectValid(repaired);
    });

    test.each(['http://127.0.0.1:4000', 'https://LLM.example/v1/', 'https://llm.example'])(
      'the clean address %s is kept as written',
      (baseUrl) => {
        const repaired = repairSettings({
          ...defaults(),
          providers: [...defaults().providers, endpoint('local', { baseUrl })],
        });

        expect(provider(repaired, 'local')).toMatchObject({ baseUrl });
      },
    );

    test('an endpoint cannot take the id of a CLI provider', () => {
      const repaired = repairSettings({
        providers: [{ ...endpoint('claude'), kind: 'openai-compat' }],
      });

      expect(provider(repaired, 'claude')?.kind).toBe('claude');
      expectValid(repaired);
    });

    test('of two endpoints with one id the first wins', () => {
      const repaired = repairSettings({
        providers: [endpoint('dup', { label: 'First' }), endpoint('dup', { label: 'Second' })],
      });

      expect(repaired.providers.filter((p) => p.id === 'dup')).toEqual([
        endpoint('dup', { label: 'First' }),
      ]);
    });

    test('entries that are not objects are skipped', () => {
      const repaired = repairSettings({ providers: [null, 'claude', 7, [], endpoint('ok')] });

      expect(repaired.providers.map((p) => p.id)).toEqual(['ok', ...CLI_PROVIDER_KINDS]);
    });

    test('more providers than allowed lose the last endpoints, never a CLI provider', () => {
      const many = Array.from({ length: MAX_PROVIDER_INSTANCES + 5 }, (_, n) => endpoint(`e${n}`));

      const repaired = repairSettings({ providers: many });

      expect(repaired.providers).toHaveLength(MAX_PROVIDER_INSTANCES);
      for (const kind of CLI_PROVIDER_KINDS) expect(provider(repaired, kind)).toBeDefined();
      expect(provider(repaired, 'e0')).toBeDefined();
      expect(
        provider(repaired, `e${MAX_PROVIDER_INSTANCES - CLI_PROVIDER_KINDS.length}`),
      ).toBeUndefined();
      expectValid(repaired);
    });

    test('a model list is cut to its maximum length', () => {
      const models = Array.from({ length: 250 }, (_, n) => `model-${n}`);

      const repaired = repairSettings({ providers: [endpoint('local', { models })] });

      expect(provider(repaired, 'local')?.models).toHaveLength(200);
      expectValid(repaired);
    });
  });

  test('whatever is stored, the result is a valid settings document', () => {
    const junk: unknown[] = [
      { providers: [{}, { kind: 'claude', models: 'x', label: 5, enabled: 'on' }] },
      { limits: { maxPromptBytes: 1e12, maxRequestBodyBytes: -5, slotTimeoutMs: Infinity } },
      { layout: [1, 2, 3], language: 5, updateCheck: null },
      {
        providers: [
          { id: 'agy', enabled: true },
          { id: 'agy', kind: 'openai-compat' },
        ],
      },
      {
        providers: [endpoint('a', { label: '', concurrency: -1, defaultModel: 3, models: [null] })],
      },
      { limits: { maxPromptBytes: 16 * 1024 * 1024, maxRequestBodyBytes: 16 * 1024 * 1024 } },
    ];

    for (const document of junk) expectValid(repairSettings(document));
  });
});
