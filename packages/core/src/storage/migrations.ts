import type { Logger } from '../contracts/index.ts';
import type { Connection } from './connection.ts';

/**
 * One forward step of the schema. Migrations are append-only: a released
 * migration is never edited, a change is a new migration with the next
 * version. There are no down migrations.
 */
export interface Migration {
  /** Consecutive, starting at 1. The database records the last one applied. */
  version: number;
  description: string;
  up(db: Connection): void;
}

/**
 * Column order is deliberate: SQLite reads a row from its first column, so
 * the large values (`prompt`, `text`, `reasoning`) come last and listing,
 * pruning and status updates never touch their overflow pages.
 *
 * `turns.ord` is the insertion order. It never repeats (AUTOINCREMENT) and
 * breaks ties between turns created in the same millisecond, which gives the
 * history cursor a total order.
 *
 * `size_bytes` is the UTF-8 size of the texts a row holds, kept current on
 * every write so that pruning to a byte budget is a sum over small columns.
 *
 * `provider_session_id` and `cwd_key` are reserved for multi-turn
 * conversations and are not written yet.
 */
const INITIAL_SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE turns (
    ord INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done')),
    seq INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    prompt TEXT NOT NULL
  ) STRICT;
  CREATE INDEX turns_by_conversation ON turns (conversation_id);
  CREATE INDEX turns_by_age ON turns (created_at, ord);

  CREATE TABLE slot_runs (
    turn_id TEXT NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    slot_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT,
    effort TEXT,
    status TEXT NOT NULL
      CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled', 'timeout')),
    streaming TEXT,
    error_code TEXT,
    error_message TEXT,
    truncated INTEGER NOT NULL,
    notices_json TEXT NOT NULL,
    usage_json TEXT,
    started_at INTEGER,
    elapsed_ms INTEGER,
    provider_session_id TEXT,
    cwd_key TEXT,
    size_bytes INTEGER NOT NULL,
    text TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    UNIQUE (turn_id, slot_id)
  ) STRICT;

  CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slots_json TEXT NOT NULL,
    layout_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    document TEXT NOT NULL
  ) STRICT;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  ) STRICT;

  CREATE TABLE pairing_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL
  ) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'conversations, turns, slot runs, presets, settings, devices, pairing codes',
    up: (db) => db.exec(INITIAL_SCHEMA),
  },
];

/** The file was written by a newer build; opening it could damage data this build does not know about. */
export class SchemaTooNewError extends Error {
  constructor(found: number, supported: number) {
    super(
      `The database has schema version ${found}, but this version supports at most ${supported}. Use a newer version to open it.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

function schemaVersion(db: Connection): number {
  return db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
}

function assertConsecutive(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration ${index + 1} is missing or out of order`);
    }
  });
}

/**
 * Brings the schema to the last version in `migrations`. Each migration runs
 * in its own transaction together with the version bump, so a failure leaves
 * the last complete version behind. The version is read again under the
 * write lock: when two processes open a fresh file at once, the second waits
 * and then finds the work done.
 *
 * Returns the versions applied by this call.
 */
export function migrate(
  db: Connection,
  logger: Logger,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  assertConsecutive(migrations);
  const latest = migrations.length;
  const applied: number[] = [];

  for (;;) {
    const before = schemaVersion(db);
    if (before > latest) throw new SchemaTooNewError(before, latest);
    if (before === latest) return applied;

    const step = db.transaction(() => {
      const current = schemaVersion(db);
      const migration = migrations[current];
      if (!migration) return null;
      migration.up(db);
      // PRAGMA takes no bound parameters; the value is a validated integer.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      return migration;
    });
    if (step) {
      applied.push(step.version);
      logger.info('database schema migrated', { version: step.version });
    }
  }
}
