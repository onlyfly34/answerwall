import { describe, expect, test } from 'vitest';
import {
  createDefaultSettings,
  DEFAULT_LIMITS,
  LIMIT_SPECS,
  LimitsSchema,
  ProviderInstanceInputSchema,
  ProviderInstanceSchema,
  SettingsPatchSchema,
  SettingsSchema,
} from './index.ts';
import type { CliProviderInstance, OpenAiCompatInstance } from './index.ts';

const agy: CliProviderInstance = {
  id: 'agy',
  kind: 'agy',
  label: 'Gemini (agy)',
  enabled: true,
  concurrency: 1,
  models: [],
  useEnvApiKey: false,
  riskAcknowledged: true,
};

const endpoint: OpenAiCompatInstance = {
  id: 'local',
  kind: 'openai-compat',
  label: 'Local',
  enabled: true,
  concurrency: 4,
  models: ['some-model'],
  baseUrl: 'http://127.0.0.1:4000/v1',
  hasApiKey: false,
};

const issues = (value: unknown) =>
  ProviderInstanceSchema.safeParse(value).error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('default settings', () => {
  test('are valid, with agy disabled and every limit at its documented default', () => {
    const settings = createDefaultSettings();
    expect(SettingsSchema.parse(settings)).toEqual(settings);
    expect(settings.providers.map((p) => [p.id, p.enabled, p.concurrency])).toEqual([
      ['claude', true, 2],
      ['codex', true, 2],
      ['agy', false, 1],
      ['grok', true, 2],
    ]);
    expect(settings.limits).toMatchObject({
      maxTargetsPerAsk: 32,
      maxRequestBodyBytes: 1024 * 1024,
      maxPromptBytes: 200 * 1024,
      maxAsksInFlight: 4,
      maxQueuedSlots: 64,
      maxOutputBytesPerSlot: 2 * 1024 * 1024,
      historyMaxAsks: 1000,
      historyMaxBytes: 500 * 1024 * 1024,
      authFailuresPerMinute: 10,
      slotTimeoutMs: 300_000,
    });
  });
});

describe('provider list', () => {
  test('a CLI provider can be disabled but not removed; endpoints come and go', () => {
    const settings = createDefaultSettings();
    const withEndpoint = { ...settings, providers: [...settings.providers, endpoint] };
    const withoutGrok = {
      ...settings,
      providers: settings.providers.filter((p) => p.id !== 'grok'),
    };

    expect(SettingsSchema.safeParse(withEndpoint).success).toBe(true);
    expect(SettingsSchema.safeParse(withoutGrok).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ providers: withoutGrok.providers }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ language: 'zh-TW' }).success).toBe(true);
  });
});

describe('limits', () => {
  test('hard maxima cannot be exceeded', () => {
    expect(LIMIT_SPECS.maxTargetsPerAsk.max).toBe(64);
    expect(LIMIT_SPECS.maxAsksInFlight.max).toBe(16);
    expect(LIMIT_SPECS.maxQueuedSlots.max).toBe(256);
    expect(LimitsSchema.safeParse({ ...DEFAULT_LIMITS, maxTargetsPerAsk: 65 }).success).toBe(false);
  });

  test('the prompt limit must fit inside the request body limit', () => {
    const limits = { ...DEFAULT_LIMITS, maxPromptBytes: DEFAULT_LIMITS.maxRequestBodyBytes };
    expect(LimitsSchema.safeParse(limits).success).toBe(false);
  });
});

describe('provider instances', () => {
  test('agy runs one request at a time and needs its notice acknowledged to be enabled', () => {
    expect(issues(agy)).toEqual([]);
    expect(issues({ ...agy, concurrency: 2 })).toEqual(['concurrency']);
    expect(issues({ ...agy, riskAcknowledged: false })).toEqual(['riskAcknowledged']);
    expect(issues({ ...agy, riskAcknowledged: false, enabled: false })).toEqual([]);
  });

  test('concurrency is bounded per kind', () => {
    expect(issues({ ...agy, id: 'claude', kind: 'claude', concurrency: 5 })).toEqual([]);
    expect(issues({ ...agy, id: 'claude', kind: 'claude', concurrency: 6 })).toEqual([
      'concurrency',
    ]);
    expect(issues({ ...endpoint, concurrency: 32 })).toEqual([]);
    expect(issues({ ...endpoint, concurrency: 33 })).toEqual(['concurrency']);
  });

  test('CLI kinds own their id', () => {
    expect(issues({ ...agy, id: 'gemini' })).toEqual(['id']);
    expect(issues({ ...endpoint, id: 'claude' })).toEqual(['id']);
  });

  test('an endpoint must be an http(s) URL', () => {
    expect(issues({ ...endpoint, baseUrl: 'file:///etc/passwd' })).toEqual(['baseUrl']);
  });

  test.each([
    'http://user:sk-secret@127.0.0.1:4000/v1',
    'http://sk-secret@127.0.0.1:4000/v1',
    'http://127.0.0.1:4000/v1?api_key=sk-secret',
    'http://127.0.0.1:4000/v1#sk-secret',
  ])('an endpoint address carries no credential: %s', (baseUrl) => {
    expect(issues({ ...endpoint, baseUrl })).toEqual(['baseUrl']);
    const result = ProviderInstanceInputSchema.safeParse({ ...endpoint, baseUrl });
    expect(JSON.stringify(result.error?.issues)).not.toContain('sk-secret');
  });

  test('the API key is accepted on input and is not part of the stored shape', () => {
    const input = ProviderInstanceInputSchema.parse({ ...endpoint, apiKey: 'sk-secret' });
    expect(input).toMatchObject({ apiKey: 'sk-secret' });
    expect(ProviderInstanceSchema.parse({ ...endpoint, apiKey: 'sk-secret' })).not.toHaveProperty(
      'apiKey',
    );
  });
});
