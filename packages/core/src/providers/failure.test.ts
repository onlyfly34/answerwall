import { describe, expect, test } from 'vitest';
import { classifyFailureText, failureFromText, sanitizeDiagnostic } from './failure.ts';

describe('classifyFailureText', () => {
  test.each([
    ['Not logged in · Please run /login', 'not_logged_in'],
    ['Error: authentication required', 'not_logged_in'],
    ['unexpected status 401 Unauthorized', 'not_logged_in'],
    ['Invalid API key provided', 'not_logged_in'],
    ['OAuth token has expired', 'not_logged_in'],
    ["You've hit your usage limit. Upgrade to Pro.", 'quota'],
    ["You've hit your session limit · resets 3am", 'quota'],
    ['RESOURCE_EXHAUSTED: You have exhausted your quota', 'quota'],
    ['insufficient credit balance', 'quota'],
    ['exceeded retry limit, last status: 429 Too Many Requests', 'rate_limited'],
    ['rate_limit_error: slow down', 'rate_limited'],
    ['Rate limit exceeded', 'rate_limited'],
    ['Rate limit reached for requests per minute', 'rate_limited'],
    ['Weekly limit reached', 'quota'],
    ['The service is overloaded', 'rate_limited'],
    ['Error: unknown model "foo-9"', 'model_not_found'],
    ["The 'foo' model is not supported when using this account.", 'model_not_found'],
    ['The model `foo` does not exist or you do not have access to it.', 'model_not_found'],
    [
      'issue with the selected model (foo). It may not exist or you may not have access',
      'model_not_found',
    ],
    ['model_not_found', 'model_not_found'],
    ['prompt is too long: 250000 tokens > 200000 maximum', 'prompt_too_long'],
    ["This model's maximum context length is 8192 tokens", 'prompt_too_long'],
    ['stream disconnected before completion', 'network'],
    ['getaddrinfo ENOTFOUND api.example.invalid', 'network'],
    ['connection refused', 'network'],
  ] as const)('%j is %s', (text, code) => {
    expect(classifyFailureText(text)).toBe(code);
  });

  test.each(['', 'something went wrong', 'panic: index out of range'])(
    '%j is not recognised',
    (text) => {
      expect(classifyFailureText(text)).toBeUndefined();
    },
  );
});

describe('sanitizeDiagnostic', () => {
  test('removes e-mail addresses, absolute paths and key-like strings', () => {
    const clean = sanitizeDiagnostic(
      'user jane.doe+x@example.com failed in /home/jane/.config/tool/auth.json and C:\\Users\\Jane\\AppData\\tool with key sk-abcdef0123456789abcd',
    );

    expect(clean).toBe('user <email> failed in <path> and <path> with key <redacted>');
  });

  test('removes home-relative paths and long opaque tokens', () => {
    const clean = sanitizeDiagnostic(`see ~/.tool/logs/run.log token ${'A1b2'.repeat(12)}`);

    expect(clean).toBe('see <path> token <redacted>');
  });

  test('keeps ordinary prose, URLs without credentials and slashes in words', () => {
    expect(sanitizeDiagnostic('HTTP 404 from https://api.example.com/v1/models and/or retry')).toBe(
      'HTTP 404 from https://api.example.com/v1/models and/or retry',
    );
  });

  test('strips terminal escape sequences and collapses whitespace into one line', () => {
    expect(sanitizeDiagnostic('\u001b[31mError:\u001b[0m  first\r\n\tsecond  ')).toBe(
      'Error: first second',
    );
  });

  test('bounds the length', () => {
    const clean = sanitizeDiagnostic('word '.repeat(200));

    expect(clean).toHaveLength(300);
    expect(clean.endsWith('…')).toBe(true);
    expect(sanitizeDiagnostic('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('failureFromText', () => {
  test('classifies and sanitises what the provider said', () => {
    expect(failureFromText('Not logged in as a@b.co', 'fallback')).toEqual({
      code: 'not_logged_in',
      message: 'Not logged in as <email>',
    });
  });

  test('an explicit code wins over the guess', () => {
    expect(failureFromText('Not logged in', 'fallback', 'quota').code).toBe('quota');
  });

  test('falls back to unknown and to the fallback message', () => {
    expect(failureFromText('  ', 'It failed.')).toEqual({ code: 'unknown', message: 'It failed.' });
  });
});
