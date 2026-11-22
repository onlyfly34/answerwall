import { describe, expect, test } from 'vitest';
import { createPersistedI18n, initialLanguage, LANGUAGE_STORAGE_KEY } from './language.ts';
import { brokenStorage, memoryStorage } from './test-support.ts';

describe('initial language', () => {
  test('the stored choice wins over the browser', () => {
    const storage = memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'zh-TW' });
    expect(initialLanguage(storage, ['en-US'])).toBe('zh-TW');
  });

  test('otherwise the first browser language the app has', () => {
    expect(initialLanguage(undefined, ['fr-FR', 'zh-Hant-TW', 'en'])).toBe('zh-TW');
    expect(initialLanguage(undefined, ['de', 'en-GB', 'zh-TW'])).toBe('en');
  });

  test('English when nothing matches, the stored value is unknown or storage is blocked', () => {
    expect(initialLanguage(undefined, ['fr', 'de'])).toBe('en');
    expect(initialLanguage(undefined, [])).toBe('en');
    expect(initialLanguage(memoryStorage({ [LANGUAGE_STORAGE_KEY]: 'tlh' }), ['fr'])).toBe('en');
    expect(initialLanguage(brokenStorage, ['zh-TW'])).toBe('zh-TW');
  });
});

describe('persisted translator', () => {
  test('switching translates at once, is remembered and sets the document language', () => {
    const storage = memoryStorage();
    const root = { lang: '' };
    const i18n = createPersistedI18n({ storage, preferred: ['en'], root });
    expect(i18n.language()).toBe('en');
    expect(root.lang).toBe('en');
    expect(i18n.t('app.save')).toBe('Save');

    i18n.setLanguage('zh-TW');

    expect(i18n.language()).toBe('zh-TW');
    expect(i18n.t('app.save')).toBe('儲存');
    expect(root.lang).toBe('zh-TW');
    expect(storage.values.get(LANGUAGE_STORAGE_KEY)).toBe('zh-TW');

    const reopened = createPersistedI18n({ storage, preferred: ['en'], root: { lang: '' } });
    expect(reopened.language()).toBe('zh-TW');
  });

  test('blocked storage does not stop the switch', () => {
    const i18n = createPersistedI18n({
      storage: brokenStorage,
      preferred: ['en'],
      root: { lang: '' },
    });

    i18n.setLanguage('zh-TW');

    expect(i18n.t('app.cancel')).toBe('取消');
  });

  test('placeholders are filled in', () => {
    const i18n = createPersistedI18n({ storage: undefined, preferred: ['en'], root: { lang: '' } });
    expect(i18n.t('app.settings.range', { min: 1, max: 64 })).toBe('Enter a number from 1 to 64.');
  });
});
