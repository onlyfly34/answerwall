import { unimplemented } from '../contracts/index.ts';
import type { Logger, Storage } from '../contracts/index.ts';

export interface SqliteStorageOptions {
  /** Database file; created and migrated to the current schema when needed. */
  file: string;
  logger: Logger;
}

export function createSqliteStorage(_options: SqliteStorageOptions): Promise<Storage> {
  return Promise.resolve(unimplemented<Storage>('storage', { close: async () => {} }));
}
