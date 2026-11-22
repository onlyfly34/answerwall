import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter, ProviderEvent } from '../contracts/index.ts';
import {
  buildClaudeArgs,
  CLAUDE_STATUS_ARGS,
  CLAUDE_VERSION_ARGS,
  createClaudeAdapter,
  createClaudeParser,
  parseClaudeAuthStatus,
} from './claude.ts';
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

const RUN_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--tools',
  '',
  '--strict-mcp-config',
  '--safe-mode',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--permission-prompts',
  'none',
];

describe('buildClaudeArgs', () => {
  test('is the restricted print-mode invocation, with nothing from the user in it', () => {
    expect(buildClaudeArgs({})).toEqual(RUN_ARGS);
  });

  test('appends the model and the effort when given', () => {
    expect(buildClaudeArgs({ model: 'opus', effort: 'high' })).toEqual([
      ...RUN_ARGS,
      '--model',
      'opus',
      '--effort',
      'high',
    ]);
  });

  test('never uses --bare or plan mode', () => {
    const args = buildClaudeArgs({ model: 'sonnet' });

    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--permission-mode');
  });

  test('the status commands are the documented ones', () => {
    expect(CLAUDE_VERSION_ARGS).toEqual(['--version']);
    expect(CLAUDE_STATUS_ARGS).toEqual(['auth', 'status']);
  });
});

const stream = (event: Record<string, unknown>) => ({ type: 'stream_event', event });
const textDelta = (text: string) =>
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  ...extra,
});

function feed(events: Record<string, unknown>[]) {
  const parser = createClaudeParser();
  const content: ContentEvent[] = events.flatMap((event) => parser.event(event));
  return { content, outcome: parser.outcome() };
}

describe('createClaudeParser', () => {
  test('maps text deltas, without repeating the text of the complete message or the result', () => {
    const { content, outcome } = feed([
      { type: 'system', subtype: 'init', tools: [] },
      stream({ type: 'message_start', message: {} }),
      textDelta('Hel'),
      textDelta('lo'),
      assistant([{ type: 'text', text: 'Hello' }]),
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello' },
    ]);

    expect(content).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
    expect(outcome).toEqual({ completed: true });
  });

  test('does not assume the first line is the init event', () => {
    const { content, outcome } = feed([
      { type: 'system', subtype: 'hook_started' },
      textDelta('Hi'),
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'success', result: 'Hi' },
    ]);

    expect(content).toEqual([{ type: 'delta', text: 'Hi' }]);
    expect(outcome.completed).toBe(true);
  });

  test('maps thinking deltas to reasoning', () => {
    const { content } = feed([
      stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      stream({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } }),
      textDelta('Answer'),
      assistant([
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Answer' },
      ]),
    ]);

    expect(content).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'delta', text: 'Answer' },
    ]);
  });

  test('uses the complete message when no partial deltas were forwarded', () => {
    const { content } = feed([
      assistant([
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'Whole answer' },
      ]),
      { type: 'result', subtype: 'success', result: 'Whole answer' },
    ]);

    expect(content).toEqual([
      { type: 'reasoning', text: 'plan' },
      { type: 'delta', text: 'Whole answer' },
    ]);
  });

  test('uses the result text when nothing else carried the answer', () => {
    const { content, outcome } = feed([
      { type: 'result', subtype: 'success', result: 'Only here' },
    ]);

    expect(content).toEqual([{ type: 'delta', text: 'Only here' }]);
    expect(outcome.completed).toBe(true);
  });

  test('separates the text of consecutive messages', () => {
    const { content } = feed([
      stream({ type: 'message_start' }),
      textDelta('First.'),
      assistant([{ type: 'text', text: 'First.' }]),
      stream({ type: 'message_start' }),
      textDelta('Second'),
      textDelta('.'),
      assistant([{ type: 'text', text: 'Second.' }]),
      assistant([{ type: 'text', text: 'Third.' }]),
    ]);

    expect(content.map((event) => (event.type === 'delta' ? event.text : ''))).toEqual([
      'First.',
      '\n\nSecond',
      '.',
      '\n\nThird.',
    ]);
  });

  test('reports a requested tool once per tool as a notice', () => {
    const { content } = feed([
      assistant([{ type: 'tool_use', name: 'Bash', input: {} }]),
      assistant([{ type: 'tool_use', name: 'Bash', input: {} }]),
      assistant([{ type: 'tool_use', name: 'WebFetch', input: {} }]),
      {
        type: 'result',
        subtype: 'success',
        result: '',
        permission_denials: [{ tool_name: 'Bash' }, { tool_name: 'Edit' }, 'junk'],
      },
    ]);

    expect(content).toEqual([
      { type: 'notice', message: 'The model asked for the tool "Bash"; tools are switched off.' },
      {
        type: 'notice',
        message: 'The model asked for the tool "WebFetch"; tools are switched off.',
      },
      { type: 'notice', message: 'The model asked for the tool "Edit"; tools are switched off.' },
    ]);
  });

  test('ignores the conversation of a sub-agent', () => {
    const { content } = feed([
      { ...textDelta('inner'), parent_tool_use_id: 'toolu_1' },
      assistant([{ type: 'text', text: 'inner' }], { parent_tool_use_id: 'toolu_1' }),
    ]);

    expect(content).toEqual([]);
  });

  test('reads usage from the result, counting cached input', () => {
    const { outcome } = feed([
      {
        type: 'result',
        subtype: 'success',
        result: 'x',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 100,
          output_tokens: 7,
        },
      },
    ]);

    expect(outcome.usage).toEqual({ inputTokens: 115, outputTokens: 7 });
  });

  test('a result flagged as an error is a failure with its text', () => {
    const { content, outcome } = feed([
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
      },
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({
      completed: false,
      failure: { message: 'Not logged in · Please run /login' },
    });
  });

  test('a result with an error subtype is a failure, described by its errors', () => {
    expect(
      feed([{ type: 'result', subtype: 'error_during_execution', errors: ['boom', 'bang'] }])
        .outcome.failure,
    ).toEqual({ message: 'boom bang' });
    expect(feed([{ type: 'result', subtype: 'error_max_turns' }]).outcome.failure).toEqual({
      message: 'The run ended early (error_max_turns).',
    });
  });

  test.each([
    ['authentication_failed', 'not_logged_in'],
    ['billing_error', 'quota'],
    ['rate_limit', 'rate_limited'],
    ['overloaded', 'rate_limited'],
    ['model_not_found', 'model_not_found'],
    ['server_error', 'network'],
  ] as const)('a retry error of %s makes the final failure %s', (error, code) => {
    const { content, outcome } = feed([
      { type: 'system', subtype: 'api_retry', attempt: 1, error },
      { type: 'system', subtype: 'api_retry', attempt: 2, error },
      { type: 'result', subtype: 'success', is_error: true, result: 'API Error' },
    ]);

    expect(noticesOf(content as ProviderEvent[])).toHaveLength(1);
    expect(outcome.failure).toEqual({ message: 'API Error', code });
  });

  test('an unknown retry error leaves the code to be guessed from the text', () => {
    const { outcome } = feed([
      { type: 'system', subtype: 'api_retry', error: 'something_new' },
      { type: 'result', is_error: true, result: 'failed' },
    ]);

    expect(outcome.failure).toEqual({ message: 'failed' });
  });

  test('a retry that then succeeds is not a failure', () => {
    const { outcome } = feed([
      { type: 'system', subtype: 'api_retry', error: 'overloaded' },
      textDelta('ok'),
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ]);

    expect(outcome).toEqual({ completed: true });
  });

  test('a rejected rate-limit event makes the failure a quota error', () => {
    const { outcome } = feed([
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
      { type: 'result', is_error: true, result: 'Limit reached' },
    ]);

    expect(outcome.failure).toEqual({ message: 'Limit reached', code: 'quota' });
  });

  test('ignores unknown event types and malformed shapes', () => {
    const { content, outcome } = feed([
      { type: 'brand_new_event', data: 1 },
      { type: 'stream_event' },
      { type: 'stream_event', event: { type: 'content_block_delta' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta' } },
      },
      { type: 'assistant' },
      { type: 'assistant', message: { content: 'not a list' } },
      { type: 'assistant', message: { content: [null, 'x', { type: 'text' }] } },
      { type: 'rate_limit_event' },
      {},
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({ completed: false });
  });
});

describe('parseClaudeAuthStatus', () => {
  test('reads a subscription login', () => {
    const status = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
    });

    expect(parseClaudeAuthStatus(status, 0)).toEqual({ loggedIn: 'yes', billing: 'subscription' });
  });

  test.each(['api_key', 'api_key_helper', 'third_party'])('%s bills an API key', (authMethod) => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod }), 0)).toEqual({
      loggedIn: 'yes',
      billing: 'api-key',
    });
  });

  test('a cloud provider bills that provider, not the subscription', () => {
    const status = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'bedrock',
    });

    expect(parseClaudeAuthStatus(status, 0).billing).toBe('api-key');
  });

  test('reads a logged-out state', () => {
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: false, authMethod: 'none' }), 1),
    ).toEqual({
      loggedIn: 'no',
      billing: 'unknown',
    });
  });

  test('falls back to the documented exit codes when the output is not JSON', () => {
    expect(parseClaudeAuthStatus('Logged in', 0)).toEqual({ loggedIn: 'yes', billing: 'unknown' });
    expect(parseClaudeAuthStatus('', 1)).toEqual({ loggedIn: 'no', billing: 'unknown' });
    expect(parseClaudeAuthStatus('', 2)).toEqual({ loggedIn: 'unknown', billing: 'unknown' });
    expect(parseClaudeAuthStatus('', null)).toEqual({ loggedIn: 'unknown', billing: 'unknown' });
  });

  test('an unknown method is an unknown billing source', () => {
    expect(
      parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'new_thing' }), 0),
    ).toEqual({
      loggedIn: 'yes',
      billing: 'unknown',
    });
  });
});

describe('the claude adapter against the mock CLI', () => {
  let harness: MockCliHarness;
  let adapter: ProviderAdapter;
  const instance = cliInstance('claude');

  const setup = async (env: Record<string, string> = {}) => {
    harness = await createMockCliHarness({ env });
    adapter = createClaudeAdapter(harness.context);
  };
  beforeEach(() => setup());
  afterEach(() => harness.cleanup());

  const run = async (model?: string, prompt = 'What is 2 + 2?') =>
    collect(adapter.run(instance, await harness.request({ prompt, ...(model ? { model } : {}) })));

  test('declares tools disabled and the official login command', () => {
    expect(adapter).toMatchObject({
      kind: 'claude',
      toolAccess: 'disabled',
      loginCommand: 'claude auth login',
    });
  });

  test('streams an answer token by token with usage', async () => {
    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'token' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 42, outputTokens: 7 } });
  });

  test('sends the prompt on stdin, never in argv, and runs in the work dir with a scrubbed environment', async () => {
    await harness.cleanup();
    await setup({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_EFFORT: 'high',
      CLAUDE_PID: '1',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      OPENAI_API_KEY: 'sk-test',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'true',
    });
    const prompt = '--model evil\n$(rm -rf /) "quotes" 問題';
    const request = await harness.request({ prompt, model: 'sonnet', effort: 'low' });

    const events = await collect(adapter.run(instance, request));

    expect(events.at(-1)?.type).toBe('done');
    const [call] = await harness.invocations();
    expect(call?.argv).toEqual([...RUN_ARGS, '--model', 'sonnet', '--effort', 'low']);
    expect(call?.prompt).toBe(prompt);
    expect(call?.cwd).toBe(request.workDir);
    expect(call?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
    for (const name of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_EFFORT',
      'CLAUDE_PID',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'OPENAI_API_KEY',
    ]) {
      expect(call?.envNames).not.toContain(name);
    }
  });

  test('keeps the API key variables when the instance says to use them', async () => {
    await harness.cleanup();
    await setup({ ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDECODE: '1' });

    await collect(
      adapter.run(cliInstance('claude', { useEnvApiKey: true }), await harness.request()),
    );

    const [call] = await harness.invocations();
    expect(call?.envNames).toContain('ANTHROPIC_API_KEY');
    expect(call?.envNames).not.toContain('CLAUDECODE');
  });

  test('echoes a long multi-line prompt intact', async () => {
    const prompt = `${'long line with ünïcödé '.repeat(5000)}\nsecond line`;

    const events = await run('mock-echo', prompt);

    expect(answerOf(events)).toBe(`You said: ${prompt}`);
  });

  test('shows whole messages when the CLI does not forward partial ones', async () => {
    const events = await run('mock-block');

    expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('maps thinking to reasoning events', async () => {
    const events = await run('mock-reasoning');

    expect(reasoningOf(events)).toBe('The user greets me. I will greet back.');
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('reports a denied tool call as a notice next to the answer', async () => {
    const events = await run('mock-tool-denied');

    expect(noticesOf(events)).toEqual([
      'The model asked for the tool "Bash"; tools are switched off.',
    ]);
    expect(answerOf(events)).toBe('I cannot run commands here.');
    expect(events.at(-1)?.type).toBe('done');
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
    expect(answerOf(events)).toBe('');
  });

  test('a crash is an error with the sanitised diagnostics', async () => {
    const events = await run('mock-exit-nonzero');

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'unknown',
      message: '`claude` exited with code 3: mock claude: internal failure in <path>',
    });
  });

  test('falls back to the raw text for output in another format', async () => {
    const events = await run('mock-garbage');

    expect(answerOf(events)).toContain('This is not the documented output format.');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('streams slowly arriving output as it comes', async () => {
    await harness.cleanup();
    await setup({ MOCK_CLI_DELAY_MS: '5' });

    const events = await run('mock-slow');

    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('refuses an option-like model name without starting the CLI', async () => {
    const events = await run('--dangerously-skip-permissions');

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'model_not_found' });
    expect(await harness.invocations()).toEqual([]);
  });

  test('reports not_installed when the CLI is missing', async () => {
    await harness.cleanup();
    await setup({ PATH: '' });

    expect((await run()).at(-1)).toMatchObject({ type: 'error', code: 'not_installed' });
  });

  test.each(['mock-hang', 'mock-init-hang', 'mock-tree'])(
    'cancelling a %s run stops it and leaves no process',
    async (model) => {
      const stop = new AbortController();
      const request = await harness.request({ model, signal: stop.signal });
      const done = collect(adapter.run(instance, request));

      await until(async () =>
        (await harness.invocations()).some((call) => call.scenario !== undefined),
      );
      if (model === 'mock-tree') {
        await until(async () => (await harness.invocations()).some((call) => call.grandchildPid));
      }
      stop.abort();
      const events = await done;

      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'cancelled' });
      const pids = (await harness.invocations()).flatMap((call) => [call.pid, call.grandchildPid]);
      for (const pid of pids) {
        if (pid !== undefined) await until(() => !isAlive(pid));
      }
    },
  );

  describe('detect', () => {
    test('reports version, login and billing, and nothing that identifies the account', async () => {
      const detection = await adapter.detect(instance);

      expect(detection).toEqual({
        installed: true,
        version: '2.1.330',
        loggedIn: 'yes',
        billing: 'subscription',
        streaming: 'token',
      });
      const calls = await harness.invocations();
      expect(calls.map((call) => call.argv)).toEqual([['--version'], ['auth', 'status']]);
      expect(JSON.stringify([detection, harness.logger.entries])).not.toMatch(
        /example\.com|Mock Organisation|org-mock|\/home\/mock/,
      );
    });

    test('reports a logged-out CLI with the command to run', async () => {
      await harness.cleanup();
      await setup({ MOCK_CLI_SCENARIO: 'logged-out' });

      expect(await adapter.detect(instance)).toEqual({
        installed: true,
        version: '2.1.330',
        loggedIn: 'no',
        billing: 'unknown',
        streaming: 'token',
        hint: 'Not logged in. Run `claude auth login` in a terminal.',
      });
    });

    test('reports a missing CLI', async () => {
      await harness.cleanup();
      await setup({ PATH: '' });

      expect(await adapter.detect(instance)).toEqual({
        installed: false,
        loggedIn: 'unknown',
        streaming: 'token',
        hint: '`claude` was not found on PATH.',
      });
    });

    test('names an API key variable that is present but not passed on', async () => {
      await harness.cleanup();
      await setup({ ANTHROPIC_API_KEY: 'sk-ant-test-value' });

      const detection = await adapter.detect(instance);

      expect(detection).toMatchObject({ loggedIn: 'yes', billing: 'subscription' });
      expect(detection.hint).toContain('Not passed to the CLI: ANTHROPIC_API_KEY.');
      expect(detection.hint).not.toContain('sk-ant-test-value');
    });

    test('reports API key billing when the instance uses the key from the environment', async () => {
      await harness.cleanup();
      await setup({ ANTHROPIC_API_KEY: 'sk-ant-test-value' });

      const detection = await adapter.detect(cliInstance('claude', { useEnvApiKey: true }));

      expect(detection).toMatchObject({
        loggedIn: 'yes',
        billing: 'api-key',
        hint: 'Passed to the CLI from the environment: ANTHROPIC_API_KEY.',
      });
    });

    test('does not start anything after shutdown', async () => {
      harness.shutdown.abort();

      expect(await adapter.detect(instance)).toMatchObject({
        loggedIn: 'unknown',
        hint: 'Detection was interrupted.',
      });
      expect(await harness.invocations()).toEqual([]);
    });
  });
});
