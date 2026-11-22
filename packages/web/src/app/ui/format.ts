import type { Language } from '@answerwall/core/protocol';

/** A date and time in the reader's language, e.g. "22 Nov 2026, 14:05". */
export function formatDateTime(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    timestamp,
  );
}

/** A time of day, e.g. "14:05". */
export function formatTime(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(timestamp);
}
