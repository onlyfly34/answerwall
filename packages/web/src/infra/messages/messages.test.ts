import { describe, expect, test } from 'vitest';
import { LANGUAGES, PROVIDER_KINDS } from '@answerwall/core/protocol';
import { createI18n } from '../../contracts/i18n.ts';
import { MESSAGES } from '../../contracts/messages.ts';
import { LANGUAGE_NAMES } from '../../pages/language-names.ts';
import { LIMIT_FIELDS } from '../../pages/settings/limits-form.ts';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';

const placeholders = (message: string): string[] =>
  Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? '').sort();

/** The sources of this unit, to see which keys they mention. */
const sources = Object.entries(
  import.meta.glob<string>(['../../{app,infra,pages}/**/*.{ts,tsx}', '!**/*.test.*'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)
  .filter(([path]) => !path.includes('/messages/'))
  .map(([, text]) => text)
  .join('\n');

/** Keys built from a value at run time; each family is checked against its values below. */
const DYNAMIC_PREFIXES = [
  'app.providers.kind.',
  'app.settings.limits.',
  'app.settings.unit.',
  'app.settings.tls.install.',
];

describe('the app dictionary', () => {
  test('en and zh-TW have exactly the same keys, all in the app namespace', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(key).toMatch(/^app\./);
  });

  test('no message is empty and both languages use the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(zhTW[key].trim(), key).not.toBe('');
      expect(placeholders(zhTW[key]), key).toEqual(placeholders(en[key]));
    }
  });

  test('multi-step instructions have the same number of steps in both languages', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zhTW[key].split('\n').length, key).toBe(en[key].split('\n').length);
    }
  });

  test('every key is used by the app and every key the app mentions exists', () => {
    expect(sources.length).toBeGreaterThan(0);
    const mentioned = new Set(
      Array.from(sources.matchAll(/['"`](app\.[A-Za-z0-9.-]+)['"`]/g), (match) => match[1] ?? ''),
    );
    const keys = Object.keys(en);
    for (const key of mentioned) expect(keys, key).toContain(key);
    const unused = keys.filter(
      (key) => !mentioned.has(key) && !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)),
    );
    expect(unused).toEqual([]);
  });

  test('the keys built at run time exist for every value', () => {
    const keys = Object.keys(en);
    for (const kind of PROVIDER_KINDS) expect(keys).toContain(`app.providers.kind.${kind}`);
    for (const { name, unit } of LIMIT_FIELDS) {
      expect(keys).toContain(`app.settings.limits.${name}`);
      expect(keys).toContain(`app.settings.unit.${unit}`);
    }
    for (const platform of ['windows', 'macos', 'ios', 'android', 'linux']) {
      expect(keys).toContain(`app.settings.tls.install.${platform}.title`);
      expect(keys).toContain(`app.settings.tls.install.${platform}.steps`);
    }
  });

  test('every language of the protocol is in the merged dictionary and has a name', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...LANGUAGES].sort());
    for (const language of LANGUAGES) expect(LANGUAGE_NAMES[language]).not.toBe('');
  });

  test('the shared translator serves the app in both languages', () => {
    const i18n = createI18n('en');
    expect(i18n.t('app.providers.refreshOne', { label: 'Claude' })).toBe('Refresh Claude');
    i18n.setLanguage('zh-TW');
    expect(i18n.t('app.providers.refreshOne', { label: 'Claude' })).toBe('重新檢查 Claude');
  });

  test('no message claims that using a subscription here is allowed or compliant', () => {
    for (const text of [...Object.values(en), ...Object.values(zhTW)]) {
      expect(text).not.toMatch(/compliant|is allowed|合規|合法/i);
    }
  });
});
