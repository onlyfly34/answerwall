import os from 'node:os';
import { describe, expect, test } from 'vitest';
import { systemClock } from '../../system.ts';
import { FakeClock } from '../../testing/index.ts';
import { collect, isAlive, until } from '../test-harness.ts';
import { KILL_GRACE_MS } from './kill-tree.ts';
import { ABANDON_MS, spawnCli } from './spawn-cli.ts';
import type { CliExit, CliOutput, SpawnCliOptions } from './spawn-cli.ts';

const posixOnly = test.skipIf(process.platform === 'win32');

/** Runs a JavaScript snippet in a real Node child, the way a CLI would be run. */
function options(script: string, overrides: Partial<SpawnCliOptions> = {}): SpawnCliOptions {
  return {
    command: { file: process.execPath, prefixArgs: [] },
    args: ['-e', script],
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
    stdin: null,
    signal: new AbortController().signal,
    clock: systemClock,
    platform: process.platform,
    hostEnv: process.env,
    killGraceMs: 150,
    exitDrainMs: 50,
    ...overrides,
  };
}

const linesOf = (items: CliOutput[]): string[] =>
  items.flatMap((item) => (item.type === 'line' ? [item.text] : []));

function exitOf(items: CliOutput[]): CliExit {
  const last = items.at(-1);
  if (last?.type !== 'exit') throw new Error('the output did not end with an exit item');
  expect(items.filter((item) => item.type === 'exit')).toHaveLength(1);
  return last.exit;
}

/** A child that starts a SIGTERM-ignoring grandchild sharing its stdout, then prints both pids. */
const TREE = `
  const { spawn } = require('node:child_process');
  const stubborn = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ['-e', stubborn], { stdio: ['ignore', 'inherit', 'ignore'] });
  console.log(JSON.stringify({ pid: process.pid, grandchild: child.pid }));
`;

describe('spawnCli', () => {
  test('yields stdout line by line and then the exit with code and stderr', async () => {
    const items = await collect(
      spawnCli(
        options(
          `console.log('one'); console.log('two'); console.error('oops'); process.exitCode = 3;`,
        ),
      ),
    );

    expect(linesOf(items)).toEqual(['one', 'two']);
    expect(exitOf(items)).toEqual({ code: 3, signal: null, stderr: 'oops\n', aborted: false });
  });

  test('writes the prompt to stdin and closes it', async () => {
    const script = `let s = ''; process.stdin.on('data', (d) => (s += d)).on('end', () => console.log(JSON.stringify(s)));`;
    const prompt = `line one\nline "two" — 問題\n${'x'.repeat(200_000)}`;

    const items = await collect(spawnCli(options(script, { stdin: prompt })));

    expect(JSON.parse(linesOf(items)[0] ?? '')).toBe(prompt);
    expect(exitOf(items).code).toBe(0);
  });

  test('closes stdin even for an empty prompt, so a CLI waiting for input ends', async () => {
    const script = `process.stdin.resume().on('end', () => console.log('eof'));`;

    const items = await collect(spawnCli(options(script, { stdin: '' })));

    expect(linesOf(items)).toEqual(['eof']);
  });

  test('gives the child no stdin at all when there is no prompt for it', async () => {
    const script = `process.stdin.resume().on('end', () => console.log('eof'));`;

    const items = await collect(spawnCli(options(script, { stdin: null })));

    expect(linesOf(items)).toEqual(['eof']);
    expect(exitOf(items).code).toBe(0);
  });

  test('survives a child that exits without reading its stdin', async () => {
    const items = await collect(
      spawnCli(options(`process.exit(7)`, { stdin: 'x'.repeat(4 * 1024 * 1024) })),
    );

    expect(exitOf(items).code).toBe(7);
  });

  test('passes arguments verbatim, without a shell', async () => {
    const hostile = ['$(echo injected)', '`id`', '; exit 9', 'a b', '', '"quoted"', '%PATH%', '&&'];
    const items = await collect(
      spawnCli({
        ...options(''),
        args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...hostile],
      }),
    );

    expect(JSON.parse(linesOf(items)[0] ?? '')).toEqual(hostile);
  });

  test('uses the given working directory and exactly the given environment', async () => {
    const cwd = await import('node:fs/promises').then((fs) => fs.realpath(os.tmpdir()));
    const items = await collect(
      spawnCli(
        options(
          `console.log(JSON.stringify({ cwd: process.cwd(), marker: process.env.MARKER, home: process.env.HOME ?? null }))`,
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? '',
              SystemRoot: process.env.SystemRoot ?? '',
              MARKER: 'yes',
            },
          },
        ),
      ),
    );

    expect(JSON.parse(linesOf(items)[0] ?? '')).toEqual({ cwd, marker: 'yes', home: null });
  });

  test('prepends the resolved command arguments (node plus script)', async () => {
    const items = await collect(
      spawnCli({
        ...options(''),
        command: {
          file: process.execPath,
          prefixArgs: ['-e', 'console.log(process.argv.slice(1).join(","))', '--'],
        },
        args: ['a', 'b'],
      }),
    );

    expect(linesOf(items)).toEqual(['a,b']);
  });

  test('does not start anything when the signal is already aborted', async () => {
    const items = await collect(
      spawnCli(options(`console.log('started')`, { signal: AbortSignal.abort() })),
    );

    expect(items).toEqual([
      { type: 'exit', exit: { code: null, signal: null, stderr: '', aborted: true } },
    ]);
  });

  test('reports a command that does not exist as a spawn error', async () => {
    const items = await collect(
      spawnCli({
        ...options(''),
        command: { file: `${os.tmpdir()}/no-such-binary-here`, prefixArgs: [] },
      }),
    );

    const exit = exitOf(items);
    expect(exit.spawnError?.code).toBe('ENOENT');
    expect(exit).toMatchObject({ code: null, aborted: false });
  });

  test('reports a working directory that does not exist as a spawn error', async () => {
    const items = await collect(
      spawnCli(options(`console.log(1)`, { cwd: `${os.tmpdir()}/no-such-dir-here` })),
    );

    expect(exitOf(items).spawnError).toBeDefined();
    expect(linesOf(items)).toEqual([]);
  });

  test('delivers a large output completely and in order', async () => {
    const script = `for (let i = 0; i < 20000; i++) console.log('line ' + i + ' ' + 'x'.repeat(100));`;
    const lines: string[] = [];
    for await (const item of spawnCli(options(script))) {
      if (item.type === 'line') {
        lines.push(item.text);
        // A slow consumer: the child must wait instead of the queue growing without bound.
        if (lines.length % 5000 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }

    expect(lines).toHaveLength(20000);
    expect(lines[0]).toBe(`line 0 ${'x'.repeat(100)}`);
    expect(lines[19999]).toBe(`line 19999 ${'x'.repeat(100)}`);
  });

  test('cuts a line longer than the cap and keeps reading', async () => {
    const script = `process.stdout.write('y'.repeat(300000) + '\\nafter\\n');`;

    const items = await collect(spawnCli(options(script, { maxLineLength: 1000 })));

    expect(items.slice(0, 2)).toEqual([
      { type: 'line', text: 'y'.repeat(1000), truncated: true },
      { type: 'line', text: 'after', truncated: false },
    ]);
  });

  test('yields a last line that has no newline', async () => {
    const items = await collect(spawnCli(options(`process.stdout.write('no newline')`)));

    expect(linesOf(items)).toEqual(['no newline']);
  });

  test('keeps only the end of a noisy stderr', async () => {
    const script = `process.stderr.write('a'.repeat(100000) + 'THE END'); console.log('ok');`;

    const items = await collect(spawnCli(options(script, { maxStderrLength: 50 })));

    const exit = exitOf(items);
    expect(exit.stderr).toHaveLength(50);
    expect(exit.stderr.endsWith('THE END')).toBe(true);
    expect(linesOf(items)).toEqual(['ok']);
  });

  posixOnly('reports the signal that ended the child', async () => {
    const items = await collect(spawnCli(options(`process.kill(process.pid, 'SIGKILL')`)));

    expect(exitOf(items)).toMatchObject({ code: null, signal: 'SIGKILL', aborted: false });
  });

  test('abort kills the child and everything it started, even what ignores SIGTERM', async () => {
    const stop = new AbortController();
    const items: CliOutput[] = [];
    let pids: { pid: number; grandchild: number } | undefined;

    for await (const item of spawnCli(
      options(`${TREE} setInterval(() => {}, 1000);`, { signal: stop.signal }),
    )) {
      items.push(item);
      if (item.type === 'line') {
        pids = JSON.parse(item.text) as { pid: number; grandchild: number };
        expect(isAlive(pids.pid) && isAlive(pids.grandchild)).toBe(true);
        stop.abort();
      }
    }

    expect(exitOf(items).aborted).toBe(true);
    if (pids === undefined) throw new Error('the child never reported its pids');
    const { pid, grandchild } = pids;
    await until(() => !isAlive(pid) && !isAlive(grandchild));
  });

  test('a consumer that stops early leaves no process behind', async () => {
    let pids: { pid: number; grandchild: number } | undefined;

    for await (const item of spawnCli(options(`${TREE} setInterval(() => {}, 1000);`))) {
      if (item.type === 'line') {
        pids = JSON.parse(item.text) as { pid: number; grandchild: number };
        break;
      }
    }

    if (pids === undefined) throw new Error('the child never reported its pids');
    const { pid, grandchild } = pids;
    // `break` returns only after the child is gone.
    expect(isAlive(pid)).toBe(false);
    await until(() => !isAlive(grandchild));
  });

  posixOnly(
    'ends when the CLI has exited although a descendant keeps stdout open, and removes it',
    async () => {
      const items = await collect(spawnCli(options(`${TREE} process.exit(0);`)));

      expect(exitOf(items)).toMatchObject({ code: 0, aborted: false });
      const { grandchild } = JSON.parse(linesOf(items)[0] ?? '') as { grandchild: number };
      await until(() => !isAlive(grandchild));
    },
  );

  posixOnly('gives up on a process that cannot be killed instead of waiting forever', async () => {
    const clock = new FakeClock();
    const stop = new AbortController();
    const signalled: number[] = [];
    const output = spawnCli(
      options(`console.log('ready'); setInterval(() => {}, 1000);`, {
        signal: stop.signal,
        clock,
        killGraceMs: KILL_GRACE_MS,
        killer: { killGroup: (pid) => signalled.push(pid) },
      }),
    );

    try {
      expect(await output.next()).toMatchObject({ value: { type: 'line', text: 'ready' } });
      stop.abort();
      const next = output.next();
      await clock.advance(KILL_GRACE_MS + ABANDON_MS);

      expect(await next).toEqual({
        done: false,
        value: { type: 'exit', exit: { code: null, signal: null, stderr: '', aborted: true } },
      });
      expect((await output.next()).done).toBe(true);
      expect(clock.pendingTimers).toBe(0);
    } finally {
      for (const pid of new Set(signalled)) process.kill(-pid, 'SIGKILL');
    }
  });
});
