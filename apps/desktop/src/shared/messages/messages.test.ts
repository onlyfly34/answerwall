import { describe, expect, test } from 'vitest';
import { APP } from '../app-info.ts';
import { en } from './en.ts';
import { createTranslator, format, messagesFor, pickLanguage } from './index.ts';
import type { MessageKey } from './index.ts';
import { zhTW } from './zh-TW.ts';

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('the dictionaries', () => {
  test('both languages have every message, with the same placeholders', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(zhTW[key]), key).toEqual(placeholders(en[key]));
      expect(zhTW[key].trim(), key).not.toBe('');
    }
  });

  test('no message spells out the product name; it comes from the brand', () => {
    for (const messages of [en, zhTW]) {
      expect(Object.values(messages).join('\n')).not.toContain(APP.name);
    }
  });
});

describe('format', () => {
  test('replaces the placeholders it is given and leaves the others', () => {
    expect(format('{a} and {b}', { a: 'one', b: 2 })).toBe('one and 2');
    expect(format('{a} and {b}', { a: 'one' })).toBe('one and {b}');
    expect(format('nothing')).toBe('nothing');
    expect(format('{toString}', {})).toBe('{toString}');
  });
});

describe('createTranslator', () => {
  test('looks a message up in the given language', () => {
    expect(createTranslator(messagesFor('en'))('menu.about', { name: 'X' })).toBe('About X');
    expect(createTranslator(messagesFor('zh-TW'))('menu.about', { name: 'X' })).toBe('關於 X');
  });
});

describe('pickLanguage', () => {
  test.each([
    ['zh-TW', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-CN', 'zh-TW'],
    ['zh', 'zh-TW'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['de', 'en'],
    ['ja-JP', 'en'],
    ['', 'en'],
    ['zhx', 'en'],
  ])('%s → %s', (locale, language) => {
    expect(pickLanguage(locale)).toBe(language);
  });
});
