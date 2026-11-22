import { describe, expect, test } from 'vitest';
import { createMemoryLogger, FakeClock } from '../../testing/index.ts';
import { cliInstance } from '../test-harness.ts';
import type { CliContext } from './run-cli.ts';
import {
  billingReport,
  childEnvFor,
  cliSwitches,
  extractVersion,
  isEffortArgument,
  isModelArgument,
  joinHints,
  rejectedSelection,
  tokenCount,
} from './support.ts';

const context = (env: NodeJS.ProcessEnv): CliContext => ({
  env,
  platform: 'linux',
  clock: new FakeClock(),
  logger: createMemoryLogger(),
  shutdownSignal: new AbortController().signal,
});

describe('argument checks', () => {
  test.each(['sonnet', 'gpt-5.5', 'claude-opus-4-8[1m]', 'vendor/model:free', 'm@2026-01-01', 'a'])(
    'accepts the model id %s',
    (id) => {
      expect(isModelArgument(id)).toBe(true);
    },
  );

  test.each([
    '',
    '-m',
    '--dangerously-skip-permissions',
    'two words',
    'a\nb',
    'x'.repeat(201),
    '$(id)',
    'a;b',
  ])('refuses %j as a model id', (id) => {
    expect(isModelArgument(id)).toBe(false);
  });

  test('effort names are plain words', () => {
    expect(['low', 'xhigh', 'very_high', 'max-2'].every(isEffortArgument)).toBe(true);
    expect(['', '-x', 'a b', 'high"\nfoo="1', 'x'.repeat(65)].some(isEffortArgument)).toBe(false);
  });

  test('rejectedSelection lets a valid or absent selection through', () => {
    expect(rejectedSelection({}, 'token')).toBeUndefined();
    expect(rejectedSelection({ model: 'sonnet', effort: 'high' }, 'token')).toBeUndefined();
  });

  test('rejectedSelection refuses an option-like model without starting anything', () => {
    expect(rejectedSelection({ model: '--yolo' }, 'block')).toEqual([
      { type: 'start', streaming: 'block' },
      { type: 'error', code: 'model_not_found', message: expect.any(String) as string },
    ]);
  });

  test('rejectedSelection refuses an effort that is not a plain word', () => {
    expect(rejectedSelection({ model: 'ok', effort: 'high" x="1' }, 'token')?.[1]).toMatchObject({
      type: 'error',
      code: 'unsupported',
    });
  });
});

describe('extractVersion', () => {
  test.each([
    ['2.1.330 (Claude Code)', '2.1.330'],
    ['codex-cli 0.167.0', '0.167.0'],
    ['grok 1.0.92-beta.1+build5\n', '1.0.92-beta.1+build5'],
    ['v3.4', '3.4'],
  ])('finds the version in %j', (output, version) => {
    expect(extractVersion(output)).toBe(version);
  });

  test('returns undefined when there is none, and bounds the length', () => {
    expect(extractVersion('no version here')).toBeUndefined();
    expect(extractVersion(`1.2.3-${'a'.repeat(200)}`)).toHaveLength(64);
  });
});

describe('billingReport', () => {
  const relevant = (name: string): boolean => name === 'OPENAI_API_KEY';

  test('without a relevant variable the login decides and there is no hint', () => {
    const report = billingReport(
      context({ ANTHROPIC_API_KEY: 'x' }),
      cliInstance('codex'),
      relevant,
      'subscription',
    );

    expect(report).toEqual({ billing: 'subscription' });
  });

  test('a variable that is not passed on is named, and the login still decides', () => {
    const report = billingReport(
      context({ OPENAI_API_KEY: 'sk-secret-value' }),
      cliInstance('codex'),
      relevant,
      'subscription',
    );

    expect(report.billing).toBe('subscription');
    expect(report.hint).toContain('Not passed to the CLI: OPENAI_API_KEY.');
    expect(report.hint).not.toContain('sk-secret-value');
  });

  test.each(['api-key', 'unknown'] as const)(
    'a kept variable makes the billing source the API key when the CLI reports %s',
    (fromLogin) => {
      const report = billingReport(
        context({ OPENAI_API_KEY: 'sk-secret-value' }),
        cliInstance('codex', { useEnvApiKey: true }),
        relevant,
        fromLogin,
      );

      expect(report).toEqual({
        billing: 'api-key',
        hint: 'Passed to the CLI from the environment: OPENAI_API_KEY.',
      });
    },
  );

  test("the CLI's own status wins over a kept variable when it still reports its login", () => {
    const report = billingReport(
      context({ OPENAI_API_KEY: 'sk-secret-value' }),
      cliInstance('codex', { useEnvApiKey: true }),
      relevant,
      'subscription',
    );

    expect(report).toEqual({
      billing: 'subscription',
      hint: 'Passed to the CLI from the environment: OPENAI_API_KEY. The CLI still reports its own login as the one in use.',
    });
  });
});

describe('childEnvFor', () => {
  test('follows the instance switch and adds the adapter variables', () => {
    const base = context({ PATH: '/bin', OPENAI_API_KEY: 'x', CLAUDECODE: '1' });

    expect(childEnvFor(base, cliInstance('codex'), { EXTRA: '1' })).toEqual({
      PATH: '/bin',
      NO_COLOR: '1',
      TERM: 'dumb',
      EXTRA: '1',
    });
    expect(childEnvFor(base, cliInstance('codex', { useEnvApiKey: true }))).toMatchObject({
      OPENAI_API_KEY: 'x',
    });
  });
});

describe('cliSwitches', () => {
  test('web search is on only for an instance that asks for it and whose tool has the switch', () => {
    expect(cliSwitches(cliInstance('claude')).webSearch).toBe(false);
    expect(cliSwitches(cliInstance('claude', { webSearch: true })).webSearch).toBe(true);
    expect(cliSwitches(cliInstance('codex', { webSearch: true })).webSearch).toBe(true);
    // Not a state the settings accept; an adapter must still never act on it.
    expect(cliSwitches(cliInstance('grok', { webSearch: true })).webSearch).toBe(false);
    expect(cliSwitches(cliInstance('agy', { webSearch: true })).webSearch).toBe(false);
    expect(
      cliSwitches({
        id: 'local',
        kind: 'openai-compat',
        label: 'Local',
        enabled: true,
        concurrency: 1,
        models: [],
        baseUrl: 'http://127.0.0.1:4000',
        hasApiKey: false,
      }),
    ).toEqual({ useEnvApiKey: false, riskAcknowledged: false, webSearch: false });
  });
});

describe('small helpers', () => {
  test('joinHints joins what exists and respects the protocol limit', () => {
    expect(joinHints(undefined, '')).toEqual({});
    expect(joinHints('One.', undefined, 'Two.')).toEqual({ hint: 'One. Two.' });
    expect(joinHints('x'.repeat(600)).hint).toHaveLength(500);
  });

  test('tokenCount accepts non-negative finite numbers only', () => {
    expect([12, 0, 3.6].map(tokenCount)).toEqual([12, 0, 4]);
    expect([-1, Number.NaN, Infinity, '12', null, undefined].map(tokenCount)).toEqual(
      Array.from({ length: 6 }, () => undefined),
    );
  });
});
