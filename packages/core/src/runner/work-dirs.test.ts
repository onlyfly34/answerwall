import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createMemoryLogger } from '../testing/index.ts';
import { createWorkDirs, describeError, WorkRootInUseError } from './work-dirs.ts';

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

// ---- one owner per root ----

test('a root that is claimed cannot be claimed again until it is released', async () => {
  const root = join(base, 'data', 'work');
  const owner = createWorkDirs(root, createMemoryLogger());
  const second = createWorkDirs(root, createMemoryLogger());
  await owner.claim();
  const dir = await owner.create('ask-1-0');

  await expect(second.claim()).rejects.toBeInstanceOf(WorkRootInUseError);
  await expect(second.claim()).rejects.toThrow(/already running on this data directory/);
  expect(existsSync(dir)).toBe(true);

  await owner.release();
  await second.claim();
  await second.release();
});

test('claiming twice and releasing twice are harmless, and other roots are unaffected', async () => {
  const dirs = createWorkDirs(join(base, 'one', 'work'), createMemoryLogger());
  const other = createWorkDirs(join(base, 'two', 'work'), createMemoryLogger());
  await dirs.claim();
  await dirs.claim();
  await other.claim();

  await dirs.release();
  await dirs.release();
  await other.release();
  await dirs.claim();
  await dirs.release();
});

test('the claim survives a reset and is not kept inside the root', async () => {
  const root = join(base, 'work');
  const owner = createWorkDirs(root, createMemoryLogger());
  await owner.claim();
  await owner.reset();

  expect(await readdir(root)).toEqual([]);
  await expect(createWorkDirs(root, createMemoryLogger()).claim()).rejects.toBeInstanceOf(
    WorkRootInUseError,
  );
  await owner.release();
});

test('a claim held by another process is seen, and ends with that process', async () => {
  const root = join(base, 'work');
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1], { timeout: 0 });
       db.exec('BEGIN EXCLUSIVE');
       process.stdout.write('held');
       setInterval(() => {}, 1000);`,
      `${root}.lock`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  try {
    await once(holder.stdout, 'data');
    const dirs = createWorkDirs(root, createMemoryLogger());
    await expect(dirs.claim()).rejects.toBeInstanceOf(WorkRootInUseError);

    // Killed, not shut down: nothing is left to clean up before the next start.
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    await dirs.claim();
    await dirs.release();
  } finally {
    holder.kill('SIGKILL');
  }
});
