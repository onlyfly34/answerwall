import { describe, expect, test } from 'vitest';
import { createDefaultSettings, ProviderIdSchema } from '@answerwall/core/protocol';
import type { OpenAiCompatInstance, ProviderInstanceInput } from '@answerwall/core/protocol';
import {
  addModel,
  removeModel,
  setDefaultModel,
  slugify,
  toInput,
  withoutProvider,
  withProvider,
} from './provider-edits.ts';

const endpoint: OpenAiCompatInstance = {
  id: 'lab',
  kind: 'openai-compat',
  label: 'Lab',
  enabled: true,
  concurrency: 4,
  models: [],
  baseUrl: 'http://lab.example',
  hasApiKey: true,
};
const providers = [...createDefaultSettings().providers, endpoint];

describe('provider list edits', () => {
  test('the writable form of an endpoint carries no key and no key flag', () => {
    expect(toInput(endpoint)).toEqual({
      id: 'lab',
      kind: 'openai-compat',
      label: 'Lab',
      enabled: true,
      concurrency: 4,
      models: [],
      baseUrl: 'http://lab.example',
    });
    expect(toInput(providers[0]!)).toBe(providers[0]);
  });

  test('replacing keeps the order; an unknown id is appended', () => {
    const changed: ProviderInstanceInput = { ...providers[1]!, enabled: false };
    expect(withProvider(providers, changed).map((p) => [p.id, p.enabled])).toEqual([
      ['claude', true],
      ['codex', false],
      ['agy', false],
      ['grok', true],
      ['opencode', false],
      ['lab', true],
    ]);

    const added: ProviderInstanceInput = {
      id: 'new',
      kind: 'openai-compat',
      label: 'New',
      enabled: true,
      concurrency: 4,
      models: [],
      baseUrl: 'http://new.example',
      apiKey: 'k',
    };
    const list = withProvider(providers, added);
    expect(list.map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'opencode',
      'lab',
      'new',
    ]);
    expect(list[5]).not.toHaveProperty('hasApiKey');
    expect(list[6]).toMatchObject({ apiKey: 'k' });
  });

  test('removing drops only that provider', () => {
    expect(withoutProvider(providers, 'lab').map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'agy',
      'grok',
      'opencode',
    ]);
  });

  test('models are added once, trimmed', () => {
    const input = toInput(providers[0]!);
    expect(addModel(input, ' new ').models.at(-1)).toBe('new');
    expect(addModel(input, 'opus')).toBe(input);
    expect(addModel(input, '  ')).toBe(input);
  });

  test('removing the default model clears the default; removing another keeps it', () => {
    const input = setDefaultModel(toInput(providers[0]!), 'opus');
    expect(input.defaultModel).toBe('opus');
    expect(removeModel(input, 'haiku')).toMatchObject({ defaultModel: 'opus' });
    const cleared = removeModel(input, 'opus');
    expect(cleared.models).toEqual(['fable', 'sonnet', 'haiku']);
    expect('defaultModel' in cleared).toBe(false);
    expect('defaultModel' in setDefaultModel(input, undefined)).toBe(false);
  });

  test.each([
    ['My LiteLLM (home)', 'my-litellm-home'],
    ['  --Ollama--  ', 'ollama'],
    ['本機 LLM 2', 'llm-2'],
    ['x'.repeat(40), 'x'.repeat(32)],
    [`${'a'.repeat(31)} b`, 'a'.repeat(31)],
  ])('slugify(%j) is %j, a valid provider id', (label, slug) => {
    expect(slugify(label)).toBe(slug);
    expect(ProviderIdSchema.safeParse(slug).success).toBe(true);
  });

  test('a label without usable characters gives an empty id, which the form then refuses', () => {
    expect(slugify('本機')).toBe('');
  });
});
