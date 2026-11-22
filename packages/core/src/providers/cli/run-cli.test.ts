import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderEvent } from '../../contracts/index.ts';
import {
  answerOf,
  collect,
  createMockCliHarness,
  isAlive,
  noticesOf,
  typesOf,
  until,
} from '../test-harness.ts';
import type { MockCliHarness } from '../test-harness.ts';
import { isRecord, parseJsonLine, runCli } from './run-cli.ts';
import type { CliInvocation, StreamParser } from './run-cli.ts';

/** Understands the mock grok CLI's output just enough to exercise the runner. */
function simpleParser(): StreamParser {
  let completed = false;
  let failure: string | undefined;
  return {
    event(value) {
      if (value.type === 'text' && typeof value.data === 'string') {
        return [{ type: 'delta', text: value.data }];
      }
      if (value.type === 'end') completed = true;
      if (value.type === 'error' && typeof value.message === 'string') failure = value.message;
      return [];
    },
    outcome: () => ({
      completed,
      ...(completed ? { usage: { inputTokens: 1, outputTokens: 2 } } : {}),
      ...(failure === undefined ? {} : { failure: { message: failure } }),
    }),
  };
}

let harness: MockCliHarness;
beforeEach(async () => {
  harness = await createMockCliHarness();
});
afterEach(() => harness.cleanup());

/** An invocation of the mock grok CLI, which takes its prompt from a file. */
function invocation(
  workDir: string,
  overrides: Partial<CliInvocation> = {},
  model?: string,
): CliInvocation {
  return {
    executable: 'grok',
    args: [
      '--prompt-file',
      path.join(workDir, 'prompt.txt'),
      '--output-format',
      'streaming-json',
      '--cwd',
      workDir,
      '--no-auto-update',
      '--max-turns',
      '1',
      '--no-plan',
      '--no-subagents',
      '--tools',
      '',
      ...(model === undefined ? [] : ['-m', model]),
    ],
    env: { ...(harness.context.env as Record<string, string>), GROK_MEMORY: '0' },
    stdin: null,
    files: [{ name: 'prompt.txt', content: 'the prompt' }],
    parser: simpleParser(),
    streaming: 'token',
    ...overrides,
  };
}

async function run(
  model?: string,
  overrides: Partial<CliInvocation> = {},
  signal?: AbortSignal,
): Promise<ProviderEvent[]> {
  const request = await harness.request(signal ? { signal } : {});
  return collect(runCli(invocation(request.workDir, overrides, model), request, harness.context));
}

describe('runCli', () => {
  test('yields start, the content and done with usage and elapsed time', async () => {
    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'token' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 1, outputTokens: 2 } });
    expect((events.at(-1) as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test('runs the child in the work dir with the prompt file written there, private to the user', async () => {
    const request = await harness.request();
    await collect(runCli(invocation(request.workDir), request, harness.context));

    const [call] = await harness.invocations();
    expect(call?.cwd).toBe(request.workDir);
    expect(call?.prompt).toBe('the prompt');
    expect(await readFile(path.join(request.workDir, 'prompt.txt'), 'utf8')).toBe('the prompt');
    if (process.platform !== 'win32') {
      expect((await stat(path.join(request.workDir, 'prompt.txt'))).mode & 0o777).toBe(0o600);
    }
  });

  test('reports not_installed when the executable is not on PATH, without starting anything', async () => {
    const events = await run(undefined, { executable: 'no-such-cli' });

    expect(events).toEqual([
      { type: 'start', streaming: 'token' },
      { type: 'error', code: 'not_installed', message: '`no-such-cli` was not found on PATH.' },
    ]);
    expect(await harness.invocations()).toEqual([]);
  });

  test('reports spawn_failed for a launcher script that would need a shell', async () => {
    const request = await harness.request();
    const context = {
      ...harness.context,
      platform: 'win32' as const,
      env: { PATH: 'C:\\Tools' },
      fs: {
        isFile: async (file: string) => file === 'C:\\Tools\\grok.cmd',
        isExecutable: async () => false,
        readText: async () => '@echo off\r\npython grok.py %*\r\n',
      },
    };

    const events = await collect(runCli(invocation(request.workDir), request, context));

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'spawn_failed' });
    expect(await harness.invocations()).toEqual([]);
  });

  test('a request aborted before the start never spawns and writes no prompt file', async () => {
    const request = await harness.request({ signal: AbortSignal.abort() });

    const events = await collect(runCli(invocation(request.workDir), request, harness.context));

    expect(events).toEqual([
      { type: 'start', streaming: 'token' },
      { type: 'error', code: 'cancelled', message: expect.any(String) as string },
    ]);
    expect(await harness.invocations()).toEqual([]);
    await expect(stat(path.join(request.workDir, 'prompt.txt'))).rejects.toThrow();
  });

  test('a failure the CLI reports wins over its exit code and is classified', async () => {
    const events = await run('mock-quota');

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'quota',
      message: 'You have reached your usage limit for this billing period.',
    });
  });

  test('a parser-supplied code is not second-guessed', async () => {
    const parser = simpleParser();
    const events = await run('mock-quota', {
      parser: {
        event: (value) => parser.event(value),
        outcome: () => ({
          completed: false,
          failure: { code: 'rate_limited', message: 'slow down' },
        }),
      },
    });

    expect(events.at(-1)).toEqual({ type: 'error', code: 'rate_limited', message: 'slow down' });
  });

  test('maps a non-zero exit to an error carrying the sanitised end of stderr', async () => {
    const events = await run('mock-exit-nonzero');

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'unknown',
      message: '`grok` exited with code 3: mock grok: internal failure in <path>',
    });
  });

  test("a failure the adapter knows replaces the message derived from the CLI's text", async () => {
    const seen: string[] = [];
    const events = await run('mock-exit-nonzero', {
      knownFailure: (printed) => {
        seen.push(printed);
        return { code: 'unsupported', message: 'Known.' };
      },
    });

    expect(events.at(-1)).toEqual({ type: 'error', code: 'unsupported', message: 'Known.' });
    expect(seen.join('')).toContain('internal failure');
    expect(
      (await run('mock-exit-nonzero', { knownFailure: () => undefined })).at(-1),
    ).toMatchObject({ code: 'unknown' });
    expect(
      (await run(undefined, { knownFailure: () => ({ code: 'unsupported', message: 'x' }) })).at(-1)
        ?.type,
    ).toBe('done');
  });

  test('a usage error of the CLI is an error, never an empty answer', async () => {
    const events = await run(undefined, { args: ['--no-such-flag'] });

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unknown' });
    expect((events.at(-1) as { message: string }).message).toContain('exited with code 64');
  });

  test('shows the raw text when the output is not the documented format', async () => {
    const events = await run('mock-garbage');

    expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
    expect(answerOf(events)).toBe(
      'This is not the documented output format.\nSecond line of plain text.',
    );
  });

  test('reports bad_output when the CLI succeeds without printing an answer', async () => {
    const events = await run(undefined, {
      parser: { event: () => [], outcome: () => ({ completed: false }) },
    });

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'bad_output',
      message: '`grok` produced no answer.',
    });
  });

  test('ignores stderr noise and non-JSON lines around a valid stream', async () => {
    const events = await run('mock-stderr-noise');

    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('handles CRLF line endings and lines split across chunks', async () => {
    const events = await run('mock-chunked');

    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('delivers a huge answer completely', async () => {
    const events = await run('mock-huge');

    expect(answerOf(events).length).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('drops an oversized line with a notice instead of buffering it', async () => {
    const request = await harness.request();
    const context = { ...harness.context, maxLineLength: 200 };

    const events = await collect(
      runCli(invocation(request.workDir, {}, 'mock-huge'), request, context),
    );

    expect(noticesOf(events)).toEqual(['Part of the output was too large and was dropped.']);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('a parser that throws ends the run with an error and leaves no process', async () => {
    const events = await run('mock-slow', {
      parser: {
        event: () => {
          throw new Error('parser bug');
        },
        outcome: () => ({ completed: false }),
      },
    });

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'unknown',
      message: '`grok` could not be run.',
    });
    const [call] = await harness.invocations();
    expect(call?.pid !== undefined && isAlive(call.pid)).toBe(false);
    expect(harness.logger.entries.map((entry) => entry.message)).toContain(
      'provider run failed unexpectedly',
    );
  });

  test('cancel while the CLI hangs ends with cancelled and kills the whole tree', async () => {
    const stop = new AbortController();
    const request = await harness.request({ signal: stop.signal });
    const events: ProviderEvent[] = [];

    for await (const event of runCli(
      invocation(request.workDir, {}, 'mock-tree'),
      request,
      harness.context,
    )) {
      events.push(event);
      if (event.type === 'delta') stop.abort();
    }

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'cancelled',
      message: 'The CLI was stopped.',
    });
    const calls = await harness.invocations();
    const pid = calls.find((call) => call.kind === 'grok')?.pid;
    const grandchild = calls.find((call) => call.grandchildPid !== undefined)?.grandchildPid;
    if (pid === undefined || grandchild === undefined) throw new Error('pids were not recorded');
    await until(() => !isAlive(pid) && !isAlive(grandchild));
  });

  test('a consumer that abandons the iteration leaves no process behind', async () => {
    const request = await harness.request();

    for await (const event of runCli(
      invocation(request.workDir, {}, 'mock-tree'),
      request,
      harness.context,
    )) {
      if (event.type === 'delta') break;
    }

    const calls = await harness.invocations();
    const pid = calls.find((call) => call.kind === 'grok')?.pid;
    const grandchild = calls.find((call) => call.grandchildPid !== undefined)?.grandchildPid;
    if (pid === undefined || grandchild === undefined) throw new Error('pids were not recorded');
    await until(() => !isAlive(pid) && !isAlive(grandchild));
  });

  test.skipIf(process.platform === 'win32')(
    'finishes when the CLI exits but something it started keeps the output open',
    async () => {
      const events = await run('mock-lingering-child');

      expect(answerOf(events)).toBe('Hello from the mock CLI.');
      expect(events.at(-1)?.type).toBe('done');
      const grandchild = (await harness.invocations()).find(
        (call) => call.grandchildPid,
      )?.grandchildPid;
      if (grandchild === undefined) throw new Error('the grandchild pid was not recorded');
      await until(() => !isAlive(grandchild));
    },
  );
});

describe('parseJsonLine', () => {
  test('returns JSON objects, tolerating surrounding whitespace', () => {
    expect(parseJsonLine('  {"type":"x","n":1}  ')).toEqual({ type: 'x', n: 1 });
  });

  test.each([
    '',
    '   ',
    'plain text',
    '[1,2]',
    '"string"',
    '42',
    'null',
    '{"unterminated":',
    '{not json}',
  ])('returns undefined for %j', (line) => {
    expect(parseJsonLine(line)).toBeUndefined();
  });

  test('isRecord tells objects from arrays and null', () => {
    expect([{}, { a: 1 }].every(isRecord)).toBe(true);
    expect([null, [], 'x', 1, undefined].some(isRecord)).toBe(false);
  });
});
