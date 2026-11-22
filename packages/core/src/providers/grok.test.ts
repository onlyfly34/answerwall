import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter } from '../contracts/index.ts';
import type { ContentEvent } from './cli/run-cli.ts';
import {
  buildGrokArgs,
  createGrokAdapter,
  createGrokParser,
  GROK_MODELS_ARGS,
  GROK_PROMPT_FILE,
  GROK_VERSION_ARGS,
} from './grok.ts';
import {
  answerOf,
  cliInstance,
  collect,
  createMockCliHarness,
  isAlive,
  noticesOf,
  reasoningOf,
  typesOf,
  until,
} from './test-harness.ts';
import type { MockCliHarness } from './test-harness.ts';

describe('buildGrokArgs', () => {
  test('on Linux it is the single-turn invocation with no tools and a read-only sandbox', () => {
    expect(
      buildGrokArgs({ workDir: '/data/work/abc', platform: 'linux', model: 'grok-4' }),
    ).toEqual([
      '--prompt-file',
      '/data/work/abc/prompt.txt',
      '--output-format',
      'streaming-json',
      '-m',
      'grok-4',
      '--cwd',
      '/data/work/abc',
      '--no-auto-update',
      '--max-turns',
      '1',
      '--no-plan',
      '--no-subagents',
      '--tools',
      '',
      '--sandbox',
      'read-only',
    ]);
  });

  test('on Windows there is no sandbox flag and the prompt file path uses backslashes', () => {
    expect(buildGrokArgs({ workDir: 'C:\\data\\work\\abc', platform: 'win32' })).toEqual([
      '--prompt-file',
      'C:\\data\\work\\abc\\prompt.txt',
      '--output-format',
      'streaming-json',
      '--cwd',
      'C:\\data\\work\\abc',
      '--no-auto-update',
      '--max-turns',
      '1',
      '--no-plan',
      '--no-subagents',
      '--tools',
      '',
    ]);
  });

  test('macOS, where the CLI documents a sandbox too, gets the same flag', () => {
    expect(buildGrokArgs({ workDir: '/w', platform: 'darwin' }).slice(-2)).toEqual([
      '--sandbox',
      'read-only',
    ]);
  });

  test('uses the format name of this CLI and never approves tools', () => {
    const args = buildGrokArgs({ workDir: '/w', platform: 'linux' });

    expect(args).not.toContain('stream-json');
    for (const flag of ['--yolo', '--always-approve', '-p', '--single']) {
      expect(args).not.toContain(flag);
    }
  });

  test('the status commands are the documented ones', () => {
    expect(GROK_VERSION_ARGS).toEqual(['version']);
    expect(GROK_MODELS_ARGS).toEqual(['models']);
    expect(GROK_PROMPT_FILE).toBe('prompt.txt');
  });
});

function feed(events: Record<string, unknown>[]) {
  const parser = createGrokParser();
  const content: ContentEvent[] = events.flatMap((event) => parser.event(event));
  return { content, outcome: parser.outcome() };
}

describe('createGrokParser', () => {
  test('maps text and thought fragments and the usage of the end event', () => {
    const { content, outcome } = feed([
      { type: 'thought', data: 'hmm' },
      { type: 'text', data: 'Hel' },
      { type: 'text', data: 'lo' },
      {
        type: 'end',
        stopReason: 'end_turn',
        sessionId: 's',
        usage: { inputTokens: 18, outputTokens: 9, reasoningTokens: 2 },
      },
    ]);

    expect(content).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(outcome).toEqual({
      completed: true,
      usage: { inputTokens: 18, outputTokens: 9, reasoningTokens: 2 },
    });
  });

  test('accepts fragments wrapped in an object', () => {
    expect(
      feed([
        { type: 'text', data: { text: 'a' } },
        { type: 'text', data: { content: 'b' } },
        { type: 'thought', data: { text: 'c' } },
      ]).content,
    ).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'reasoning', text: 'c' },
    ]);
  });

  test.each([
    [{ type: 'usage', data: { inputTokens: 1, outputTokens: 2 } }],
    [{ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } }],
    [{ type: 'usage', promptTokens: 1, completionTokens: 2 }],
    [{ type: 'end', data: { usage: { prompt_tokens: 1, completion_tokens: 2 } } }],
  ])('reads usage from %j', (event) => {
    expect(feed([event]).outcome.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  test('an end event without usage keeps the usage reported earlier', () => {
    const { outcome } = feed([
      { type: 'usage', data: { inputTokens: 5, outputTokens: 6 } },
      { type: 'end', stopReason: 'end_turn' },
    ]);

    expect(outcome).toEqual({ completed: true, usage: { inputTokens: 5, outputTokens: 6 } });
  });

  test('reports each attempted tool once, with a harmless name', () => {
    const { content } = feed([
      { type: 'tool_call', data: { name: 'run_terminal_cmd' } },
      { type: 'tool_call_update', data: { name: 'run_terminal_cmd', status: 'failed' } },
      { type: 'tool_call', data: { name: 'run_terminal_cmd' } },
      { type: 'tool_call', toolName: 'web<script>search' },
      { type: 'tool_call' },
    ]);

    expect(noticesOf(content)).toEqual([
      'The model tried to use a tool (run_terminal_cmd).',
      'The model tried to use a tool (webscriptsearch).',
      'The model tried to use a tool (unknown).',
    ]);
  });

  test('an error event is a failure with its message', () => {
    expect(
      feed([
        { type: 'text', data: 'partial' },
        { type: 'error', message: 'Not logged in.' },
      ]).outcome,
    ).toEqual({
      completed: false,
      failure: { message: 'Not logged in.' },
    });
    expect(feed([{ type: 'error', data: { message: 'nested' } }]).outcome.failure).toEqual({
      message: 'nested',
    });
    expect(feed([{ type: 'error' }]).outcome.failure).toEqual({
      message: 'The CLI reported an error.',
    });
  });

  test('ignores the other documented and unknown events', () => {
    const { content, outcome } = feed([
      { type: 'plan', data: {} },
      { type: 'available_commands', data: [] },
      { type: 'max_turns_reached' },
      { type: 'auto_compact_started' },
      { type: 'text' },
      { type: 'text', data: 7 },
      {},
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({ completed: false });
  });
});

describe('the grok adapter against the mock CLI', () => {
  let harness: MockCliHarness;
  let adapter: ProviderAdapter;
  const instance = cliInstance('grok');

  const setup = async (env: Record<string, string> = {}) => {
    harness = await createMockCliHarness({ env });
    adapter = createGrokAdapter(harness.context);
  };
  beforeEach(() => setup());
  afterEach(() => harness.cleanup());

  const run = async (model?: string, prompt = 'What is 2 + 2?') =>
    collect(adapter.run(instance, await harness.request({ prompt, ...(model ? { model } : {}) })));

  test('declares the tool access the platform allows and the device login command', () => {
    expect(adapter).toMatchObject({ kind: 'grok', loginCommand: 'grok login --device-auth' });
    expect(createGrokAdapter({ ...harness.context, platform: 'linux' }).toolAccess).toBe(
      'read-only',
    );
    expect(createGrokAdapter({ ...harness.context, platform: 'win32' }).toolAccess).toBe(
      'unrestricted',
    );
    expect(createGrokAdapter({ ...harness.context, platform: 'darwin' }).toolAccess).toBe(
      'read-only',
    );
  });

  test('streams an answer token by token with usage', async () => {
    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'token' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 18, outputTokens: 9, reasoningTokens: 2 },
    });
  });

  test('passes the prompt in a file inside the work dir, never in argv or on stdin', async () => {
    await harness.cleanup();
    await setup({ XAI_API_KEY: 'xai-test', CLAUDECODE: '1', GROK_MEMORY: '1' });
    const prompt = '--yolo\n$(id) "quoted" 問題';
    const request = await harness.request({ prompt, model: 'grok-4', effort: 'high' });

    const events = await collect(adapter.run(instance, request));

    expect(events.at(-1)?.type).toBe('done');
    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(
      buildGrokArgs({ workDir: request.workDir, platform: process.platform, model: 'grok-4' }),
    );
    expect(call?.argv?.join(' ')).not.toContain('yolo');
    expect(call?.prompt).toBe(prompt);
    expect(await readFile(path.join(request.workDir, GROK_PROMPT_FILE), 'utf8')).toBe(prompt);
    expect(call?.cwd).toBe(request.workDir);
    expect(call?.env).toMatchObject({ NO_COLOR: '1', TERM: 'dumb', GROK_MEMORY: '0' });
    for (const name of ['XAI_API_KEY', 'CLAUDECODE']) {
      expect(call?.envNames).not.toContain(name);
    }
  });

  test('keeps the API key variable when the instance says to use it', async () => {
    await harness.cleanup();
    await setup({ XAI_API_KEY: 'xai-test' });

    await collect(
      adapter.run(cliInstance('grok', { useEnvApiKey: true }), await harness.request()),
    );

    expect((await harness.invocations())[0]?.envNames).toContain('XAI_API_KEY');
  });

  test('echoes a long prompt intact', async () => {
    const prompt = 'x'.repeat(100_000);

    expect(answerOf(await run('mock-echo', prompt))).toBe(`You said: ${prompt}`);
  });

  test('maps thoughts and attempted tool calls', async () => {
    expect(reasoningOf(await run('mock-reasoning'))).toBe('The user greets me.');

    const denied = await run('mock-tool-denied');
    expect(noticesOf(denied)).toEqual(['The model tried to use a tool (run_terminal_cmd).']);
    expect(answerOf(denied)).toBe('I cannot run commands here.');
    expect(denied.at(-1)?.type).toBe('done');
  });

  test('a single text event is a complete answer', async () => {
    expect(typesOf(await run('mock-block'))).toEqual(['start', 'delta', 'done']);
  });

  test.each([
    ['mock-logged-out', 'not_logged_in'],
    ['mock-quota', 'quota'],
    ['mock-rate-limited', 'rate_limited'],
    ['mock-model-not-found', 'model_not_found'],
  ] as const)('%s ends with the error code %s', async (model, code) => {
    const events = await run(model);

    expect(events.at(-1)).toMatchObject({ type: 'error', code });
    expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(
      1,
    );
  });

  test('a crash is an error with the sanitised diagnostics', async () => {
    expect((await run('mock-exit-nonzero')).at(-1)).toMatchObject({
      type: 'error',
      code: 'unknown',
      message: '`grok` exited with code 3: mock grok: internal failure in <path>',
    });
  });

  test.each(['mock-hang', 'mock-init-hang', 'mock-tree'])(
    'cancelling a %s run stops it and leaves no process',
    async (model) => {
      const stop = new AbortController();
      const done = collect(
        adapter.run(instance, await harness.request({ model, signal: stop.signal })),
      );

      await until(async () =>
        (await harness.invocations()).some((call) => call.scenario !== undefined),
      );
      if (model === 'mock-tree') {
        await until(async () => (await harness.invocations()).some((call) => call.grandchildPid));
      }
      stop.abort();

      expect((await done).at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
      const pids = (await harness.invocations()).flatMap((call) => [call.pid, call.grandchildPid]);
      for (const pid of pids) {
        if (pid !== undefined) await until(() => !isAlive(pid));
      }
    },
  );

  describe('detect and listModels', () => {
    test('reports the version and that the login state cannot be known', async () => {
      const detection = await adapter.detect(instance);

      expect(detection).toMatchObject({
        installed: true,
        version: '1.0.92',
        loggedIn: 'unknown',
        billing: 'unknown',
        streaming: 'token',
      });
      expect(detection.hint).toContain('`grok login --device-auth`');
      // Where the sandbox is part of the invocation, the page says it is best effort.
      expect(detection.hint?.includes('The read-only sandbox is best effort')).toBe(
        harness.context.platform !== 'win32',
      );
      expect((await harness.invocations()).map((call) => call.argv)).toEqual([['version']]);
    });

    test('a kept API key does not decide billing: the CLI prefers its login session', async () => {
      await harness.cleanup();
      await setup({ XAI_API_KEY: 'xai-test-value' });

      const detection = await adapter.detect(cliInstance('grok', { useEnvApiKey: true }));

      expect(detection.billing).toBe('unknown');
      expect(detection.hint).toContain('Passed to the CLI from the environment: XAI_API_KEY.');
      expect(detection.hint).toContain('only when it has no login session');
      expect(detection.hint).not.toContain('xai-test-value');
    });

    test('reports a missing CLI', async () => {
      await harness.cleanup();
      await setup({ PATH: '' });

      expect(await adapter.detect(instance)).toMatchObject({
        installed: false,
        loggedIn: 'unknown',
      });
    });

    test('lists models from the plain-text listing', async () => {
      expect(await adapter.listModels?.(instance)).toEqual([
        { id: 'mock-grok-large' },
        { id: 'mock-grok-fast' },
      ]);
    });
  });
});
