/**
 * The app's log file: the shell's own entries and every line the core host
 * prints (core masks credentials before it writes). One file, replaced by a
 * fresh one when it has grown large; the previous one is kept once.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@answerwall/core';
import type { Logger } from '@answerwall/core';

const MAX_BYTES = 2 * 1024 * 1024;

export interface AppLog {
  /** The shell's logger; entries pass through core's masking rules. */
  logger: Logger;
  /** Appends lines that are already formatted (the core host's output). */
  append(text: string): void;
  directory: string;
}

export function createAppLog(directory: string, options: { echo: boolean }): AppLog {
  const file = path.join(directory, 'desktop.log');
  let usable = true;
  try {
    mkdirSync(directory, { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) {
      renameSync(file, path.join(directory, 'desktop.previous.log'));
    }
  } catch {
    usable = false;
  }

  const append = (text: string): void => {
    if (options.echo) process.stdout.write(text);
    if (!usable) return;
    try {
      appendFileSync(file, text);
    } catch {
      // A log that cannot be written must not take the app down.
      usable = false;
    }
  };

  return {
    logger: createLogger(
      { level: 'info', format: 'json', write: (line) => append(`${line}\n`) },
      { source: 'shell' },
    ),
    append,
    directory,
  };
}
