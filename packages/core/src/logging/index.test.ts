import { describe, expect, test } from 'vitest';
import { BRAND } from '../brand.ts';
import type { LogLevel } from '../contracts/index.ts';
import { createLogger, maskFields, maskText, REDACTED } from './index.ts';
import type { LoggerOptions } from './index.ts';

function capture(options: Partial<LoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => lines.push(line),
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    ...options,
  });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, entries };
}

const DEVICE_TOKEN = 'q83vEjRWeJASNFZ4kKvN7xI0VniQq83vEjRWeJASNFY';

describe('createLogger', () => {
  test('writes one JSON document per entry with time, level, message and fields', () => {
    const { logger, entries } = capture();
    logger.info('listening', { port: 7717, tls: 'off' });
    expect(entries()).toEqual([
      { time: '2026-01-02T03:04:05.000Z', level: 'info', msg: 'listening', port: 7717, tls: 'off' },
    ]);
  });

  test.each<[LogLevel, string[]]>([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('level %s lets %j through', (level, expected) => {
    const { logger, entries } = capture({ level });
    logger.debug('m');
    logger.info('m');
    logger.warn('m');
    logger.error('m');
    expect(entries().map((entry) => entry.level)).toEqual(expected);
  });

  test('a child adds its fields to every entry and inherits masking', () => {
    const { logger, entries } = capture();
    const child = logger.child({ unit: 'auth', token: DEVICE_TOKEN });
    child.child({ askId: 'a1' }).warn('slot failed', { unit: 'runner' });
    expect(entries()).toEqual([
      expect.objectContaining({ unit: 'runner', askId: 'a1', token: REDACTED, msg: 'slot failed' }),
    ]);
  });

  test('a field cannot replace time, level or the message', () => {
    const { logger, entries } = capture();
    logger.info('real', { time: 'x', level: 'x', msg: 'x' });
    expect(entries()[0]).toEqual({
      time: '2026-01-02T03:04:05.000Z',
      level: 'info',
      msg: 'real',
    });
  });

  test('the text format is one readable line with quoted values where needed', () => {
    const { logger, lines } = capture({ format: 'text' });
    logger.warn('plain HTTP beyond loopback', { host: '0.0.0.0', note: 'two words', n: 3 });
    expect(lines).toEqual([
      '2026-01-02T03:04:05.000Z WARN  plain HTTP beyond loopback host=0.0.0.0 note="two words" n=3',
    ]);
  });

  test('the text format masks as well', () => {
    const { logger, lines } = capture({ format: 'text' });
    logger.info(`got Bearer ${DEVICE_TOKEN}`, { authorization: `Bearer ${DEVICE_TOKEN}` });
    expect(lines.join()).not.toContain(DEVICE_TOKEN);
  });

  test('odd values do not break an entry', () => {
    const { logger, entries } = capture();
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    logger.info('odd', {
      loop,
      big: 10n,
      when: new Date(0),
      bytes: new Uint8Array(4),
      fn: () => 1,
      error: new Error(`failed with Bearer ${DEVICE_TOKEN}`),
    });
    expect(entries()[0]).toMatchObject({
      loop: { name: 'loop', self: '[circular]' },
      big: '10',
      when: '1970-01-01T00:00:00.000Z',
      bytes: '[binary]',
      error: { name: 'Error', message: `failed with Bearer ${REDACTED}` },
    });
  });
});

describe('masking of structured fields', () => {
  test.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'setCookie',
    'token',
    'staticToken',
    'deviceToken',
    'access_token',
    'apiKey',
    'api_key',
    'api-key',
    'x-api-key',
    'secret',
    'clientSecret',
    'password',
    'passphrase',
    'privateKey',
    'credentials',
    'pairingCode',
    'pairing_code',
    'pairCode',
  ])('the value of %s is replaced', (name) => {
    expect(maskFields({ [name]: 'value' })).toEqual({ [name]: REDACTED });
  });

  test('secret fields are replaced at any depth, in arrays and in header collections', () => {
    const masked = maskFields({
      request: {
        headers: { Authorization: 'Bearer abc', Cookie: 'a=b', Accept: 'application/json' },
        attempts: [{ apiKey: 'sk-1', provider: 'local' }],
      },
      headers: new Headers({ Cookie: `${BRAND.sessionCookie}=abc`, Accept: '*/*' }),
    });
    expect(masked).toEqual({
      request: {
        headers: { Authorization: REDACTED, Cookie: REDACTED, Accept: 'application/json' },
        attempts: [{ apiKey: REDACTED, provider: 'local' }],
      },
      headers: { cookie: REDACTED, accept: '*/*' },
    });
  });

  test('flags and counts under secret-looking names stay readable', () => {
    expect(
      maskFields({ hasApiKey: true, staticToken: false, outputTokens: 1234, token: null }),
    ).toEqual({ hasApiKey: true, staticToken: false, outputTokens: 1234, token: null });
  });

  test('a pairing code is masked even as a number, and an object under a secret name entirely', () => {
    expect(maskFields({ pairingCode: 12345678, secrets: { a: 1 } })).toEqual({
      pairingCode: REDACTED,
      secrets: REDACTED,
    });
  });

  test('ordinary fields pass unchanged', () => {
    const fields = {
      askId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      status: 401,
      path: '/api/auth/devices/id-1',
      code: 'quota',
      client: '2001:db8:0:0:0:0:0:1',
      durationMs: 12,
    };
    expect(maskFields(fields)).toEqual(fields);
  });

  test('very deep structures are cut off', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 10; depth++) nested = { nested };
    expect(JSON.stringify(maskFields({ nested }))).toContain('[truncated]');
  });
});

describe('masking of text', () => {
  test.each([
    [`Authorization: Bearer ${DEVICE_TOKEN}`, `Authorization: Bearer ${REDACTED}`],
    ['got bearer abc.def-123 from client', `got bearer ${REDACTED} from client`],
    ['Basic dXNlcjpwYXNz', `Basic ${REDACTED}`],
    [
      `Cookie: ${BRAND.sessionCookie}=abcdef; theme=dark`,
      `Cookie: ${BRAND.sessionCookie}=${REDACTED}; theme=dark`,
    ],
    ['retry with token=abc123 failed', `retry with token=${REDACTED} failed`],
    ['{"api_key":"abc123","model":"m"}', `{"api_key":"${REDACTED}","model":"m"}`],
    ['password: hunter2', `password: ${REDACTED}`],
    ['key sk-proj-abcdefgh12345678 rejected', `key ${REDACTED} rejected`],
    [`device ${DEVICE_TOKEN} unknown`, `device ${REDACTED} unknown`],
    ['hash 9f86d081884c7d659a2feae0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', `hash ${REDACTED}`],
    ['wrong code 12345678 from client', `wrong code ${REDACTED} from client`],
    ['{"code":"00000000"}', `{"code":"${REDACTED}"}`],
  ])('%j', (input, expected) => {
    expect(maskText(input)).toBe(expected);
  });

  test.each([
    'listening on http://127.0.0.1:7717',
    'ask 0f8fad5b-d9cb-469f-a165-70867728950e finished in 1234567 ms',
    '2026-01-02T03:04:05.000Z',
    'pairing code: 1234 5678',
    'took 123456789 ms',
    'version 1.20260102.1',
  ])('leaves %j alone', (text) => {
    expect(maskText(text)).toBe(text);
  });

  test('messages and string fields are both scanned', () => {
    const { logger, lines } = capture();
    logger.error(`upstream said: invalid key sk-abcdefgh12345678`, {
      detail: `header was Bearer ${DEVICE_TOKEN}`,
      attempt: 'code 87654321',
    });
    const line = lines.join();
    expect(line).not.toContain('sk-abcdefgh12345678');
    expect(line).not.toContain(DEVICE_TOKEN);
    expect(line).not.toContain('87654321');
  });
});
