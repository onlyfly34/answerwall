import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  killProcessTree,
  processExists,
  recordedProcesses,
  runningProcesses,
} from './leftovers.mjs';

let workDir: string;
const started: ChildProcess[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'mock-leftovers-test-'));
});
afterEach(async () => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  await rm(workDir, { recursive: true, force: true });
});

/** A process that stays until it is killed; resolves once it runs. */
async function idleProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', "console.log('up'); setInterval(() => {}, 1000);"], {
    stdio: ['ignore', 'pipe', 'ignore'],
    // Its own group, as the server starts a CLI, so that the tree kill has something to address.
    detached: process.platform !== 'win32',
  });
  started.push(child);
  await once(child.stdout ?? child, 'data');
  if (child.pid === undefined) throw new Error('the process did not start');
  return child.pid;
}

async function gone(pid: number): Promise<void> {
  for (const deadline = Date.now() + 10_000; processExists(pid);) {
    if (Date.now() > deadline) throw new Error(`process ${pid} is still there`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('recordedProcesses', () => {
  test('reads the mocks and their children, with the latest time of each number', async () => {
    const log = path.join(workDir, 'log.jsonl');
    await writeFile(
      log,
      [
        { kind: 'claude', pid: 11, at: 1000 },
        { grandchildPid: 12, at: 1500 },
        { kind: 'grok', pid: 11, at: 3000 },
        { kind: 'codex', pid: 13, at: 2000 },
      ]
        .map((entry) => `${JSON.stringify(entry)}\n`)
        .join('\n'),
    );

    expect(recordedProcesses(log)).toEqual([
      { pid: 11, at: 3000 },
      { pid: 12, at: 1500 },
      { pid: 13, at: 2000 },
    ]);
  });

  test('a log that was never written holds nothing', () => {
    expect(recordedProcesses(path.join(workDir, 'missing.jsonl'))).toEqual([]);
  });
});

describe('runningProcesses', () => {
  test('reports a recorded process while it runs and no longer once it has been killed', async () => {
    const pid = await idleProcess();
    const record = { pid, at: Date.now() };

    expect(await runningProcesses([record])).toEqual([pid]);

    killProcessTree(pid);
    await gone(pid);
    expect(await runningProcesses([record])).toEqual([]);
  });

  // Elsewhere a process id is not handed out again while a suite runs, so
  // only Windows compares the creation time; see the module's first comment.
  test.runIf(process.platform === 'win32')(
    'leaves out a number that belongs to a process created after the record was written',
    async () => {
      const before = Date.now() - 60_000;
      const pid = await idleProcess();

      expect(await runningProcesses([{ pid, at: before }])).toEqual([]);
      expect(await runningProcesses([{ pid, at: Date.now() }])).toEqual([pid]);
    },
  );

  test('nothing recorded, nothing running', async () => {
    expect(await runningProcesses([])).toEqual([]);
  });
});
