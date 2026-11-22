import { createSignal } from 'solid-js';
import type { Language } from '@answerwall/core/protocol';
import { MESSAGES } from '../contracts/messages.ts';
import type { I18n } from '../contracts/services.ts';

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
