import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { launchArgs, launchEnv } from '../support/app.ts';
import type { DesktopApp } from '../support/app.ts';
import { arrange, expect, send, showCell, test, until } from '../support/fixtures.ts';
import type { Page } from '@playwright/test';
import { killHard, processesMentioning } from '../support/processes.ts';

/**
 * Starts three CLI runs that never end by themselves: one that hangs, one
 * that started a child ignoring SIGTERM, one that ignores SIGTERM itself.
 * Returns the process ids the mocks recorded, their children included.
 */
async function startStubbornRuns(app: DesktopApp, page: Page): Promise<number[]> {
  await arrange(page, [
    { slotId: 'a', providerId: 'claude', model: 'mock-hang' },
    { slotId: 'b', providerId: 'codex', model: 'mock-tree' },
    { slotId: 'c', providerId: 'grok', model: 'mock-stubborn-tree' },
  ]);
  await send(page, 'Never answered');
  await expect(await showCell(page, 'a')).toHaveAttribute('data-phase', /waiting|streaming/);

  return until(
    'the mock CLIs and their children to be running',
    async () => {
      const children = app.mockInvocations().filter((call) => call.grandchildPid !== undefined);
      if (children.length < 2) return undefined;
      // Three CLIs and the two children.
      const live = await app.liveMockPids();
      return live.length >= 5 ? live : undefined;
    },
    30_000,
  );
}

test.describe('the end of the app', () => {
  test('quitting stops the local server and every CLI child', async ({ local }) => {
    const { app, page } = local;
    const pids = await startStubbornRuns(app, page);
    expect(pids.length).toBeGreaterThanOrEqual(5);
    expect((await app.processes()).length).toBeGreaterThan(1);
    expect(await processesMentioning('reaper.cjs')).not.toEqual([]);

    await app.quit();

    await until('every process of the app to be gone', async () => {
      return (await app.processes()).length === 0;
    });
    expect(await app.liveMockPids()).toEqual([]);
    await until('the helper process to be gone', async () => {
      return (await processesMentioning('reaper.cjs')).length === 0;
    });
    // A clean stop: the server shut down itself, nobody had to kill it.
    const log = await app.log();
    expect(log).toContain('"msg":"the local server exited","source":"shell","code":0');
    expect(log).not.toContain('did not stop in time');
  });

  test('closing the last window quits the app', async ({ local }) => {
    const { app, page } = local;
    const closed = app.electron.waitForEvent('close', { timeout: 60_000 });

    await page.close();

    await closed;
    await until('every process of the app to be gone', async () => {
      return (await app.processes()).length === 0;
    });
  });

  test('when the main process is killed, no CLI child is left behind', async ({ local }) => {
    const { app, page } = local;
    const pids = await startStubbornRuns(app, page);
    expect(pids.length).toBeGreaterThanOrEqual(5);
    const closed = app.electron.waitForEvent('close', { timeout: 60_000 });

    // No handler runs: this is what a crash of the main process looks like to the rest.
    await killHard(app.pid);
    await closed;

    await until(
      'the CLI children to be gone',
      async () => (await app.liveMockPids()).length === 0,
      30_000,
    );
    await until(
      'every process of the app to be gone',
      async () => (await app.processes()).length === 0,
      30_000,
    );
    await until('the helper process to be gone', async () => {
      return (await processesMentioning('reaper.cjs')).length === 0;
    });
  });

  test('a second start hands over to the running app and starts nothing of its own', async ({
    local,
    profile,
  }) => {
    const { app, page, origin } = local;
    const before = (await app.processes()).length;

    const { executablePath, args } = launchArgs(profile);
    const second = spawn(executablePath, args, {
      env: launchEnv(profile),
      cwd: profile.dir,
      stdio: 'ignore',
    });
    const [code] = (await Promise.race([
      once(second, 'exit'),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => {
          second.kill('SIGKILL');
          reject(new Error('The second instance kept running'));
        }, 30_000),
      ),
    ])) as [number | null];
    expect(code).toBe(0);

    // One app, one local server, the same window.
    await until('the second instance to be gone', async () => {
      return (await app.processes()).length <= before;
    });
    expect(app.electron.windows().filter((window) => !window.isClosed())).toHaveLength(1);
    expect(new URL(page.url()).origin).toBe(origin);
    const log = await app.log();
    expect(log.match(/the local server is listening/g)).toHaveLength(1);
  });
});
