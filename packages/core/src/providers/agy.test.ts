import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter } from '../contracts/index.ts';
import {
  AGY_MODELS_ARGS,
  AGY_VERSION_ARGS,
  buildAgyArgs,
  buildAgyInput,
  createAgyAdapter,
  createAgyParser,
} from './agy.ts';
import type { ContentEvent } from './cli/run-cli.ts';
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

describe('buildAgyArgs', () => {
  test('is the print-mode invocation with stream-json both ways and an explicit time limit', () => {
    expect(buildAgyArgs({ timeoutMs: 300_000 })).toEqual([
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '300s',
      '--disable-slash-commands',
    ]);
  });

  test('appends the model and the effort when given', () => {
    expect(
      buildAgyArgs({ timeoutMs: 1000, model: 'gemini-pro', effort: 'high' }).slice(-4),
    ).toEqual(['--model', 'gemini-pro', '--effort', 'high']);
  });

  test.each([
    [1, '1s'],
    [1500, '2s'],
    [0, '1s'],
    [60_000, '60s'],
  ])('a limit of %d ms is passed as %s', (timeoutMs, expected) => {
    const args = buildAgyArgs({ timeoutMs });

    expect(args[args.indexOf('--print-timeout') + 1]).toBe(expected);
  });

  test('never selects a mode, a sandbox or a permission bypass', () => {
    const args = buildAgyArgs({ timeoutMs: 1000, model: 'm-1' });

    for (const flag of ['--mode', '--sandbox', '--dangerously-skip-permissions']) {
      expect(args).not.toContain(flag);
    }
  });

  test('the status commands are the documented ones', () => {
    expect(AGY_VERSION_ARGS).toEqual(['--version']);
    expect(AGY_MODELS_ARGS).toEqual(['models']);
  });
});

describe('buildAgyInput', () => {
  test('is one JSON line carrying the prompt, whatever it contains', () => {
    const prompt = 'first line\nsecond "line" \\ 問題\u2028';
    const input = buildAgyInput(prompt);

    expect(input.endsWith('\n')).toBe(true);
    expect(input.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(input)).toEqual({ event: 'user', message: { content: prompt } });
  });
});

function feed(events: Record<string, unknown>[]) {
  const parser = createAgyParser();
  const content: ContentEvent[] = events.flatMap((event) => parser.event(event));
  return { content, outcome: parser.outcome() };
}

const step = (step_type: string, text_delta?: string) => ({
  type: 'step_update',
  step_type,
  state: 'ACTIVE',
  ...(text_delta === undefined ? {} : { text_delta }),
});

describe('createAgyParser', () => {
  test('maps response deltas and the usage of the result', () => {
    const { content, outcome } = feed([
      { type: 'init', session_id: 's' },
      step('agent_response', 'Hel'),
      step('agent_response', 'lo'),
      {
        type: 'result',
        status: 'SUCCESS',
        usage: {
          input_tokens: 15,
          output_tokens: 8,
          thinking_tokens: 4,
          cache_read_tokens: 2,
          total_tokens: 27,
        },
      },
    ]);

    expect(content).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(outcome).toEqual({
      completed: true,
      usage: { inputTokens: 15, outputTokens: 8, reasoningTokens: 4 },
    });
  });

  test('accepts the event name under `event` as well as `type`', () => {
    const { content, outcome } = feed([
      { event: 'step_update', step_type: 'agent_response', text_delta: 'Hi' },
      { event: 'result', status: 'SUCCESS' },
    ]);

    expect(content).toEqual([{ type: 'delta', text: 'Hi' }]);
    expect(outcome.completed).toBe(true);
  });

  test('maps thinking steps to reasoning', () => {
    expect(feed([step('thinking', 'hmm'), step('reasoning_summary', 'so')]).content).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'reasoning', text: 'so' },
    ]);
  });

  test('reports each kind of tool step once and ignores other steps', () => {
    const { content } = feed([
      step('tool_call'),
      step('tool_call'),
      step('run_command'),
      step('planning'),
      step('agent_response', ''),
    ]);

    expect(noticesOf(content)).toEqual([
      'The model used a tool (tool_call). This CLI has no documented way to switch its tools off.',
      'The model used a tool (run_command). This CLI has no documented way to switch its tools off.',
    ]);
  });

  test('uses a whole response in the result when no delta carried the answer', () => {
    expect(feed([{ type: 'result', status: 'SUCCESS', response: 'Whole' }]).content).toEqual([
      { type: 'delta', text: 'Whole' },
    ]);
    expect(
      feed([
        step('agent_response', 'Streamed'),
        { type: 'result', status: 'SUCCESS', response: 'Streamed' },
      ]).content,
    ).toEqual([{ type: 'delta', text: 'Streamed' }]);
  });

  test.each(['ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'])(
    'a result with status %s is a failure',
    (status) => {
      const { outcome } = feed([step('agent_response', 'partial'), { type: 'result', status }]);

      expect(outcome).toEqual({
        completed: false,
        failure: { message: `The run ended with status ${status}.` },
      });
    },
  );

  test('a failed result carries the message the CLI gave, in any of its shapes', () => {
    expect(
      feed([{ type: 'result', status: 'ERROR', error: 'quota exceeded' }]).outcome.failure,
    ).toEqual({
      message: 'quota exceeded',
    });
    expect(
      feed([{ type: 'result', status: 'ERROR', error: { message: 'nested' } }]).outcome.failure,
    ).toEqual({ message: 'nested' });
    expect(feed([{ type: 'result', status: 'ERROR', message: 'plain' }]).outcome.failure).toEqual({
      message: 'plain',
    });
  });

  test('ignores unknown events and malformed steps', () => {
    const { content, outcome } = feed([
      { type: 'heartbeat' },
      { type: 'step_update' },
      { type: 'step_update', step_type: 7, text_delta: 'x' },
      { type: 'step_update', step_type: 'agent_response', text_delta: 7 },
      {},
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({ completed: false });
  });
});

describe('the agy adapter against the mock CLI', () => {
  let harness: MockCliHarness;
  let adapter: ProviderAdapter;
  const instance = cliInstance('agy');

  const setup = async (env: Record<string, string> = {}) => {
    harness = await createMockCliHarness({ env });
    adapter = createAgyAdapter(harness.context);
  };
  beforeEach(() => setup());
  afterEach(() => harness.cleanup());

  const run = async (model?: string, prompt = 'What is 2 + 2?') =>
    collect(adapter.run(instance, await harness.request({ prompt, ...(model ? { model } : {}) })));

  test('declares unrestricted tools and that login means starting the CLI', () => {
    expect(adapter).toMatchObject({ kind: 'agy', toolAccess: 'unrestricted', loginCommand: 'agy' });
  });

  test('refuses to run before the notice is acknowledged, without starting the CLI', async () => {
    const events = await collect(
      adapter.run(cliInstance('agy', { riskAcknowledged: false }), await harness.request()),
    );

    expect(events).toEqual([
      { type: 'start', streaming: 'token' },
      {
        type: 'error',
        code: 'unsupported',
        message: 'This provider stays off until its notice has been acknowledged in the settings.',
      },
    ]);
    expect(await harness.invocations()).toEqual([]);
  });

  test('streams an answer token by token with usage', async () => {
    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'token' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({
      usage: { inputTokens: 15, outputTokens: 8, reasoningTokens: 4 },
    });
  });

  test('sends the prompt as one stream-json line on stdin, closes it, and scrubs the environment', async () => {
    await harness.cleanup();
    await setup({ GEMINI_API_KEY: 'g-test', GOOGLE_API_KEY: 'g-test2', CLAUDECODE: '1' });
    const prompt = '/plan delete everything\n--mode auto "quoted"';
    const request = await harness.request({ prompt, model: 'gemini-pro', timeoutMs: 90_500 });

    const events = await collect(adapter.run(instance, request));

    // The mock answers only after stdin has been closed.
    expect(events.at(-1)?.type).toBe('done');
    const [call] = await harness.invocations();
    expect(call?.argv).toEqual([
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '91s',
      '--disable-slash-commands',
      '--model',
      'gemini-pro',
    ]);
    expect(call?.prompt).toBe(prompt);
    expect(call?.cwd).toBe(request.workDir);
    expect(call?.env).toMatchObject({ NO_COLOR: '1', TERM: 'dumb' });
    expect(call?.envNames).toContain('AGY_CLI_DISABLE_AUTO_UPDATE');
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLAUDECODE']) {
      expect(call?.envNames).not.toContain(name);
    }
  });

  test('echoes a multi-line prompt intact', async () => {
    expect(answerOf(await run('mock-echo', 'a\nb\n\nc'))).toBe('You said: a\nb\n\nc');
  });

  test('shows a whole response when the CLI sends no deltas', async () => {
    const events = await run('mock-block');

    expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('maps thinking steps and tool steps', async () => {
    expect(reasoningOf(await run('mock-reasoning'))).toBe('The user greets me.');

    const denied = await run('mock-tool-denied');
    expect(noticesOf(denied)).toHaveLength(1);
    expect(answerOf(denied)).toBe('I cannot run commands here.');
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

  test('an unknown model is reported from the exit code and stderr', async () => {
    expect((await run('mock-model-not-found')).at(-1)).toEqual({
      type: 'error',
      code: 'model_not_found',
      message: '`agy` exited with code 1: Error: unknown model "mock-model-not-found"',
    });
  });

  test('falls back to the raw text for output in another format', async () => {
    expect(answerOf(await run('mock-garbage'))).toContain(
      'This is not the documented output format.',
    );
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
        version: '1.5.14',
        loggedIn: 'unknown',
        billing: 'unknown',
        streaming: 'token',
      });
      expect(detection.hint).toContain('start `agy` in a terminal');
      expect((await harness.invocations()).map((call) => call.argv)).toEqual([['--version']]);
    });

    test('reports API key billing only when the key is passed on', async () => {
      await harness.cleanup();
      await setup({ GEMINI_API_KEY: 'g-test-value' });

      const ignored = await adapter.detect(instance);
      const used = await adapter.detect(
        cliInstance('agy', { useEnvApiKey: true, riskAcknowledged: true }),
      );

      expect(ignored.billing).toBe('unknown');
      expect(ignored.hint).toContain('Not passed to the CLI: GEMINI_API_KEY.');
      expect(used.billing).toBe('api-key');
      expect(JSON.stringify([ignored, used])).not.toContain('g-test-value');
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
        { id: 'mock-gemini-pro' },
        { id: 'mock-gemini-flash' },
      ]);
    });
  });
});
