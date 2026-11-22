import type { Logger, Storage } from '../contracts/index.ts';
import { openConnection } from './connection.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import type { Migration } from './migrations.ts';
import {
  createDeviceRepository,
  createPairingCodeRepository,
  createPresetRepository,
  createSettingsRepository,
} from './repositories.ts';
import { createTurnRepository } from './turns.ts';

export interface SqliteStorageOptions {
  /**
   * Database file; created and migrated to the current schema when needed.
   * Another process may have it open at the same time (see `Storage`).
   * `:memory:` gives a private database that is gone on `close`.
   */
  file: string;
  logger: Logger;
  /** How long to wait for another connection's write lock; 10 s by default. */
  busyTimeoutMs?: number;
  /** The schema history to apply; the built-in one unless a test replaces it. */
  migrations?: readonly Migration[];
}

/**
 * `Storage` on Node's built-in SQLite: no native dependency. The driver is
 * synchronous, so each repository call completes within one turn of the
 * event loop and calls never interleave inside a transaction.
 *
 * @throws SchemaTooNewError when the file was written by a newer version.
 */
export async function createSqliteStorage(options: SqliteStorageOptions): Promise<Storage> {
  const db = openConnection(options);
  try {
    migrate(db, options.logger, options.migrations ?? MIGRATIONS);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    turns: createTurnRepository(db),
    presets: createPresetRepository(db),
    settings: createSettingsRepository(db, options.logger),
    devices: createDeviceRepository(db),
    pairingCodes: createPairingCodeRepository(db),
    async close() {
      db.close();
    },
  };
}
