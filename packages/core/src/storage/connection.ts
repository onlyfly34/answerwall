import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

/** SQLite's name for a private database that lives only as long as its connection. */
export const IN_MEMORY = ':memory:';

/**
 * How long a statement waits for another connection's write lock before it
 * fails. Writes here are short, so a wait this long means something is stuck.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 10_000;

export interface ConnectionOptions {
  file: string;
  busyTimeoutMs?: number;
}

/**
 * One SQLite connection. `node:sqlite` is synchronous; statements are
 * prepared once per distinct SQL text and reused.
 */
export interface Connection {
  /** Executes a statement and returns the number of rows it changed. */
  run(sql: string, ...params: SQLInputValue[]): number;
  get<Row>(sql: string, ...params: SQLInputValue[]): Row | undefined;
  all<Row>(sql: string, ...params: SQLInputValue[]): Row[];
  /** Runs SQL that needs no parameters and returns nothing (DDL, pragmas). */
  exec(sql: string): void;
  /**
   * Runs `work` in a write transaction: committed when it returns, rolled
   * back when it throws. Takes the write lock up front (`BEGIN IMMEDIATE`),
   * waiting for another connection if needed, so the work never fails
   * half-way on a lock upgrade. Not reentrant.
   */
  transaction<T>(work: () => T): T;
  /** Idempotent. */
  close(): void;
}

/**
 * Opens (creating when missing) the database file with the settings every
 * connection needs:
 *
 * - foreign keys enforced;
 * - a busy timeout, so a second process on the same file is waited for;
 * - write-ahead logging, so readers never block the writer and every read
 *   sees the other connections' committed writes;
 * - incremental auto-vacuum (effective for files created here), so pruning
 *   history can hand space back to the file system.
 *
 * A new file is created readable by its owner only; SQLite gives its `-wal`
 * and `-shm` companions the same mode. On Windows mode bits do not apply and
 * the file is protected by the access control list of the data directory.
 */
export function openConnection(options: ConnectionOptions): Connection {
  const persistent = options.file !== IN_MEMORY;
  if (persistent) closeSync(openSync(options.file, 'a', 0o600));

  const db = new DatabaseSync(options.file, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
  const statements = new Map<string, StatementSync>();
  let open = true;

  const prepared = (sql: string): StatementSync => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  try {
    // Both are no-ops on an existing file that already has them. The order
    // matters for a new one: the vacuum mode must be chosen before the first
    // page is written.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    if (persistent) db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    run: (sql, ...params) => Number(prepared(sql).run(...params).changes),
    get: <Row>(sql: string, ...params: SQLInputValue[]) =>
      prepared(sql).get(...params) as Row | undefined,
    all: <Row>(sql: string, ...params: SQLInputValue[]) => prepared(sql).all(...params) as Row[],
    exec: (sql) => db.exec(sql),
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      if (!open) return;
      open = false;
      statements.clear();
      db.close();
    },
  };
}
