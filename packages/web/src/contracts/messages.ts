/**
 * The one dictionary module. Strings live next to their owner — the app's in
 * `infra/messages/`, the wall's in `wall/messages/` — and are merged here.
 * Keys are namespaced by owner (`app.*`, `wall.*`, …) so they cannot collide.
 */
import type { Language } from '@answerwall/core/protocol';
import { en as appEn } from '../infra/messages/en.ts';
import { zhTW as appZhTW } from '../infra/messages/zh-TW.ts';
import { en as wallEn } from '../wall/messages/en.ts';
import { zhTW as wallZhTW } from '../wall/messages/zh-TW.ts';

const en = { ...appEn, ...wallEn };

export type MessageKey = keyof typeof en;

export const MESSAGES: Record<Language, Record<MessageKey, string>> = {
  en,
  'zh-TW': { ...appZhTW, ...wallZhTW },
};
