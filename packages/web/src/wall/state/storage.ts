/**
 * JSON values in the browser's storage, validated on the way out. Storage
 * can be unavailable or full (private windows, quotas); the wall then simply
 * does not remember across reloads.
 */
import type { z } from 'zod';

export type StorageArea = 'session' | 'local';

function area(which: StorageArea): Storage | undefined {
  try {
    return which === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return undefined;
  }
}

export function readStored<T>(
  which: StorageArea,
  key: string,
  schema: z.ZodType<T>,
): T | undefined {
  try {
    const raw = area(which)?.getItem(key);
    if (raw == null) return undefined;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(which: StorageArea, key: string, value: unknown): void {
  try {
    if (value === undefined) area(which)?.removeItem(key);
    else area(which)?.setItem(key, JSON.stringify(value));
  } catch {
    // Unavailable or over quota: nothing to do, the state stays in memory.
  }
}
