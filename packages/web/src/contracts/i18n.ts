import { createSignal } from 'solid-js';
import type { Language } from '@answerwall/core/protocol';
import { MESSAGES } from './messages.ts';
import type { I18n } from './services.ts';

/** The translator over the merged dictionary; the app and the test fakes share it. */
export function createI18n(initial: Language = 'en'): I18n {
  const [language, setLanguage] = createSignal<Language>(initial);
  return {
    language,
    setLanguage,
    t: (key, params = {}) =>
      MESSAGES[language()][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        name in params ? String(params[name]) : placeholder,
      ),
  };
}
