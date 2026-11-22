import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createMemoryLogger } from '../testing/index.ts';
import { IN_MEMORY, openConnection } from './connection.ts';
import type { Connection } from './connection.ts';
import { createSqliteStorage } from './index.ts';
import { migrate, MIGRATIONS, SchemaTooNewError } from './migrations.ts';
import type { Migration } from './migrations.ts';

let dir: string;
const connections: Connection[] = [];

const connect = (file: string): Connection => {
  const db = openConnection({ file });
  connections.push(db);
  return db;
};

const version = (db: Connection): number | undefined =>
  db.get<{ user_version: number }>('PRAGMA user_version')?.user_version;

const tables = (db: Connection): string[] =>
  db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .map((row) => row.name);

const columns = (db: Connection, table: string): string[] =>
  db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name);

/** The schema as version 1 shipped it. */
const INITIAL = MIGRATIONS.slice(0, 1);

/** A second schema version, as a later release would add it. */
const ADD_PINNED: Migration = {
  version: 2,
  description: 'pinned turns',
  up: (db) => db.exec('ALTER TABLE turns ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0'),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storage-migrations-'));
});

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the built-in schema', () => {
  test('creates every table of the storage contract on an empty database', () => {
    const db = connect(IN_MEMORY);
    const logger = createMemoryLogger();

    expect(migrate(db, logger)).toEqual([1]);

    expect(tables(db)).toEqual([
      'conversations',
      'devices',
      'pairing_codes',
      'presets',
      'settings',
      'slot_runs',
      'turns',
    ]);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(logger.entries).toEqual([
      { level: 'info', message: 'database schema migrated', fields: { version: 1 } },
    ]);
  });

  test('slot runs carry the documented columns, including the two reserved for multi-turn', () => {
    const db = connect(IN_MEMORY);
    migrate(db, createMemoryLogger());

    expect(columns(db, 'slot_runs')).toEqual(
      expect.arrayContaining([
        'provider_id',
        'kind',
        'model',
        'effort',
        'status',
        'error_code',
        'text',
        'reasoning',
        'usage_json',
        'started_at',
        'elapsed_ms',
        'provider_session_id',
        'cwd_key',
      ]),
    );
  });

  test('versions are consecutive from 1', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });

  test('running it again changes nothing', () => {
    const db = connect(IN_MEMORY);
    const logger = createMemoryLogger();
    migrate(db, logger);

    expect(migrate(db, logger)).toEqual([]);
    expect(logger.entries).toHaveLength(1);
  });
});

describe('upgrading an existing file', () => {
  test('a version 1 file is migrated forward and keeps its data', async () => {
    const file = join(dir, 'v1.sqlite');
    const logger = createMemoryLogger();
    const v1 = await createSqliteStorage({ file, logger, migrations: INITIAL });
    await v1.devices.insert({
      id: 'device-1',
      name: 'Laptop',
      tokenHash: 'ab'.repeat(32),
      createdAt: 1,
      lastUsedAt: null,
    });
    await v1.settings.save({ language: 'zh-TW' });
    await v1.close();

    const upgraded = await createSqliteStorage({
      file,
      logger,
      migrations: [...INITIAL, ADD_PINNED],
    });

    expect(await upgraded.devices.list()).toEqual([
      {
        id: 'device-1',
        name: 'Laptop',
        tokenHash: 'ab'.repeat(32),
        createdAt: 1,
        lastUsedAt: null,
      },
    ]);
    expect(await upgraded.settings.load()).toEqual({ language: 'zh-TW' });
    await upgraded.close();

    const db = connect(file);
    expect(version(db)).toBe(2);
    expect(columns(db, 'turns')).toContain('pinned');
    expect(logger.entries.map((entry) => entry.fields.version)).toEqual([1, 2]);
  });

  test('several pending migrations are applied in order', () => {
    const db = connect(IN_MEMORY);
    const third: Migration = {
      version: 3,
      description: 'rename it',
      up: (inner) => inner.exec('ALTER TABLE turns RENAME COLUMN pinned TO starred'),
    };

    expect(migrate(db, createMemoryLogger(), [...INITIAL, ADD_PINNED, third])).toEqual([1, 2, 3]);

    expect(columns(db, 'turns')).toContain('starred');
    expect(version(db)).toBe(3);
  });

  test('a failing migration is rolled back completely and the earlier ones stay', () => {
    const db = connect(IN_MEMORY);
    const broken: Migration = {
      version: 2,
      description: 'fails half-way',
      up: (inner) => {
        inner.exec('CREATE TABLE half_done (a INTEGER) STRICT');
        inner.exec('ALTER TABLE no_such_table ADD COLUMN a INTEGER');
      },
    };

    expect(() => migrate(db, createMemoryLogger(), [...INITIAL, broken])).toThrow(/no_such_table/);

    expect(version(db)).toBe(1);
    expect(tables(db)).not.toContain('half_done');
    expect(migrate(db, createMemoryLogger(), [...INITIAL, ADD_PINNED])).toEqual([2]);
  });

  test('a file from a newer version is refused and left untouched', async () => {
    const file = join(dir, 'newer.sqlite');
    const newer = await createSqliteStorage({
      file,
      logger: createMemoryLogger(),
      migrations: [...MIGRATIONS, { ...ADD_PINNED, version: MIGRATIONS.length + 1 }],
    });
    await newer.close();

    await expect(createSqliteStorage({ file, logger: createMemoryLogger() })).rejects.toThrow(
      SchemaTooNewError,
    );

    const db = connect(file);
    expect(version(db)).toBe(MIGRATIONS.length + 1);
    expect(columns(db, 'turns')).toContain('pinned');
  });

  test('a migration list with a gap is rejected before anything runs', () => {
    const db = connect(IN_MEMORY);

    expect(() =>
      migrate(db, createMemoryLogger(), [...INITIAL, { ...ADD_PINNED, version: 3 }]),
    ).toThrow(/out of order/);

    expect(tables(db)).toEqual([]);
  });

  test('two connections opening a fresh file migrate it exactly once', () => {
    const file = join(dir, 'fresh.sqlite');
    const first = connect(file);
    const second = connect(file);

    expect(migrate(first, createMemoryLogger())).toEqual([1]);
    expect(migrate(second, createMemoryLogger())).toEqual([]);
  });
});
