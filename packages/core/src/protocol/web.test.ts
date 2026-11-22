import { describe, expect, test } from 'vitest';
import {
  AskRequestSchema,
  concurrencyBounds,
  createDefaultSettings,
  DEFAULT_WEB_CELLS,
  extensionIdOfOrigin,
  isCliKind,
  MAX_EXTENSION_IDS,
  PROVIDER_ERROR_CODES,
  ProviderInstanceInputSchema,
  ProviderInstanceSchema,
  SessionResponseSchema,
  SettingsPatchSchema,
  SettingsSchema,
  WEB_FAILURE_CODES,
  WEB_RESULT_MESSAGE_MAX,
  WEB_SITES,
  WebCellsSettingsSchema,
  webProviderId,
  WebResultRequestSchema,
  webSearchSupport,
} from './index.ts';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

const webInstance = (overrides: Record<string, unknown> = {}) => ({
  id: 'web-claude',
  kind: 'web',
  site: 'claude',
  label: 'Claude (web)',
  enabled: true,
  concurrency: 2,
  models: [],
  ...overrides,
});

const issuePaths = (value: unknown): string[] => {
  const result = ProviderInstanceSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('web provider instances', () => {
  test('a site from the list with its own id is accepted, as stored and as written', () => {
    for (const site of WEB_SITES) {
      const instance = webInstance({ id: webProviderId(site.id), site: site.id });
      expect(ProviderInstanceSchema.parse(instance)).toEqual(instance);
      expect(ProviderInstanceInputSchema.parse(instance)).toEqual(instance);
    }
  });

  test('a site that is not on the list is refused: there is no free-form address', () => {
    expect(issuePaths(webInstance({ id: 'web-example', site: 'example' }))).toEqual(['site']);
    expect(
      ProviderInstanceSchema.parse(webInstance({ url: 'https://evil.example' })),
    ).not.toHaveProperty('url');
  });

  test('the id follows from the site, so a site is configured once', () => {
    expect(issuePaths(webInstance({ id: 'my-claude' }))).toEqual(['id']);
    expect(issuePaths(webInstance({ id: 'web-chatgpt' }))).toEqual(['id']);
  });

  test('it has no models and a bounded concurrency', () => {
    expect(issuePaths(webInstance({ models: ['opus'] }))).toEqual(['models']);
    expect(issuePaths(webInstance({ defaultModel: 'opus' }))).toEqual(['models']);
    const bounds = concurrencyBounds('web');
    expect(issuePaths(webInstance({ concurrency: bounds.max + 1 }))).toEqual(['concurrency']);
    expect(issuePaths(webInstance({ concurrency: bounds.max }))).toEqual([]);
  });

  test('it is neither a CLI nor something with a search switch', () => {
    expect(isCliKind('web')).toBe(false);
    expect(isCliKind('openai-compat')).toBe(false);
    expect(isCliKind('claude')).toBe(true);
    expect(webSearchSupport('web')).toBe('none');
    expect(issuePaths(webInstance({ id: 'claude' }))).toContain('id');
  });

  test('every site has a distinct id, host and label', () => {
    for (const field of ['id', 'host', 'label'] as const) {
      expect(new Set(WEB_SITES.map((site) => site[field])).size).toBe(WEB_SITES.length);
    }
  });
});

describe('web cell settings', () => {
  test('everything is off in a fresh installation', () => {
    expect(createDefaultSettings().webCells).toEqual({
      enabled: false,
      fillPrompt: false,
      readAnswer: false,
      extensionIds: [],
    });
    expect(DEFAULT_WEB_CELLS).toEqual(createDefaultSettings().webCells);
    expect(createDefaultSettings().providers.some((provider) => provider.kind === 'web')).toBe(
      false,
    );
  });

  test('the settings document needs the section; a patch may change one switch', () => {
    const { webCells: _dropped, ...without } = createDefaultSettings();
    expect(SettingsSchema.safeParse(without).success).toBe(false);
    expect(SettingsPatchSchema.parse({ webCells: { fillPrompt: true } })).toEqual({
      webCells: { fillPrompt: true },
    });
  });

  test.each([
    ['a wildcard', '*'],
    ['an origin instead of an id', `chrome-extension://${EXTENSION_ID}`],
    ['too short', 'abcdefghijklmnop'],
    ['letters outside a to p', 'abcdefghijklmnopabcdefghijklmnoz'],
    ['upper case', EXTENSION_ID.toUpperCase()],
    ['an empty string', ''],
  ])('the allowlist takes exact extension ids only: %s is refused', (_label, id) => {
    const result = WebCellsSettingsSchema.safeParse({ ...DEFAULT_WEB_CELLS, extensionIds: [id] });
    expect(result.success).toBe(false);
  });

  test('the allowlist is short and has no duplicates', () => {
    const ids = Array.from(
      { length: MAX_EXTENSION_IDS + 1 },
      (_, index) => EXTENSION_ID.slice(0, 31) + 'abcdefghijklmnop'[index],
    );
    const parse = (extensionIds: string[]) =>
      WebCellsSettingsSchema.safeParse({ ...DEFAULT_WEB_CELLS, extensionIds }).success;
    expect(parse(ids.slice(0, MAX_EXTENSION_IDS))).toBe(true);
    expect(parse(ids)).toBe(false);
    expect(parse([EXTENSION_ID, EXTENSION_ID])).toBe(false);
  });
});

describe('extensionIdOfOrigin', () => {
  test('reads the id of an extension origin', () => {
    expect(extensionIdOfOrigin(`chrome-extension://${EXTENSION_ID}`)).toBe(EXTENSION_ID);
  });

  test.each([
    `chrome-extension://${EXTENSION_ID}/`,
    `chrome-extension://${EXTENSION_ID}/wall.html`,
    `chrome-extension://${EXTENSION_ID}.evil.example`,
    `https://${EXTENSION_ID}`,
    `moz-extension://${EXTENSION_ID}`,
    'chrome-extension://short',
    'null',
    '',
  ])('%s is not one', (origin) => {
    expect(extensionIdOfOrigin(origin)).toBeUndefined();
  });
});

describe('the result of a web slot', () => {
  test('an answer, a failure with a code, or a cancellation with a reason', () => {
    expect(WebResultRequestSchema.parse({ outcome: 'done', text: '4' })).toEqual({
      outcome: 'done',
      text: '4',
    });
    expect(
      WebResultRequestSchema.parse({ outcome: 'failed', code: 'not_logged_in', message: ' x ' }),
    ).toEqual({ outcome: 'failed', code: 'not_logged_in', message: 'x' });
    expect(WebResultRequestSchema.parse({ outcome: 'failed', code: 'bad_output' })).toEqual({
      outcome: 'failed',
      code: 'bad_output',
    });
    expect(WebResultRequestSchema.parse({ outcome: 'cancelled', reason: 'tab closed' })).toEqual({
      outcome: 'cancelled',
      reason: 'tab closed',
    });
  });

  test.each([
    ['an answer without text', { outcome: 'done', text: '' }],
    ['an answer with no text field', { outcome: 'done' }],
    ['an unknown outcome', { outcome: 'timeout' }],
    ['a failure without a code', { outcome: 'failed' }],
    ['a code only the server may give', { outcome: 'failed', code: 'timeout' }],
    ['a code of a CLI', { outcome: 'failed', code: 'not_installed' }],
    [
      'a message that is too long',
      { outcome: 'failed', code: 'unknown', message: 'x'.repeat(WEB_RESULT_MESSAGE_MAX + 1) },
    ],
    [
      'a reason that is too long',
      { outcome: 'cancelled', reason: 'x'.repeat(WEB_RESULT_MESSAGE_MAX + 1) },
    ],
  ])('%s is refused', (_label, body) => {
    expect(WebResultRequestSchema.safeParse(body).success).toBe(false);
  });

  test('every failure code is a slot error code', () => {
    for (const code of WEB_FAILURE_CODES) expect(PROVIDER_ERROR_CODES).toContain(code);
  });
});

test('an ask may declare that its client runs the web slots', () => {
  const base = { prompt: 'hi', targets: [{ slotId: 'a', providerId: 'web-claude' }] };
  expect(AskRequestSchema.parse(base)).not.toHaveProperty('runsWebSlots');
  expect(AskRequestSchema.parse({ ...base, runsWebSlots: true }).runsWebSlots).toBe(true);
  expect(AskRequestSchema.safeParse({ ...base, runsWebSlots: 'yes' }).success).toBe(false);
});

test('a session response may carry the token of an extension client', () => {
  expect(SessionResponseSchema.parse({ device: null })).toEqual({ device: null });
  expect(SessionResponseSchema.parse({ device: null, token: 'x'.repeat(43) }).token).toHaveLength(
    43,
  );
});
