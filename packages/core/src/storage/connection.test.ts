import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { IN_MEMORY, openConnection } from './connection.ts';
import type { Connection } from './connection.ts';

let dir: string;
const connections: Connection[] = [];

const connect = (file: string, busyTimeoutMs?: number): Connection => {
  const db = openConnection({ file, ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }) });
  connections.push(db);
  return db;
};

const pragma = (db: Connection, name: string): unknown =>
  Object.values(db.get<Record<string, unknown>>(`PRAGMA ${name}`) ?? {})[0];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storage-connection-'));
});

afterEach(() => {
  for (const db of connections.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openConnection', () => {
  test('a file database uses write-ahead logging, foreign keys, a busy timeout and incremental vacuum', () => {
    const db = connect(join(dir, 'a.sqlite'), 1234);

    expect(pragma(db, 'journal_mode')).toBe('wal');
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'busy_timeout')).toBe(1234);
    expect(pragma(db, 'auto_vacuum')).toBe(2);
    expect(pragma(db, 'synchronous')).toBe(1);
  });

  test('an in-memory database enforces foreign keys', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY) STRICT');
    db.exec('CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id)) STRICT');

    expect(() => db.run('INSERT INTO child (parent_id) VALUES (?)', 1)).toThrow(/FOREIGN KEY/);
  });

  test.skipIf(process.platform === 'win32')(
    'a new database file is readable by its owner only',
    () => {
      const file = join(dir, 'private.sqlite');
      const db = connect(file);
      db.exec('CREATE TABLE t (a INTEGER) STRICT');

      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(`${file}-wal`).mode & 0o777).toBe(0o600);
    },
  );

  test('does not accept double-quoted string literals', () => {
    const db = connect(IN_MEMORY);

    expect(() => db.get('SELECT "not a column"')).toThrow();
  });
});

describe('statements', () => {
  test('run reports the changed rows; get and all read them back', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');

    expect(db.run('INSERT INTO t (a) VALUES (?), (?)', 1, 2)).toBe(2);
    expect(db.run('UPDATE t SET a = a + 10 WHERE a = ?', 99)).toBe(0);
    expect(db.get('SELECT a FROM t WHERE a = ?', 2)).toEqual({ a: 2 });
    expect(db.get('SELECT a FROM t WHERE a = ?', 3)).toBeUndefined();
    expect(db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('a reused statement sees later writes', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');
    const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n;

    expect(count()).toBe(0);
    db.run('INSERT INTO t (a) VALUES (?)', 1);
    expect(count()).toBe(1);
  });
});

describe('transaction', () => {
  test('commits what the work wrote and returns its result', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');

    const result = db.transaction(() => {
      db.run('INSERT INTO t (a) VALUES (?)', 1);
      return 'done';
    });

    expect(result).toBe('done');
    expect(db.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
  });

  test('rolls everything back when the work throws, and stays usable', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (a) VALUES (?)', 1);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.all('SELECT a FROM t')).toEqual([]);
    db.transaction(() => db.run('INSERT INTO t (a) VALUES (?)', 2));
    expect(db.all('SELECT a FROM t')).toEqual([{ a: 2 }]);
  });

  test('rolls back when a statement inside fails', () => {
    const db = connect(IN_MEMORY);
    db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY) STRICT');

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (a) VALUES (?)', 1);
        db.run('INSERT INTO t (a) VALUES (?)', 1);
      }),
    ).toThrow(/UNIQUE/);

    expect(db.all('SELECT a FROM t')).toEqual([]);
  });
});

describe('two connections on one file', () => {
  test('a read sees what the other connection committed, and not what it has not', () => {
    const file = join(dir, 'shared.sqlite');
    const first = connect(file);
    const second = connect(file);
    first.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');

    first.exec('BEGIN IMMEDIATE');
    first.run('INSERT INTO t (a) VALUES (?)', 1);
    expect(second.all('SELECT a FROM t')).toEqual([]);
    first.exec('COMMIT');

    expect(second.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
  });

  test('a writer that cannot get the lock within the busy timeout fails without corrupting anything', () => {
    const file = join(dir, 'busy.sqlite');
    const holder = connect(file);
    const waiter = connect(file, 5);
    holder.exec('CREATE TABLE t (a INTEGER NOT NULL) STRICT');

    holder.exec('BEGIN IMMEDIATE');
    holder.run('INSERT INTO t (a) VALUES (?)', 1);
    expect(() => waiter.transaction(() => waiter.run('INSERT INTO t (a) VALUES (?)', 2))).toThrow(
      /locked/,
    );
    holder.exec('COMMIT');

    waiter.transaction(() => waiter.run('INSERT INTO t (a) VALUES (?)', 3));
    expect(holder.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 1 }, { a: 3 }]);
  });
});

test('close is idempotent', () => {
  const db = openConnection({ file: IN_MEMORY });

  db.close();

  expect(() => db.close()).not.toThrow();
});
