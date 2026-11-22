import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const REAPER = fileURLToPath(new URL('./reaper.ts', import.meta.url));
const IDLE = 'setInterval(() => {}, 1000)';

const started: ChildProcess[] = [];
const temporary: string[] = [];
afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A stand-in for a CLI: like the real ones, it leads its own process group. */
async function startVictim(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', IDLE], {
    stdio: 'ignore',
    detached: true,
  });
  started.push(child);
  await once(child, 'spawn');
  return child as ChildProcess & { pid: number };
}

/** The reaper as the core host starts it: stdin is a pipe, nothing else is connected. */
async function startReaper(): Promise<ChildProcess> {
  const reaper = spawn(process.execPath, [REAPER], { stdio: ['pipe', 'ignore', 'ignore'] });
  started.push(reaper);
  await once(reaper, 'spawn');
  return reaper;
}

const exitOf = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const isRunning = (child: ChildProcess): boolean =>
  child.exitCode === null && child.signalCode === null;

// Windows has no reaper: the system ends the children there (see `reaper.ts`).
describe.skipIf(process.platform === 'win32')('the reaper', () => {
  test('kills the registered trees when its stdin ends, then exits', async () => {
    const [first, second] = [await startVictim(), await startVictim()];
    const reaper = await startReaper();

    reaper.stdin?.write(`+${first.pid}\n+${second.pid}\n`);
    await sleep(200);
    expect(isRunning(first) && isRunning(second) && isRunning(reaper)).toBe(true);

    reaper.stdin?.end();

    await Promise.all([exitOf(first), exitOf(second), exitOf(reaper)]);
    expect(reaper.exitCode).toBe(0);
  }, 20_000);

  test('spares a tree that was reported as finished, and anything it was never told about', async () => {
    const [finished, stranger, live] = [
      await startVictim(),
      await startVictim(),
      await startVictim(),
    ];
    const reaper = await startReaper();

    reaper.stdin?.write(`+${finished.pid}\n+${live.pid}\n-${finished.pid}\n`);
    reaper.stdin?.end();

    await Promise.all([exitOf(live), exitOf(reaper)]);
    await sleep(200);
    expect(isRunning(finished)).toBe(true);
    expect(isRunning(stranger)).toBe(true);
  }, 20_000);

  test('ignores lines that are not a process id it could have been given', async () => {
    const victim = await startVictim();
    const reaper = await startReaper();

    reaper.stdin?.write(
      [
        '+0',
        '+1',
        '-1',
        '+-5',
        '+abc',
        `+${victim.pid} extra`,
        'kill everything',
        '',
        '+99999999999',
      ].join('\n') + '\n',
    );
    reaper.stdin?.end();

    await exitOf(reaper);
    await sleep(200);
    expect(reaper.exitCode).toBe(0);
    expect(isRunning(victim)).toBe(true);
    // This test process and its group were not touched either.
    expect(process.pid).toBeGreaterThan(1);
  }, 20_000);

  test('a registration split over two writes still counts', async () => {
    const victim = await startVictim();
    const reaper = await startReaper();
    const text = `+${victim.pid}\n`;

    reaper.stdin?.write(text.slice(0, 2));
    await sleep(50);
    reaper.stdin?.write(text.slice(2));
    reaper.stdin?.end();

    await Promise.all([exitOf(victim), exitOf(reaper)]);
  }, 20_000);

  test('dies with the process that feeds it, however that one ends', async () => {
    const victim = await startVictim();
    // A feeder that starts the reaper, registers the victim and is then killed outright:
    // what the core host is to the reaper when the app's main process is killed.
    const dir = await mkdtemp(path.join(tmpdir(), 'reaper-feeder-'));
    temporary.push(dir);
    const script = path.join(dir, 'feeder.cjs');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        'const [reaperScript, pid] = process.argv.slice(2);',
        'const reaper = spawn(process.execPath, [reaperScript], {',
        "  stdio: ['pipe', 'ignore', 'ignore'],",
        '  detached: true,',
        '});',
        "reaper.on('spawn', () => {",
        "  reaper.stdin.write('+' + pid + '\\n', () => process.stdout.write('ready\\n'));",
        '});',
        `${IDLE};`,
      ].join('\n'),
    );
    const feeder = spawn(process.execPath, [script, REAPER, String(victim.pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.push(feeder);
    let errors = '';
    feeder.stderr.setEncoding('utf8').on('data', (text: string) => (errors += text));
    await Promise.race([
      once(feeder.stdout, 'data'),
      once(feeder, 'exit').then(() => {
        throw new Error(`The feeder ended early: ${errors}`);
      }),
    ]);
    // Time for the reaper to have read its line: a pipe that is cut may drop what is unread.
    await sleep(500);

    feeder.kill('SIGKILL');

    await exitOf(victim);
  }, 30_000);
});
