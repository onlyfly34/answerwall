import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter } from '../contracts/index.ts';
import { parseJsonLine } from './cli/run-cli.ts';
import type { ContentEvent } from './cli/run-cli.ts';
import {
  buildCodexArgs,
  CODEX_DISABLED_FEATURES,
  CODEX_ISOLATION_OVERRIDES,
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
const ISOLATION = [
  'project_doc_max_bytes=0',
  'skills.bundled.enabled=false',
  'skills.include_instructions=false',
  'include_permissions_instructions=false',
  'include_apps_instructions=false',
  'include_environment_context=false',
  'include_collaboration_mode_instructions=false',
  'tools.experimental_request_user_input.enabled=false',
  'agents.max_depth=0',
  'features.multi_agent_v2.disable_native_tools=true',
  'features.multi_agent_v2.multi_agent_mode_hint_text=""',
  'features.multi_agent_v2.root_agent_usage_hint_text=""',
];
const overrides = (search: 'disabled' | 'live' = 'disabled'): string[] =>
  [`web_search="${search}"`, ...ISOLATION].flatMap((setting) => ['-c', setting]);
const RESIDUAL =
  "The model cannot run commands or read your files. Still sent: the CLI's own instructions and your global AGENTS.md, if any. Still offered: a script tool that can read the clock and try a file edit, which the read-only sandbox refuses.";
/** A scrubbed recording of the real CLI, as the events it printed. */
const recorded = (name: string): Record<string, unknown>[] =>
  readFileSync(
    new URL(`../../../../tools/mock-clis/fixtures/codex/${name}.jsonl`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .flatMap((line) => {
      const event = parseJsonLine(line);
      return event === undefined ? [] : [event];
    });
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
      ...overrides(),
      ...FEATURE_FLAGS,
      '-',
    ]);
  });

  test('web search is always stated: off, or on as the only addition', () => {
    const off = buildCodexArgs({ workDir: '/work/dir', webSearch: false });
    const on = buildCodexArgs({ workDir: '/work/dir', webSearch: true });

    expect(off).toEqual(buildCodexArgs({ workDir: '/work/dir' }));
    expect(on).toEqual([...fixedArgs('/work/dir'), ...overrides('live'), ...FEATURE_FLAGS, '-']);
  });

  test('adds the model and passes the effort as a quoted configuration value', () => {
    expect(buildCodexArgs({ workDir: 'C:\\work dir', model: 'gpt-5.5', effort: 'high' })).toEqual([
      ...fixedArgs('C:\\work dir'),
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
      ...overrides(),
      ...FEATURE_FLAGS,
      '-',
    ]);
  });

  test('passes exactly the confirmed overrides', () => {
    expect(CODEX_ISOLATION_OVERRIDES).toEqual(ISOLATION);
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
      'The model searched the web.',
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

  test('reads the message out of a refusal the service sent as JSON', () => {
    const body = JSON.stringify({ error: { message: 'Bad request.' }, status: 400 }, null, 2);

    expect(feed([{ type: 'turn.failed', error: { message: body } }]).outcome.failure).toEqual({
      message: 'Bad request.',
    });
    expect(feed([{ type: 'error', message: '{"detail":"No."}' }]).outcome.failure).toEqual({
      message: 'No.',
    });
    expect(feed([{ type: 'error', message: '{"other":1}' }]).outcome.failure).toEqual({
      message: '{"other":1}',
    });
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

describe('createCodexParser on recordings of the real CLI (0.167.0)', () => {
  test('a one-word answer: one whole message, then the usage', () => {
    const { content, outcome } = feed(recorded('reply-ok'));

    expect(content).toEqual([{ type: 'delta', text: 'OK' }]);
    expect(outcome).toEqual({
      completed: true,
      usage: { inputTokens: 6319, outputTokens: 5, reasoningTokens: 0 },
    });
  });

  test('no recording holds an item.updated line or a text delta', () => {
    const names = [
      'reply-ok',
      'reasoning',
      'tool-denied',
      'web-search',
      'invalid-effort',
      'model-not-found',
      'logged-out',
    ];
    const types = new Set(names.flatMap((name) => recorded(name).map((event) => event.type)));

    expect([...types].sort()).toEqual([
      'error',
      'item.completed',
      'item.started',
      'thread.started',
      'turn.completed',
      'turn.failed',
      'turn.started',
    ]);
  });

  test('a reasoning summary is one whole item before the answer', () => {
    const { content, outcome } = feed(recorded('reasoning'));

    expect(content).toEqual([
      { type: 'reasoning', text: '**Counting primes in range**\n' },
      { type: 'delta', text: '16' },
    ]);
    expect(outcome.usage).toEqual({ inputTokens: 8418, outputTokens: 250, reasoningTokens: 243 });
  });

  test('asked to read and write files, it prints two messages and no tool item', () => {
    const { content, outcome } = feed(recorded('tool-denied'));

    expect(typesOf(content)).toEqual(['delta', 'delta']);
    expect(answerOf(content)).toMatch(/^I’ll read the specified file[^]*\n\n1\. I could not read/);
    expect(answerOf(content)).toContain('blocked by the sandbox’s read-only policy');
    expect(outcome.completed).toBe(true);
  });

  test('a web search is reported once, next to the answer', () => {
    const { content, outcome } = feed(recorded('web-search'));

    expect(noticesOf(content)).toEqual(['The model searched the web.']);
    expect(answerOf(content)).toContain('**v26**');
    expect(outcome.completed).toBe(true);
  });

  test('a refused reasoning effort is an unsupported request with the readable message', () => {
    const { content, outcome } = feed(recorded('invalid-effort'));

    expect(content).toEqual([]);
    expect(outcome).toEqual({
      completed: false,
      failure: {
        code: 'unsupported',
        message:
          "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.",
      },
    });
  });

  test('an unknown model: a notice about its metadata, then the failure', () => {
    const { content, outcome } = feed(recorded('model-not-found'));

    expect(noticesOf(content)).toEqual([
      'Model metadata for `no-such-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    ]);
    expect(outcome.failure).toEqual({
      message:
        "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    });
  });

  test('without a login the retries end in a 401 failure', () => {
    const { content, outcome } = feed(recorded('logged-out'));

    expect(noticesOf(content)).toHaveLength(1);
    expect(noticesOf(content)[0]).toContain('Falling back from WebSockets to HTTPS transport.');
    expect(outcome.completed).toBe(false);
    expect(outcome.failure?.message).toMatch(/^unexpected status 401 Unauthorized/);
  });
});

describe('parseCodexLoginStatus', () => {
  test.each([
    ['Logged in using ChatGPT\n', 0, { loggedIn: 'yes', billing: 'subscription' }],
    ['Logged in using an API key - sk-proj-***abcd\n', 0, { loggedIn: 'yes', billing: 'api-key' }],
    ['Logged in using something new\n', 0, { loggedIn: 'yes', billing: 'unknown' }],
    ['Logged in using access token\n', 0, { loggedIn: 'yes', billing: 'unknown' }],
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

  test('an instance that allows web search switches the hosted search on and reports the search', async () => {
    const request = await harness.request();

    const events = await collect(adapter.run(cliInstance('codex', { webSearch: true }), request));

    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(buildCodexArgs({ workDir: request.workDir, webSearch: true }));
    expect(call?.argv).toContain('web_search="live"');
    expect(noticesOf(events)).toEqual(['The model searched the web.']);
    expect(answerOf(events)).not.toBe('');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('an instance without the switch states that the search is off', async () => {
    const request = await harness.request();

    const events = await collect(adapter.run(instance, request));

    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(buildCodexArgs({ workDir: request.workDir }));
    expect(call?.argv).toContain('web_search="disabled"');
    expect(noticesOf(events)).toEqual([]);
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
      ...overrides(),
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

  test('maps a reasoning summary', async () => {
    const events = await run('mock-reasoning');

    expect(reasoningOf(events)).toBe('**Counting primes in range**\n');
    expect(answerOf(events)).toBe('16');
  });

  test('joins the messages of a turn in which the model could use no tool', async () => {
    const events = await run('mock-tool-denied');

    expect(noticesOf(events)).toEqual([]);
    expect(answerOf(events)).toContain('I could not read');
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

  test('a logged-out run says so once, with the request identifiers left out', async () => {
    const events = await run('mock-logged-out');

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in' });
    expect(JSON.stringify(events)).not.toMatch(/request id: [^<]/);
  });

  test('a CLI version that no longer knows a feature switch gives a clear error', async () => {
    await harness.cleanup();
    await setup({ MOCK_CLI_REMOVED_FEATURE: 'view_image' });

    expect((await run()).at(-1)).toEqual({
      type: 'error',
      code: 'unsupported',
      message:
        'This version of `codex` does not accept one of the switches this app passes to limit its tools, so it refused to start. Update the app or use a supported CLI version.',
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

    test('reports API key billing when the key a run uses is passed on', async () => {
      await harness.cleanup();
      await setup({ CODEX_API_KEY: 'sk-test-value' });

      const ignored = await adapter.detect(instance);
      const used = await adapter.detect(cliInstance('codex', { useEnvApiKey: true }));

      expect(ignored).toMatchObject({ loggedIn: 'yes', billing: 'subscription' });
      expect(ignored.hint).toContain('Not passed to the CLI: CODEX_API_KEY.');
      // The status command still reports the ChatGPT login; the run does not use it.
      expect(used).toMatchObject({ loggedIn: 'yes', billing: 'api-key' });
      expect(used.hint).toContain(
        'Passed to the CLI from the environment: CODEX_API_KEY. Runs are billed to this key, whatever login `codex login status` reports.',
      );
      expect(JSON.stringify([ignored, used])).not.toContain('sk-test-value');
    });

    test('does not call a CLI without a saved login logged out when a key is passed on', async () => {
      await harness.cleanup();
      await setup({ CODEX_API_KEY: 'sk-test-value', MOCK_CLI_SCENARIO: 'logged-out' });

      const used = await adapter.detect(cliInstance('codex', { useEnvApiKey: true }));
      const ignored = await adapter.detect(instance);

      expect(used).toMatchObject({ loggedIn: 'unknown', billing: 'api-key' });
      expect(used.hint).not.toContain('Not logged in');
      expect(ignored).toMatchObject({ loggedIn: 'no', billing: 'unknown' });
    });

    test('says what the invocation cannot keep away from the model, within the hint limit', async () => {
      await harness.cleanup();
      await setup({ CODEX_API_KEY: 'k', OPENAI_API_KEY: 'k', MOCK_CLI_SCENARIO: 'logged-out' });

      const { hint } = await adapter.detect(instance);

      expect(hint).toContain('AGENTS.md');
      expect(hint).toContain('script tool');
      expect(hint?.endsWith(RESIDUAL)).toBe(true);
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
