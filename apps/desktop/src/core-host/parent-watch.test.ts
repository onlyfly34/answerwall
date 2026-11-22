import { describe, expect, test } from 'vitest';
import { PARENT_CHECK_MS, SILENT_CHECKS, watchParentProcess } from './parent-watch.ts';

const MAIN = 4242;

/** A system with a main process, as the core host sees it. */
function setup(options: { identities?: boolean } = {}) {
  const system = {
    /** `process.ppid` of the host. */
    ppid: MAIN,
    /** Which process holds which id: its creation time. */
    processes: new Map<number, string>([[MAIN, '133800000000000000']]),
    identifyFails: false,
  };
  let tick: () => void = () => undefined;
  let interval = 0;
  let stopped = false;
  let identified = 0;
  let gone = 0;

  const watch = watchParentProcess(
    {
      parentPid: () => system.ppid,
      exists: (pid) => system.processes.has(pid),
      async identify(pid) {
        identified += 1;
        if (system.identifyFails) throw new Error('no PowerShell');
        return options.identities === false ? undefined : system.processes.get(pid);
      },
      every(ms, task) {
        interval = ms;
        tick = task;
        return () => {
          stopped = true;
        };
      },
    },
    () => void (gone += 1),
  );

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  /** The time of `count` checks passes. */
  const checks = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
      tick();
      await settle();
    }
  };
  return {
    system,
    watch,
    checks,
    settle,
    gone: () => gone,
    interval: () => interval,
    stopped: () => stopped,
    identified: () => identified,
  };
}

describe('watchParentProcess', () => {
  test('nothing happens while the main process is there and talks', async () => {
    const host = setup();
    await host.settle();

    for (let round = 0; round < 20; round += 1) {
      host.watch.heard();
      await host.checks(1);
    }

    expect(host.interval()).toBe(PARENT_CHECK_MS);
    expect(host.gone()).toBe(0);
    // Its identity was read once, at the start, and never needed again.
    expect(host.identified()).toBe(1);
  });

  test('a main process that no longer exists is gone at the next check', async () => {
    const host = setup();
    await host.settle();

    host.system.processes.delete(MAIN);
    await host.checks(3);

    expect(host.gone()).toBe(1);
    expect(host.stopped()).toBe(true);
  });

  test('POSIX: adopted by another process means the main process has ended', async () => {
    const host = setup();
    await host.settle();

    host.system.ppid = 1;
    host.system.processes.set(1, '1');
    await host.checks(1);

    expect(host.gone()).toBe(1);
  });

  test('Windows: an unrelated process that got the main process’s id does not pass for it', async () => {
    const host = setup();
    await host.settle();
    await host.checks(3);
    host.watch.heard();

    // The main process is killed, and before the next check its id is taken.
    host.system.processes.set(MAIN, '133800009990000000');
    await host.checks(SILENT_CHECKS - 1);
    expect(host.gone()).toBe(0);

    await host.checks(1);
    expect(host.gone()).toBe(1);
    expect(host.stopped()).toBe(true);
  });

  test('a main process that is only busy for a long time is not taken for dead', async () => {
    const host = setup();
    await host.settle();
    host.watch.heard();

    // Minutes without a message, in a menu or a window drag.
    await host.checks(SILENT_CHECKS * 30);

    expect(host.gone()).toBe(0);
    // Looked at once per stretch of silence, not at every check.
    expect(host.identified()).toBe(1 + 30);

    host.watch.heard();
    await host.checks(SILENT_CHECKS - 1);
    expect(host.identified()).toBe(1 + 30);
  });

  test('silence is no sign before the main process has ever sent anything', async () => {
    const host = setup();
    await host.settle();

    host.system.processes.set(MAIN, 'another');
    await host.checks(SILENT_CHECKS * 3);

    expect(host.gone()).toBe(0);
    expect(host.identified()).toBe(1);
  });

  test('where processes cannot be told apart, only a missing process counts', async () => {
    const host = setup({ identities: false });
    await host.settle();
    host.watch.heard();

    await host.checks(SILENT_CHECKS * 3);
    expect(host.gone()).toBe(0);
    expect(host.identified()).toBe(1);

    host.system.processes.delete(MAIN);
    await host.checks(1);
    expect(host.gone()).toBe(1);
  });

  test('an identity that cannot be read later is not a different one', async () => {
    const host = setup();
    await host.settle();
    host.watch.heard();

    host.system.identifyFails = true;
    await host.checks(SILENT_CHECKS * 2);

    expect(host.gone()).toBe(0);
  });

  test('gone is said once', async () => {
    const host = setup();
    await host.settle();

    host.system.processes.delete(MAIN);
    await host.checks(4);

    expect(host.gone()).toBe(1);
  });
});
