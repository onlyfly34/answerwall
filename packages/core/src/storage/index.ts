import { unimplemented } from '../contracts/index.ts';
import type { Logger, Storage } from '../contracts/index.ts';

export interface SqliteStorageOptions {
  /**
   * Database file; created and migrated to the current schema when needed.
   * Another process may have it open at the same time (see `Storage`).
   */
  file: string;
  logger: Logger;
}

export function createSqliteStorage(_options: SqliteStorageOptions): Promise<Storage> {
  return Promise.resolve(unimplemented<Storage>('storage', { close: async () => {} }));
}
