import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter } from '../contracts/index.ts';
import type { ContentEvent } from './cli/run-cli.ts';
import {
  buildCodexArgs,
  CODEX_DISABLED_FEATURES,
  CODEX_MODELS_ARGS,
  CODEX_STATUS_ARGS,
  CODEX_VERSION_ARGS,
  createCodexAdapter,
  createCodexParser,
  parseCodexLoginStatus,
  parseCodexModels,
} from './codex.ts';
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

const FEATURE_FLAGS = [
  '--disable',
  'shell_tool',
  '--disable',
  'unified_exec',
  '--disable',
  'apps',
  '--disable',
  'plugins',
  '--disable',
  'hooks',
  '--disable',
  'multi_agent',
  '--disable',
  'image_generation',
  '--disable',
  'browser_use',
  '--disable',
  'computer_use',
  '--disable',
  'sleep_tool',
  '--disable',
  'view_image',
];
const RESIDUAL =
  'This CLI still loads your global AGENTS.md and skills, and with some model families the model is still offered built-in tools, including sub-agents; no switch removes them.';
const fixedArgs = (workDir: string): string[] => [
  'exec',
  '--json',
  '--color',
  'never',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '-s',
  'read-only',
  '-C',
  workDir,
];

describe('buildCodexArgs', () => {
  test('is the restricted exec invocation reading the prompt from stdin', () => {
    expect(buildCodexArgs({ workDir: '/work/dir' })).toEqual([
      ...fixedArgs('/work/dir'),
      ...FEATURE_FLAGS,
      '-',
    ]);
  });

  test('adds the model and passes the effort as a quoted configuration value', () => {
    expect(buildCodexArgs({ workDir: 'C:\\work dir', model: 'gpt-5.5', effort: 'high' })).toEqual([
      ...fixedArgs('C:\\work dir'),
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      ...FEATURE_FLAGS,
      '-',
    ]);
  });

  test('disables exactly the documented features and uses the documented status commands', () => {
    expect(CODEX_DISABLED_FEATURES).toEqual([
      'shell_tool',
      'unified_exec',
      'apps',
      'plugins',
      'hooks',
      'multi_agent',
      'image_generation',
      'browser_use',
      'computer_use',
      'sleep_tool',
      'view_image',
    ]);
    expect(CODEX_VERSION_ARGS).toEqual(['--version']);
    expect(CODEX_STATUS_ARGS).toEqual(['login', 'status']);
    expect(CODEX_MODELS_ARGS).toEqual(['debug', 'models']);
  });
});

const message = (id: string, text: string, type = 'item.completed') => ({
  type,
  item: { id, type: 'agent_message', text },
});

function feed(events: Record<string, unknown>[]) {
  const parser = createCodexParser();
  const content: ContentEvent[] = events.flatMap((event) => parser.event(event));
  return { content, outcome: parser.outcome() };
}

describe('createCodexParser', () => {
  test('maps a completed agent message and the turn usage', () => {
    const { content, outcome } = feed([
      { type: 'thread.started', thread_id: 't' },
      { type: 'turn.started' },
      message('item_0', 'The answer.'),
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 20,
          cached_input_tokens: 5,
          output_tokens: 9,
          reasoning_output_tokens: 3,
        },
      },
    ]);

    expect(content).toEqual([{ type: 'delta', text: 'The answer.' }]);
    expect(outcome).toEqual({
      completed: true,
      usage: { inputTokens: 20, outputTokens: 9, reasoningTokens: 3 },
    });
  });

  test('emits only the growth of an item that is updated before it completes', () => {
    const { content } = feed([
      message('item_0', '', 'item.started'),
      message('item_0', 'Hel', 'item.updated'),
      message('item_0', 'Hello wor', 'item.updated'),
      message('item_0', 'Hello world'),
      message('item_0', 'Hello world'),
    ]);

    expect(content).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo wor' },
      { type: 'delta', text: 'ld' },
    ]);
  });

  test('separates several agent messages', () => {
    const { content } = feed([message('a', 'First.'), message('b', 'Second.')]);

    expect(content).toEqual([
      { type: 'delta', text: 'First.' },
      { type: 'delta', text: '\n\nSecond.' },
    ]);
  });

  test('handles items without an id and the older item_type field', () => {
    const { content } = feed([
      { type: 'item.completed', item: { item_type: 'assistant_message', text: 'One' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Two' } },
    ]);

    expect(content).toEqual([
      { type: 'delta', text: 'One' },
      { type: 'delta', text: '\n\nTwo' },
    ]);
  });

  test('maps reasoning items to reasoning events', () => {
    const { content } = feed([
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: '**Thinking**' } },
    ]);

    expect(content).toEqual([{ type: 'reasoning', text: '**Thinking**\n' }]);
  });

  test('reports each kind of tool use once', () => {
    const tool = (id: string, type: string, eventType = 'item.completed') => ({
      type: eventType,
      item: { id, type, status: 'declined' },
    });
    const { content } = feed([
      tool('1', 'command_execution', 'item.started'),
      tool('1', 'command_execution'),
      tool('2', 'command_execution'),
      tool('3', 'web_search'),
      tool('4', 'todo_list'),
    ]);

    expect(noticesOf(content)).toEqual([
      'The model used a tool (command_execution). This CLI cannot switch its tools off completely; they run in a read-only sandbox.',
      'The model used a tool (web_search). This CLI cannot switch its tools off completely; they run in a read-only sandbox.',
    ]);
  });

  test('shows an error item as a sanitised notice, once', () => {
    const item = {
      type: 'item.completed',
      item: { type: 'error', message: 'failed at /home/u/.codex/x for a@b.co' },
    };
    const { content, outcome } = feed([item, item]);

    expect(content).toEqual([{ type: 'notice', message: 'failed at <path> for <email>' }]);
    expect(outcome).toEqual({ completed: false });
  });

  test('a failed turn is a failure with its message', () => {
    const { outcome } = feed([
      { type: 'error', message: 'stream error' },
      { type: 'turn.failed', error: { message: "You've hit your usage limit." } },
    ]);

    expect(outcome).toEqual({
      completed: false,
      failure: { message: "You've hit your usage limit." },
    });
  });

  test('a top-level error without a completed turn is the failure', () => {
    expect(
      feed([{ type: 'error', message: 'unexpected status 401 Unauthorized' }]).outcome,
    ).toEqual({
      completed: false,
      failure: { message: 'unexpected status 401 Unauthorized' },
    });
    expect(feed([{ type: 'error', error: { message: 'nested' } }]).outcome.failure).toEqual({
      message: 'nested',
    });
  });

  test('a reconnection error followed by a completed turn is not a failure', () => {
    const { outcome } = feed([
      { type: 'error', message: 'Reconnecting... 1/5' },
      message('a', 'Fine.'),
      { type: 'turn.completed', usage: {} },
    ]);

    expect(outcome).toEqual({ completed: true });
  });

  test('ignores unknown events and malformed items', () => {
    const { content, outcome } = feed([
      { type: 'session.configured' },
      { type: 'item.completed' },
      { type: 'item.completed', item: 'text' },
      { type: 'item.completed', item: { type: 'agent_message' } },
      { type: 'item.completed', item: { type: 'future_item', text: 'x' } },
      { type: 'turn.failed' },
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({ completed: false, failure: { message: 'The turn failed.' } });
  });
});

describe('parseCodexLoginStatus', () => {
  test.each([
    ['Logged in using ChatGPT\n', 0, { loggedIn: 'yes', billing: 'subscription' }],
    ['Logged in using an API key - sk-proj-***abcd\n', 0, { loggedIn: 'yes', billing: 'api-key' }],
    ['Logged in using something new\n', 0, { loggedIn: 'yes', billing: 'unknown' }],
    ['Not logged in\n', 1, { loggedIn: 'no', billing: 'unknown' }],
    ['Not logged in\n', 0, { loggedIn: 'no', billing: 'unknown' }],
    ['Logged in using ChatGPT\n', 1, { loggedIn: 'no', billing: 'unknown' }],
    ['', 0, { loggedIn: 'unknown', billing: 'unknown' }],
    ['some banner', null, { loggedIn: 'unknown', billing: 'unknown' }],
  ] as const)('%j with exit code %s', (output, code, expected) => {
    expect(parseCodexLoginStatus(output, code)).toEqual(expected);
  });
});

describe('parseCodexModels', () => {
  test('keeps the listed models with their label and reasoning levels', () => {
    const catalogue = {
      models: [
        {
          slug: 'gpt-large',
          display_name: 'GPT Large',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'low', description: 'x' },
            { effort: 'high' },
            'max',
            { effort: 'bad value' },
            7,
          ],
        },
        { slug: 'gpt-hidden', visibility: 'hide' },
        { slug: 'gpt-plain', visibility: 'list' },
        { slug: '', visibility: 'list' },
        { visibility: 'list' },
        'junk',
      ],
    };

    expect(parseCodexModels(JSON.stringify(catalogue))).toEqual([
      { id: 'gpt-large', label: 'GPT Large', efforts: ['low', 'high', 'max'] },
      { id: 'gpt-plain' },
    ]);
  });

  test.each(['', 'not json', '[]', '{"models":"none"}', '{}'])(
    'returns nothing for %j',
    (output) => {
      expect(parseCodexModels(output)).toEqual([]);
    },
  );
});

describe('the codex adapter against the mock CLI', () => {
  let harness: MockCliHarness;
  let adapter: ProviderAdapter;
  const instance = cliInstance('codex');

  const setup = async (env: Record<string, string> = {}) => {
    harness = await createMockCliHarness({ env });
    adapter = createCodexAdapter(harness.context);
  };
  beforeEach(() => setup());
  afterEach(() => harness.cleanup());

  const run = async (model?: string, prompt = 'What is 2 + 2?') =>
    collect(adapter.run(instance, await harness.request({ prompt, ...(model ? { model } : {}) })));

  test('declares read-only tool access and the official login command', () => {
    expect(adapter).toMatchObject({
      kind: 'codex',
      toolAccess: 'read-only',
      loginCommand: 'codex login',
    });
  });

  test('answers in whole messages and says so', async () => {
    const events = await run();

    expect(events).toEqual([
      { type: 'start', streaming: 'block' },
      { type: 'delta', text: 'Hello from the mock CLI.' },
      {
        type: 'done',
        elapsedMs: expect.any(Number) as number,
        usage: { inputTokens: 20, outputTokens: 9, reasoningTokens: 3 },
      },
    ]);
  });

  test('sends the prompt on stdin, never in argv, with the work dir as -C and a scrubbed environment', async () => {
    await harness.cleanup();
    await setup({
      OPENAI_API_KEY: 'sk-test',
      CODEX_API_KEY: 'sk-test2',
      CLAUDECODE: '1',
      CODEX_HOME: '/somewhere',
    });
    const prompt = '- --dangerously-bypass-approvals-and-sandbox\n"; rm -rf /';
    const request = await harness.request({ prompt, model: 'gpt-5.5', effort: 'medium' });

    const events = await collect(adapter.run(instance, request));

    expect(events.at(-1)?.type).toBe('done');
    const [call] = await harness.invocations();
    expect(call?.argv).toEqual([
      ...fixedArgs(request.workDir),
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="medium"',
      ...FEATURE_FLAGS,
      '-',
    ]);
    expect(call?.prompt).toBe(prompt);
    expect(call?.cwd).toBe(request.workDir);
    expect(call?.env).toMatchObject({ NO_COLOR: '1', TERM: 'dumb' });
    expect(call?.envNames).toContain('CODEX_HOME');
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CLAUDECODE']) {
      expect(call?.envNames).not.toContain(name);
    }
  });

  test('keeps the API key variables when the instance says to use them', async () => {
    await harness.cleanup();
    await setup({ OPENAI_API_KEY: 'sk-test' });

    await collect(
      adapter.run(cliInstance('codex', { useEnvApiKey: true }), await harness.request()),
    );

    expect((await harness.invocations())[0]?.envNames).toContain('OPENAI_API_KEY');
  });

  test('echoes the prompt it was given', async () => {
    expect(answerOf(await run('mock-echo', 'line 1\nline 2'))).toBe('You said: line 1\nline 2');
  });

  test('emits growth when the CLI updates an item incrementally', async () => {
    const events = await run('mock-incremental');

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'delta', 'done']);
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('maps reasoning items', async () => {
    const events = await run('mock-reasoning');

    expect(reasoningOf(events)).toBe('**Greeting the user**\n');
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
  });

  test('reports a tool call as a notice next to the answer', async () => {
    const events = await run('mock-tool-denied');

    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toContain('command_execution');
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
  });

  test('a crash is an error with the sanitised diagnostics', async () => {
    expect((await run('mock-exit-nonzero')).at(-1)).toEqual({
      type: 'error',
      code: 'unknown',
      message: '`codex` exited with code 3: mock codex: internal failure in <path>',
    });
  });

  test('a CLI version that no longer knows a feature switch gives a clear error', async () => {
    await harness.cleanup();
    await setup({ MOCK_CLI_REMOVED_FEATURE: 'view_image' });

    expect((await run()).at(-1)).toEqual({
      type: 'error',
      code: 'unsupported',
      message:
        'This version of `codex` does not know one of the feature switches this app passes to limit its tools, so it refused to start. Update the app or use a supported CLI version.',
    });
  });

  test('falls back to the raw text for output in another format', async () => {
    const events = await run('mock-garbage');

    expect(answerOf(events)).toContain('This is not the documented output format.');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('refuses an effort that is not a plain word without starting the CLI', async () => {
    const request = await harness.request({ effort: 'high"\nsandbox_mode="danger-full-access' });

    const events = await collect(adapter.run(instance, request));

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'unsupported' });
    expect(await harness.invocations()).toEqual([]);
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
    test('reads the login state from stderr and reports subscription billing', async () => {
      expect(await adapter.detect(instance)).toEqual({
        installed: true,
        version: '0.167.0',
        loggedIn: 'yes',
        billing: 'subscription',
        streaming: 'block',
        hint: RESIDUAL,
      });
      expect((await harness.invocations()).map((call) => call.argv)).toEqual([
        ['--version'],
        ['login', 'status'],
      ]);
    });

    test('reports a logged-out CLI with the command to run', async () => {
      await harness.cleanup();
      await setup({ MOCK_CLI_SCENARIO: 'logged-out' });

      expect(await adapter.detect(instance)).toMatchObject({
        installed: true,
        loggedIn: 'no',
        billing: 'unknown',
        hint: `Not logged in. Run \`codex login\` in a terminal. ${RESIDUAL}`,
      });
    });

    test('reports API key billing only when the key is passed on', async () => {
      await harness.cleanup();
      await setup({ OPENAI_API_KEY: 'sk-test-value' });

      const ignored = await adapter.detect(instance);
      const used = await adapter.detect(cliInstance('codex', { useEnvApiKey: true }));

      expect(ignored).toMatchObject({ billing: 'subscription' });
      expect(ignored.hint).toContain('Not passed to the CLI: OPENAI_API_KEY.');
      // The status command, run with the key, still reports the ChatGPT login.
      expect(used.billing).toBe('subscription');
      expect(used.hint).toContain(
        'Passed to the CLI from the environment: OPENAI_API_KEY. The CLI still reports its own login as the one in use.',
      );
      expect(JSON.stringify([ignored, used])).not.toContain('sk-test-value');
    });

    test('does not claim a billing source when the documented per-run key is passed on', async () => {
      await harness.cleanup();
      await setup({ CODEX_API_KEY: 'sk-test-value' });

      const used = await adapter.detect(cliInstance('codex', { useEnvApiKey: true }));

      expect(used).toMatchObject({ loggedIn: 'yes', billing: 'unknown' });
      expect(used.hint).toContain('Passed to the CLI from the environment: CODEX_API_KEY.');
      expect(used.hint).toContain('which one is billed is not known here');
      expect(used.hint).not.toContain('sk-test-value');
    });

    test('says what the invocation cannot keep away from the model', async () => {
      const { hint } = await adapter.detect(instance);

      expect(hint).toContain('AGENTS.md');
      expect(hint).toContain('skills');
      expect(hint).toContain('sub-agents');
    });

    test('reports a missing CLI', async () => {
      await harness.cleanup();
      await setup({ PATH: '' });

      expect(await adapter.detect(instance)).toMatchObject({
        installed: false,
        loggedIn: 'unknown',
      });
      expect(await adapter.listModels?.(instance)).toEqual([]);
    });

    test('lists the models meant to be listed, with their effort levels', async () => {
      expect(await adapter.listModels?.(instance)).toEqual([
        { id: 'mock-codex-large', label: 'Mock Codex Large', efforts: ['low', 'medium', 'high'] },
        { id: 'mock-codex-small', label: 'Mock Codex Small', efforts: ['low'] },
      ]);
      expect((await harness.invocations()).map((call) => call.argv)).toEqual([['debug', 'models']]);
    });
  });
});
