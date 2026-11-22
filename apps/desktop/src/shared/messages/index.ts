import type { Language } from '@answerwall/core/protocol';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const DICTIONARIES: Record<Language, Messages> = { en, 'zh-TW': zhTW };

export const messagesFor = (language: Language): Messages => DICTIONARIES[language];

/** Replaces `{name}` placeholders; an unknown placeholder stays as written. */
export function format(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

export function createTranslator(messages: Messages): Translate {
  return (key, params) => format(messages[key], params);
}

/**
 * The shell's language follows the system: any Chinese locale gets the one
 * Chinese translation there is, everything else English.
 */
export function pickLanguage(locale: string): Language {
  return /^zh\b/i.test(locale) ? 'zh-TW' : 'en';
}
