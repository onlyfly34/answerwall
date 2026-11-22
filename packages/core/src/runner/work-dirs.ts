import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../contracts/index.ts';

/** The per-slot working directories under one root that the runner owns entirely. */
export interface WorkDirs {
  /** Empties the root, removing whatever a previous process left behind. */
  reset(): Promise<void>;
  /** A fresh, empty directory; `name` must be a plain file name. */
  create(name: string): Promise<string>;
  /** Deletes a directory and its content. Never throws: a failure is logged. */
  remove(dir: string): Promise<void>;
}

// A child that was just killed may hold its files for a moment, notably on Windows.
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 50 } as const;
const PRIVATE_DIR = { recursive: true, mode: 0o700 } as const;

export function createWorkDirs(root: string, logger: Logger): WorkDirs {
  return {
    async reset() {
      await rm(root, REMOVE_OPTIONS);
      await mkdir(root, PRIVATE_DIR);
    },
    async create(name) {
      const dir = join(root, name);
      await rm(dir, REMOVE_OPTIONS);
      await mkdir(dir, PRIVATE_DIR);
      return dir;
    },
    async remove(dir) {
      try {
        await rm(dir, REMOVE_OPTIONS);
      } catch (error) {
        logger.warn('could not remove a work directory', { error: describeError(error) });
      }
    },
  };
}

/** The error's code or name: enough to diagnose, without paths or other message content. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : error.name;
  }
  return typeof error;
}
