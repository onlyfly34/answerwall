import { afterEach, describe, expect, test } from 'vitest';
import { FakeClock } from '../../testing/index.ts';
import {
  createTreeKiller,
  KILL_GRACE_MS,
  killChildProcessTrees,
  watchChildProcessTrees,
} from './kill-tree.ts';

function setup(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, graceMs?: number) {
  const clock = new FakeClock();
  const signals: [number, NodeJS.Signals][] = [];
  const helpers: [string, string[]][] = [];
  const waitedHelpers: [string, string[]][] = [];
  const killer = createTreeKiller(4321, {
    platform,
    clock,
    env,
    ...(graceMs === undefined ? {} : { graceMs }),
    killGroup: (pid, signal) => signals.push([pid, signal]),
    run: (file, args) => helpers.push([file, args]),
    runSync: (file, args) => waitedHelpers.push([file, args]),
  });
  return { clock, signals, helpers, waitedHelpers, killer };
}

// The registry is module state: leave it empty for the next test.
afterEach(() => killChildProcessTrees());

describe('createTreeKiller on POSIX', () => {
  test('sends SIGTERM to the group, then SIGKILL after the grace period', async () => {
    const { clock, signals, killer } = setup('linux');

    killer.terminate();
    expect(signals).toEqual([[4321, 'SIGTERM']]);

    await clock.advance(KILL_GRACE_MS - 1);
    expect(signals).toHaveLength(1);

    await clock.advance(1);
    expect(signals).toEqual([
      [4321, 'SIGTERM'],
      [4321, 'SIGKILL'],
    ]);
  });

  test('the grace period is 3 seconds by default and configurable', async () => {
    expect(KILL_GRACE_MS).toBe(3000);
    const { clock, signals, killer } = setup('linux', {}, 50);

    killer.terminate();
    await clock.advance(50);

    expect(signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('terminate is idempotent', async () => {
    const { clock, signals, killer } = setup('linux');

    killer.terminate();
    killer.terminate();
    await clock.advance(KILL_GRACE_MS);

    expect(signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('sweep kills what is left at once and cancels the pending escalation', async () => {
    const { clock, signals, killer } = setup('linux');

    killer.terminate();
    killer.sweep();
    expect(signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);

    await clock.advance(KILL_GRACE_MS * 2);
    expect(signals).toHaveLength(2);
    expect(clock.pendingTimers).toBe(0);
  });

  test('the group outlives its root, so it is still stopped after the root has ended', async () => {
    const { clock, signals, killer } = setup('linux');

    killer.rootExited();
    killer.terminate();
    await clock.advance(KILL_GRACE_MS);

    expect(signals.map(([, signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('never starts a helper process', () => {
    const { helpers, killer } = setup('darwin');

    killer.terminate();
    killer.sweep();

    expect(helpers).toEqual([]);
  });
});

describe('createTreeKiller on Windows', () => {
  test('runs taskkill /T /F on the pid, from the system directory, without waiting', () => {
    const { clock, signals, helpers, killer } = setup('win32', { SYSTEMROOT: 'C:\\Windows' });

    killer.terminate();

    expect(helpers).toEqual([
      ['C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4321']],
    ]);
    expect(signals).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  test('falls back to the bare command when the system directory is unknown', () => {
    const { helpers, killer } = setup('win32');

    killer.terminate();

    expect(helpers).toEqual([['taskkill', ['/T', '/F', '/PID', '4321']]]);
  });

  test('terminate is idempotent and sweep does nothing', () => {
    const { signals, helpers, killer } = setup('win32');

    killer.terminate();
    killer.terminate();
    killer.sweep();

    expect(helpers).toHaveLength(1);
    expect(signals).toEqual([]);
  });

  test('once the root has ended its pid is never killed: the number may belong to another process', () => {
    const { helpers, waitedHelpers, killer } = setup('win32', { SYSTEMROOT: 'C:\\Windows' });

    killer.rootExited();
    killer.terminate();
    killChildProcessTrees();
    killer.sweep();

    expect(helpers).toEqual([]);
    expect(waitedHelpers).toEqual([]);
  });
});

describe('killChildProcessTrees', () => {
  test('kills every tree whose slot is unfinished outright, without waiting for a timer', () => {
    const { clock, signals, killer } = setup('linux');
    killer.terminate();

    killChildProcessTrees();

    expect(signals).toEqual([
      [4321, 'SIGTERM'],
      [4321, 'SIGKILL'],
    ]);
    expect(clock.pendingTimers).toBe(1);
  });

  test('also kills a tree whose root was never asked to stop', () => {
    const { signals } = setup('darwin');

    killChildProcessTrees();

    expect(signals).toEqual([[4321, 'SIGKILL']]);
  });

  test('leaves a tree alone once its slot has finished', () => {
    const { signals, killer } = setup('linux');
    killer.sweep();
    signals.length = 0;

    killChildProcessTrees();

    expect(signals).toEqual([]);
  });

  test('kills each tree once', () => {
    const { signals } = setup('linux');

    killChildProcessTrees();
    killChildProcessTrees();

    expect(signals).toEqual([[4321, 'SIGKILL']]);
  });

  test('on Windows runs taskkill /T /F and waits for it', () => {
    const { helpers, waitedHelpers } = setup('win32', { SYSTEMROOT: 'C:\\Windows' });

    killChildProcessTrees();

    expect(helpers).toEqual([]);
    expect(waitedHelpers).toEqual([
      ['C:\\Windows\\System32\\taskkill.exe', ['/T', '/F', '/PID', '4321']],
    ]);
  });

  test('a kill that throws does not spare the other trees', () => {
    const clock = new FakeClock();
    const signals: number[] = [];
    createTreeKiller(1, {
      platform: 'linux',
      clock,
      env: {},
      killGroup: () => {
        throw new Error('boom');
      },
    });
    createTreeKiller(2, {
      platform: 'linux',
      clock,
      env: {},
      killGroup: (pid) => signals.push(pid),
    });

    killChildProcessTrees();

    expect(signals).toEqual([2]);
  });
});

describe('watchChildProcessTrees', () => {
  function watch() {
    const seen: [number, string][] = [];
    const stop = watchChildProcessTrees((pid, state) => seen.push([pid, state]));
    return { seen, stop };
  }

  test('reports a tree when it is registered and when its slot has finished', () => {
    const { seen, stop } = watch();
    const { killer } = setup('linux');
    expect(seen).toEqual([[4321, 'started']]);

    killer.terminate();
    killer.rootExited();
    expect(seen).toHaveLength(1);

    killer.sweep();
    killer.sweep();
    expect(seen).toEqual([
      [4321, 'started'],
      [4321, 'finished'],
    ]);
    stop();
  });

  test('on Windows the tree is finished as soon as its root has exited', () => {
    const { seen, stop } = watch();
    const { killer } = setup('win32');

    killer.rootExited();
    killer.sweep();

    expect(seen).toEqual([
      [4321, 'started'],
      [4321, 'finished'],
    ]);
    stop();
  });

  test('reports the trees killed at once as finished', () => {
    const { seen, stop } = watch();
    const { killer } = setup('linux');

    killChildProcessTrees();
    killer.sweep();

    expect(seen).toEqual([
      [4321, 'started'],
      [4321, 'finished'],
    ]);
    stop();
  });

  test('a new watcher first hears of the trees that are already running', () => {
    setup('linux');
    const { seen, stop } = watch();

    expect(seen).toEqual([[4321, 'started']]);
    stop();
  });

  test('reports nothing after it was stopped, and a watcher that throws is ignored', () => {
    const { seen, stop } = watch();
    stop();
    const stopFailing = watchChildProcessTrees(() => {
      throw new Error('boom');
    });

    const { signals, killer } = setup('linux');
    killer.sweep();

    expect(seen).toEqual([]);
    expect(signals).toEqual([[4321, 'SIGKILL']]);
    stopFailing();
  });
});
