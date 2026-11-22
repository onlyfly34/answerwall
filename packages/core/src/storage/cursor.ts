import { AppError } from '../contracts/index.ts';

/** The last row of a history page: listing continues with the rows older than it. */
export interface HistoryPosition {
  createdAt: number;
  ord: number;
}

const CURSOR_PATTERN = /^([0-9a-z]{1,11})\.([0-9a-z]{1,11})$/;

/**
 * A cursor names a position in the (creation time, insertion order) ordering
 * rather than a row count, so pages stay consistent while asks are added
 * and deleted between requests.
 */
export function encodeCursor(position: HistoryPosition): string {
  return `${position.createdAt.toString(36)}.${position.ord.toString(36)}`;
}

/** @throws AppError `bad_request` for anything `encodeCursor` did not produce. */
export function decodeCursor(cursor: string): HistoryPosition {
  const match = CURSOR_PATTERN.exec(cursor);
  const createdAt = match ? Number.parseInt(match[1] ?? '', 36) : Number.NaN;
  const ord = match ? Number.parseInt(match[2] ?? '', 36) : Number.NaN;
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(ord)) {
    throw new AppError('bad_request', 'cursor: not a cursor returned by this server');
  }
  return { createdAt, ord };
}
