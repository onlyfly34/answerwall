import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '@answerwall/core';
import { API_PATHS } from '@answerwall/core/protocol';
import { SHUTDOWN_MESSAGE } from './process-runtime.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls `probe` every 50 ms until it gives a value; fails after 10 s. */
async function until<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('gave up waiting');
}

/**
 * The entry point as a real process, run from source. Only what needs a
 * process is tested here: its output streams and its supervisor.
 */
describe('the server process', () => {
  let directory: string;
  let child: ChildProcess | undefined;
  /** Process groups of mock CLIs a test started; ended whatever the test's outcome. */
  let groups: number[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), `${BRAND.slug}-main-`));
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGKILL');
      await gone;
    }
    child = undefined;
    for (const pid of groups) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, as it should be.
      }
    }
    groups = [];
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Starts the server with an IPC channel and resolves with its URL once it listens. */
  async function start(
    options: { path?: string; env?: NodeJS.ProcessEnv } = {},
  ): Promise<{ process: ChildProcess; url: string; exit: Promise<number>; output: () => string }> {
    // Startup detection must find no real CLI on the machine running the tests.
    const emptyBin = join(directory, 'bin');
    const webRoot = join(directory, 'web');
    await mkdir(emptyBin);
    await mkdir(webRoot);
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>shell</title>');

    const started = spawn(
      process.execPath,
      ['--conditions=answerwall-source', fileURLToPath(new URL('./main.ts', import.meta.url))],
      {
        env: {
          ...options.env,
          PATH: options.path ?? emptyBin,
          ...(process.env['SystemRoot'] === undefined
            ? {}
            : { SystemRoot: process.env['SystemRoot'] }),
          [`${BRAND.envPrefix}DATA_DIR`]: join(directory, 'data'),
          [`${BRAND.envPrefix}WEB_ROOT`]: webRoot,
          [`${BRAND.envPrefix}PORT`]: '0',
          [`${BRAND.envPrefix}LOG_FORMAT`]: 'json',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    child = started;
    const exit = new Promise<number>((resolve) =>
      started.once('exit', (code) => resolve(code ?? -1)),
    );

    let output = '';
    const url = await new Promise<string>((resolve, reject) => {
      started.stdout?.setEncoding('utf8');
      started.stdout?.on('data', (piece: string) => {
        output += piece;
        const found = /"url":"(http:[^"]+)"/.exec(output)?.[1];
        if (found !== undefined) resolve(found);
      });
      void exit.then((code) => reject(new Error(`exited with ${code} before listening`)));
    });
    return { process: started, url, exit, output: () => output };
  }

  test('survives the reader of its output going away, and still shuts down cleanly', async () => {
    const server = await start();

    server.process.stdout?.destroy();
    server.process.stderr?.destroy();
    // Each request writes a log line into the closed pipe.
    for (let request = 0; request < 3; request++) {
      expect((await fetch(new URL(API_PATHS.meta, server.url))).status).toBe(200);
    }
    server.process.send(SHUTDOWN_MESSAGE);

    expect(await server.exit).toBe(0);
  }, 30_000);

  test('shuts down when its supervisor disconnects', async () => {
    const server = await start();

    server.process.disconnect();

    expect(await server.exit).toBe(0);
  }, 30_000);
  // POSIX only: Windows cannot send a signal to another process, and its
  // `taskkill /F` is forceful from the start, so there is no grace to skip.
  test.skipIf(process.platform === 'win32')(
    'a second signal kills a child process tree that ignores SIGTERM before exiting',
    async () => {
      const mockBin = fileURLToPath(new URL('../../../tools/mock-clis/bin', import.meta.url));
      const nodeBin = join(directory, 'node-bin');
      const mockLog = join(directory, 'mock.jsonl');
      await mkdir(nodeBin);
      await symlink(process.execPath, join(nodeBin, 'node'));
      const token = 'main-test-token-0123456789abcdef0123456789';
      const server = await start({
        path: [mockBin, nodeBin].join(delimiter),
        env: {
          HOME: directory,
          MOCK_CLI_LOG: mockLog,
          [`${BRAND.envPrefix}TOKEN`]: token,
        },
      });

      const response = await fetch(new URL(API_PATHS.ask, server.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Start a tree.',
          targets: [{ slotId: 't1', providerId: 'claude', model: 'mock-tree' }],
        }),
      });
      expect(response.status).toBe(200);
      // The mock logs its invocation, then the pid of the child it started.
      const pids = await until(async () => {
        const text = await readFile(mockLog, 'utf8').catch(() => '');
        const entries = text
          .split('\n')
          .filter((line) => line !== '')
          .map(
            (line) =>
              JSON.parse(line) as { pid?: number; scenario?: string; grandchildPid?: number },
          );
        const root = entries.find((entry) => entry.scenario === 'tree')?.pid;
        const grandchild = entries.find(
          (entry) => entry.grandchildPid !== undefined,
        )?.grandchildPid;
        return root === undefined || grandchild === undefined ? undefined : [root, grandchild];
      });
      // The tree is its own process group, led by the mock.
      groups.push(pids[0] ?? 0);

      server.process.kill('SIGTERM');
      // Two signals sent at once can arrive as one.
      await until(async () => (/"shutting down"/.test(server.output()) ? true : undefined));
      server.process.kill('SIGTERM');

      expect(await server.exit).toBe(1);
      // SIGKILL was sent before the exit; give the kernel a moment to reap.
      await until(async () => (pids.every((pid) => !isAlive(pid)) ? true : undefined));
    },
    30_000,
  );
});
