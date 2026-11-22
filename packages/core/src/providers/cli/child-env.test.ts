import { describe, expect, test } from 'vitest';
import {
  buildChildEnv,
  hasVariable,
  isBillingVariable,
  presentBillingVariables,
} from './child-env.ts';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SSE_PORT: '1234',
  CLAUDE_EFFORT: 'high',
  CLAUDE_PID: '42',
  AI_AGENT: 'some-agent',
  CLAUDE_CONFIG_DIR: '/home/someone/.claude-alt',
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_API_KEY: 'a',
  ANTHROPIC_AUTH_TOKEN: 'b',
  ANTHROPIC_BASE_URL: 'https://proxy.invalid',
  CODEX_API_KEY: 'c',
  OPENAI_API_KEY: 'd',
  XAI_API_KEY: 'e',
  GEMINI_API_KEY: 'f',
  GOOGLE_API_KEY: 'g',
  GOOGLE_GENERATIVE_AI_API_KEY: 'h',
  OPENCODE_API_KEY: 'i',
  CODEX_HOME: '/home/someone/.codex',
  NO_COLOR: '0',
  TERM: 'xterm-256color',
  UNDEFINED_VALUE: undefined,
};

describe('buildChildEnv', () => {
  test('removes the nested-session and billing variables and keeps everything else', () => {
    const env = buildChildEnv(base, { keepApiKeys: false, platform: 'linux' });

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      CLAUDE_CONFIG_DIR: '/home/someone/.claude-alt',
      CODEX_HOME: '/home/someone/.codex',
      NO_COLOR: '1',
      TERM: 'dumb',
    });
  });

  test('keeps the billing variables when the provider uses the API key from the environment', () => {
    const env = buildChildEnv(base, { keepApiKeys: true, platform: 'linux' });

    expect(Object.keys(env).sort()).toEqual(
      [
        'PATH',
        'HOME',
        'CLAUDE_CONFIG_DIR',
        'CODEX_HOME',
        'CLAUDE_CODE_USE_BEDROCK',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CODEX_API_KEY',
        'OPENAI_API_KEY',
        'XAI_API_KEY',
        'GEMINI_API_KEY',
        'GOOGLE_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'OPENCODE_API_KEY',
        'NO_COLOR',
        'TERM',
      ].sort(),
    );
  });

  test('the nested-session variables are removed even when API keys are kept', () => {
    const env = buildChildEnv(base, { keepApiKeys: true, platform: 'linux' });

    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) {
      expect(env).not.toHaveProperty(name);
    }
    expect(env).not.toHaveProperty('CLAUDE_EFFORT');
    expect(env).not.toHaveProperty('CLAUDE_PID');
    expect(env).not.toHaveProperty('AI_AGENT');
  });

  test.each([false, true])(
    "never passes on the application's own settings and secrets (keepApiKeys %s)",
    (keepApiKeys) => {
      const env = buildChildEnv(
        {
          PATH: '/usr/bin',
          ANSWERWALL_TOKEN: 'static-token-0123456789',
          ANSWERWALL_SECRET_PROVIDER_EP1_API_KEY: 'sk-key',
          ANSWERWALL_SECRET_TLS_SERVER_KEY: 'PEM',
          ANSWERWALL_DATA_DIR: '/data',
        },
        { keepApiKeys, platform: 'linux' },
      );

      expect(env).toEqual({ PATH: '/usr/bin', NO_COLOR: '1', TERM: 'dumb' });
    },
  );

  test("the application's own variables are matched case-insensitively on Windows", () => {
    const env = buildChildEnv(
      { Path: 'C:\\bin', AnswerWall_Token: 'static-token-0123456789' },
      { keepApiKeys: true, platform: 'win32' },
    );

    expect(env).toEqual({ Path: 'C:\\bin', NO_COLOR: '1', TERM: 'dumb' });
  });

  test.each([false, true])(
    "the CLI's own login token always passes through (keepApiKeys %s)",
    (keepApiKeys) => {
      const env = buildChildEnv(
        {
          CLAUDE_CODE_OAUTH_TOKEN: 'oat',
          CLAUDE_CODE_SSE_PORT: '1',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
        },
        { keepApiKeys, platform: 'linux' },
      );

      expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', NO_COLOR: '1', TERM: 'dumb' });
    },
  );

  test('the login token passes under any spelling on Windows', () => {
    const env = buildChildEnv(
      { Claude_Code_OAuth_Token: 'oat', Claude_Code_Entrypoint: 'cli' },
      { keepApiKeys: false, platform: 'win32' },
    );

    expect(env).toEqual({ Claude_Code_OAuth_Token: 'oat', NO_COLOR: '1', TERM: 'dumb' });
  });

  test('settings of a cloud billing source travel with it', () => {
    const base = { CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1' };

    expect(buildChildEnv(base, { keepApiKeys: false, platform: 'linux' })).toEqual({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(buildChildEnv(base, { keepApiKeys: true, platform: 'linux' })).toMatchObject(base);
  });

  test('profile and federation credentials are billing variables', () => {
    const base = {
      ANTHROPIC_PROFILE: 'p',
      ANTHROPIC_FEDERATION_RULE_ID: 'r',
      ANTHROPIC_IDENTITY_TOKEN: 't',
      ANTHROPIC_IDENTITY_TOKEN_FILE: '/run/token',
    };

    expect(buildChildEnv(base, { keepApiKeys: false, platform: 'linux' })).toEqual({
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(buildChildEnv(base, { keepApiKeys: true, platform: 'linux' })).toMatchObject(base);
    expect(presentBillingVariables(base, 'linux', (name) => name.startsWith('ANTHROPIC_'))).toEqual(
      Object.keys(base).sort(),
    );
  });

  test('adapter variables are applied last and win over the user environment', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin', GROK_MEMORY: '1' },
      { keepApiKeys: false, platform: 'linux', extra: { GROK_MEMORY: '0' } },
    );

    expect(env.GROK_MEMORY).toBe('0');
  });

  test('treats names case-insensitively on Windows and leaves one spelling of an overridden variable', () => {
    const env = buildChildEnv(
      { Path: 'C:\\bin', ClaudeCode: '1', Openai_Api_Key: 'x', term: 'cygwin', No_Color: '' },
      { keepApiKeys: false, platform: 'win32' },
    );

    expect(env).toEqual({ Path: 'C:\\bin', NO_COLOR: '1', TERM: 'dumb' });
  });

  test('names differing only in case are different variables on POSIX', () => {
    const env = buildChildEnv(
      { claudecode: '1', openai_api_key: 'x' },
      { keepApiKeys: false, platform: 'linux' },
    );

    expect(env).toMatchObject({ claudecode: '1', openai_api_key: 'x' });
  });
});

describe('isBillingVariable', () => {
  test.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'XAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'OPENCODE_API_KEY',
  ])('%s switches billing', (name) => {
    expect(isBillingVariable(name)).toBe(true);
  });

  test.each(['PATH', 'CLAUDE_CODE_ENTRYPOINT', 'OPENAI_BASE_URL', 'ANTHROPIC_MODEL'])(
    '%s does not',
    (name) => {
      expect(isBillingVariable(name)).toBe(false);
    },
  );
});

describe('hasVariable', () => {
  test('is true for a non-empty variable, by canonical name', () => {
    expect(hasVariable({ A: 'x' }, 'linux', 'A')).toBe(true);
    expect(hasVariable({ A: '' }, 'linux', 'A')).toBe(false);
    expect(hasVariable({ a: 'x' }, 'linux', 'A')).toBe(false);
    expect(hasVariable({ a: 'x' }, 'win32', 'A')).toBe(true);
  });
});

describe('presentBillingVariables', () => {
  test('lists the non-empty billing variables that matter to one CLI, sorted', () => {
    const names = presentBillingVariables(
      { OPENAI_API_KEY: 'x', CODEX_API_KEY: 'y', ANTHROPIC_API_KEY: 'z', XAI_API_KEY: '' },
      'linux',
      (name) => name !== 'ANTHROPIC_API_KEY',
    );

    expect(names).toEqual(['CODEX_API_KEY', 'OPENAI_API_KEY']);
  });

  test('reports canonical names on Windows', () => {
    expect(presentBillingVariables({ openai_api_key: 'x' }, 'win32', () => true)).toEqual([
      'OPENAI_API_KEY',
    ]);
  });
});
