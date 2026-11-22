import { describe, expect, test } from 'vitest';
import { FakeClock } from '../../testing/index.ts';
import { createTreeKiller, KILL_GRACE_MS } from './kill-tree.ts';

function setup(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, graceMs?: number) {
  const clock = new FakeClock();
  const signals: [number, NodeJS.Signals][] = [];
  const helpers: [string, string[]][] = [];
  const killer = createTreeKiller(4321, {
    platform,
    clock,
    env,
    ...(graceMs === undefined ? {} : { graceMs }),
    killGroup: (pid, signal) => signals.push([pid, signal]),
    run: (file, args) => helpers.push([file, args]),
  });
  return { clock, signals, helpers, killer };
}

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
});
