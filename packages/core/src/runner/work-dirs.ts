import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../contracts/index.ts';

/** The per-slot working directories under one root that the runner owns entirely. */
export interface WorkDirs {
  /**
   * Makes this process the only owner of the root, until `release` or the
   * end of the process. Idempotent.
   *
   * @throws WorkRootInUseError when another owner is alive.
   */
  claim(): Promise<void>;
  /** Gives the root up again. Idempotent, and harmless without a claim. */
  release(): Promise<void>;
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

/**
 * Another server already runs on the data directory. Starting anyway would
 * report its running asks as interrupted and delete the directories its
 * child processes work in.
 */
export class WorkRootInUseError extends Error {
  constructor() {
    super(
      'Another server is already running on this data directory. Stop it first, or start this one with a data directory of its own.',
    );
    this.name = 'WorkRootInUseError';
  }
}

const SQLITE_BUSY = 5;

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  'errcode' in error &&
  typeof error.errcode === 'number' &&
  // The low byte is the primary result code; the rest says which kind of busy.
  (error.errcode & 0xff) === SQLITE_BUSY;

/**
 * Takes the lock that marks the owner of `root`: an exclusive SQLite
 * transaction on an empty database file next to it (never inside: `reset`
 * empties the root), held open for as long as the claim lasts.
 *
 * It is the operating system's file lock underneath, so it ends with the
 * process however that dies, and a crash leaves nothing stale behind. A
 * file holding a process id would need a liveness check that a reused id
 * (always the case in a container) gets wrong. SQLite also keeps two
 * connections within one process apart, and works the same on Windows.
 */
function lockRoot(root: string): DatabaseSync {
  const db = new DatabaseSync(`${root}.lock`, { timeout: 0 });
  try {
    // Nothing is ever written, so no journal file needs to appear next to the lock.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
    return db;
  } catch (error) {
    db.close();
    throw isBusy(error) ? new WorkRootInUseError() : error;
  }
}

export function createWorkDirs(root: string, logger: Logger): WorkDirs {
  let lock: DatabaseSync | undefined;
  return {
    async claim() {
      if (lock) return;
      await mkdir(dirname(root), { recursive: true });
      lock = lockRoot(root);
    },
    async release() {
      const held = lock;
      lock = undefined;
      held?.close();
    },
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
