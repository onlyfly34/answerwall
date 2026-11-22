import { BRAND, LanguageSchema } from '@answerwall/core/protocol';
import type { Language } from '@answerwall/core/protocol';
import { createI18n } from '../contracts/i18n.ts';
import type { I18n } from '../contracts/services.ts';

export const LANGUAGE_STORAGE_KEY = `${BRAND.slug}.language`;

/** Storage can be unavailable (private mode, blocked cookies); the choice is then per page load. */
function readStored(storage: Pick<Storage, 'getItem'> | undefined): Language | undefined {
  try {
    const parsed = LanguageSchema.safeParse(storage?.getItem(LANGUAGE_STORAGE_KEY));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The stored choice, else the first browser language this app has, else English. */
export function initialLanguage(
  storage: Pick<Storage, 'getItem'> | undefined,
  preferred: readonly string[],
): Language {
  const stored = readStored(storage);
  if (stored) return stored;
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-TW';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

export interface LanguageEnvironment {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  preferred?: readonly string[];
  /** Receives the `lang` attribute, for screen readers and hyphenation. */
  root?: Pick<HTMLElement, 'lang'>;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The shared translator, with the language remembered on this device. */
export function createPersistedI18n(environment: LanguageEnvironment = {}): I18n {
  const storage = 'storage' in environment ? environment.storage : browserStorage();
  const root = environment.root ?? document.documentElement;
  const i18n = createI18n(initialLanguage(storage, environment.preferred ?? navigator.languages));
  root.lang = i18n.language();
  return {
    ...i18n,
    setLanguage(language) {
      i18n.setLanguage(language);
      root.lang = language;
      try {
        storage?.setItem(LANGUAGE_STORAGE_KEY, language);
      } catch {
        // Not remembered; the language still applies to this page.
      }
    },
  };
}
