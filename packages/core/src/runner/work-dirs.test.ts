import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createMemoryLogger } from '../testing/index.ts';
import { createWorkDirs, describeError } from './work-dirs.ts';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'work-dirs-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

test('reset creates the root and removes what a previous process left', async () => {
  const root = join(base, 'data', 'work');
  const dirs = createWorkDirs(root, createMemoryLogger());
  await dirs.reset();
  expect(await readdir(root)).toEqual([]);

  await mkdir(join(root, 'left-over', 'nested'), { recursive: true });
  await writeFile(join(root, 'left-over', 'nested', 'prompt.txt'), 'old');
  await dirs.reset();
  expect(await readdir(root)).toEqual([]);
});

test('create gives an empty directory even when the name was used before', async () => {
  const dirs = createWorkDirs(join(base, 'work'), createMemoryLogger());
  const dir = await dirs.create('ask-1-0');
  expect(dir).toBe(join(base, 'work', 'ask-1-0'));
  await writeFile(join(dir, 'prompt.txt'), 'hello');

  expect(await dirs.create('ask-1-0')).toBe(dir);
  expect(await readdir(dir)).toEqual([]);
});

test('remove deletes the directory with its content and tolerates a missing one', async () => {
  const dirs = createWorkDirs(join(base, 'work'), createMemoryLogger());
  const dir = await dirs.create('ask-1-0');
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'file'), 'x');

  await dirs.remove(dir);
  expect(existsSync(dir)).toBe(false);
  await dirs.remove(dir);
});

test('a failed removal is logged without the path, never thrown', async () => {
  const logger = createMemoryLogger();
  const dirs = createWorkDirs(join(base, 'work'), logger);
  await dirs.remove('\0invalid');
  expect(logger.entries).toHaveLength(1);
  expect(logger.entries[0]).toMatchObject({
    level: 'warn',
    fields: { error: 'ERR_INVALID_ARG_VALUE' },
  });
  expect(JSON.stringify(logger.entries)).not.toContain('invalid\\u0000');
});

test('errors are described by code or name only', () => {
  expect(describeError(Object.assign(new Error('/secret/path missing'), { code: 'ENOENT' }))).toBe(
    'ENOENT',
  );
  expect(describeError(new TypeError('/secret/path'))).toBe('TypeError');
  expect(describeError('boom')).toBe('string');
});
