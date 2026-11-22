import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeClock } from '../../testing/index.ts';
import { createMockCliHarness, isAlive, until } from '../test-harness.ts';
import type { MockCliHarness } from '../test-harness.ts';
import { buildCodexArgs } from '../codex.ts';
import { captureCli, DETECT_TIMEOUT_MS } from './capture.ts';

let harness: MockCliHarness;
beforeEach(async () => {
  harness = await createMockCliHarness();
});
afterEach(() => harness.cleanup());

const env = (): Record<string, string> => harness.context.env as Record<string, string>;

/** Makes the mock codex CLI start and then hang. */
const HANGING = buildCodexArgs({ workDir: '.', model: 'mock-hang' });

describe('captureCli', () => {
  test('returns the exit code, stdout and stderr of a status command', async () => {
    expect(await captureCli('codex', ['login', 'status'], env(), harness.context)).toEqual({
      outcome: 'exited',
      code: 0,
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    });
    expect(await captureCli('grok', ['version'], env(), harness.context)).toEqual({
      outcome: 'exited',
      code: 0,
      stdout: 'grok 1.0.92\n',
      stderr: '',
    });
  });

  test('returns a non-zero exit as an exit, not as a failure to run', async () => {
    expect(await captureCli('grok', ['--bogus'], env(), harness.context)).toMatchObject({
      outcome: 'exited',
      code: 64,
    });
  });

  test('reports a command that is not on PATH', async () => {
    expect(await captureCli('no-such-cli', ['--version'], env(), harness.context)).toEqual({
      outcome: 'not_found',
    });
  });

  test('does not run the child in the server working directory', async () => {
    await captureCli('codex', ['--version'], env(), harness.context);

    const [call] = await harness.invocations();
    expect(call?.cwd).not.toBe(process.cwd());
  });

  test('gives up on a command that does not answer within the detection timeout, and kills it', async () => {
    const clock = new FakeClock();
    const pending = captureCli('codex', HANGING, env(), { ...harness.context, clock });
    await until(async () => (await harness.invocations()).length > 0);

    await clock.advance(DETECT_TIMEOUT_MS - 1);
    const pid = (await harness.invocations())[0]?.pid;
    if (pid === undefined) throw new Error('the mock did not record its pid');
    expect(isAlive(pid)).toBe(true);
    await clock.advance(1);

    expect(await pending).toEqual({ outcome: 'timeout' });
    expect(isAlive(pid)).toBe(false);
  });

  test('stops at once when the server shuts down', async () => {
    const pending = captureCli('codex', HANGING, env(), harness.context);
    await until(async () => (await harness.invocations()).length > 0);

    harness.shutdown.abort();

    expect(await pending).toEqual({ outcome: 'aborted' });
  });

  test('starts nothing once shutdown has begun', async () => {
    harness.shutdown.abort();

    expect(await captureCli('codex', ['--version'], env(), harness.context)).toEqual({
      outcome: 'aborted',
    });
    expect(await harness.invocations()).toEqual([]);
  });
});
