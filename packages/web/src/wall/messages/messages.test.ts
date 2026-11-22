import { describe, expect, test } from 'vitest';
import { PROVIDER_ERROR_CODES } from '@answerwall/core/protocol';
import { createI18n } from '../../contracts/i18n.ts';
import { MESSAGES } from '../../contracts/messages.ts';
import { SLOT_PHASES } from '../state/slot-view.ts';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';

const placeholders = (message: string): string[] =>
  Array.from(message.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? '').sort();

describe('the wall dictionary', () => {
  test('both languages have exactly the same keys, all in the wall namespace', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(key).toMatch(/^wall\./);
  });

  test('no message is empty and both languages use the same placeholders', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(zhTW[key].trim(), key).not.toBe('');
      expect(placeholders(zhTW[key]), key).toEqual(placeholders(en[key]));
    }
  });

  test('every provider error code and every phase has a message', () => {
    const keys = Object.keys(en);
    for (const code of PROVIDER_ERROR_CODES) expect(keys).toContain(`wall.error.${code}`);
    for (const phase of SLOT_PHASES) {
      expect(keys).toContain(`wall.phase.${phase}`);
      expect(keys).toContain(`wall.status.${phase}`);
    }
  });

  test('Traditional Chinese uses one word per concept, the same as the app shell', () => {
    // 回答牆 (wall), 供應商 (provider), 回答 (answer); not the variants below.
    const all = MESSAGES['zh-TW'];
    for (const [key, message] of Object.entries(all)) {
      expect(message, key).not.toMatch(/答案|供應者|提供者|提供商/);
    }
    expect(all['wall.title']).toBe(all['app.nav.wall']);
    expect(all['wall.picker.provider']).toBe(all['app.nav.providers']);
  });

  test('the shared translator serves the wall in both languages', () => {
    const i18n = createI18n('en');
    expect(i18n.t('wall.composer.send', { count: 3 })).toBe('Send to 3');
    i18n.setLanguage('zh-TW');
    expect(i18n.t('wall.composer.send', { count: 3 })).toBe('送出給 3 格');
  });
});
