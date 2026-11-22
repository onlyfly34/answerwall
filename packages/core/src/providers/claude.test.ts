import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter, ProviderEvent } from '../contracts/index.ts';
import {
  buildClaudeArgs,
  CLAUDE_STATUS_ARGS,
  CLAUDE_SYSTEM_PROMPT,
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
  MOCK_BIN_DIR,
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
  '--restricted',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--permission-prompts',
  'none',
  '--system-prompt',
  CLAUDE_SYSTEM_PROMPT,
];

/** The events of a fixture of the mock CLI: a scrubbed recording, or a labelled synthetic one. */
function fixture(name: string): Record<string, unknown>[] {
  const file = path.join(MOCK_BIN_DIR, '..', 'fixtures', 'claude', `${name}.jsonl`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

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

  test('the web search invocation is exactly the confirmed one', () => {
    expect(buildClaudeArgs({ webSearch: true, model: 'haiku', effort: 'low' })).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      'WebSearch',
      '--allowedTools',
      'WebSearch',
      '--strict-mcp-config',
      '--safe-mode',
      '--restricted',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--permission-prompts',
      'none',
      '--system-prompt',
      CLAUDE_SYSTEM_PROMPT,
      '--model',
      'haiku',
      '--effort',
      'low',
    ]);
    expect(buildClaudeArgs({ webSearch: false })).toEqual(RUN_ARGS);
  });

  test('offers the web search alone, with the allow rule it needs, and never the fetch tool', () => {
    const args = buildClaudeArgs({ webSearch: true });
    const plain = buildClaudeArgs({});

    expect(args.slice(args.indexOf('--tools'), args.indexOf('--strict-mcp-config'))).toEqual([
      '--tools',
      'WebSearch',
      '--allowedTools',
      'WebSearch',
    ]);
    expect(args.filter((arg) => !['WebSearch', '--allowedTools'].includes(arg))).toEqual(
      plain.filter((arg) => arg !== ''),
    );
    expect(args.join(' ')).not.toContain('WebFetch');
    expect(plain).not.toContain('--allowedTools');
  });

  test('replaces the system prompt with one that survives any argument quoting', () => {
    expect(CLAUDE_SYSTEM_PROMPT).toMatch(/^[A-Za-z0-9 .,-]+$/);
    expect(CLAUDE_SYSTEM_PROMPT.length).toBeLessThan(1000);
    expect(buildClaudeArgs({})).not.toContain('--append-system-prompt');
  });

  test('never uses --bare or plan mode', () => {
    const args = buildClaudeArgs({ model: 'sonnet' });

    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--permission-mode');
  });

  test('the status commands are the documented ones', () => {
    expect(CLAUDE_VERSION_ARGS).toEqual(['--version']);
    expect(CLAUDE_STATUS_ARGS).toEqual(['auth', 'status', '--json']);
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

function feed(events: Record<string, unknown>[], options: { webSearch?: boolean } = {}) {
  const parser = createClaudeParser(options);
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

describe('createClaudeParser on recorded runs', () => {
  test('the plain answer: text deltas once, usage of the whole run', () => {
    const events = fixture('ok');
    const { content, outcome } = feed(events);

    expect(events[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      tools: [],
      mcp_servers: [],
    });
    expect(content).toEqual([
      { type: 'delta', text: 'Hello from the mock C' },
      { type: 'delta', text: 'LI.' },
    ]);
    expect(outcome).toEqual({ completed: true, usage: { inputTokens: 743, outputTokens: 13 } });
  });

  test('the init line of a restricted run raises no notice although it lists built-in plugins and agents', () => {
    const [init] = fixture('ok');

    expect(init).toMatchObject({ skills: [], slash_commands: [] });
    expect((init?.plugins as unknown[]).length).toBeGreaterThan(0);
    expect((init?.agents as unknown[]).length).toBeGreaterThan(0);
    expect(feed([init ?? {}]).content).toEqual([]);
  });

  test('an allowed request whose overage is rejected is not a quota failure', () => {
    const events = fixture('ok');

    expect(events.find((event) => event.type === 'rate_limit_event')).toMatchObject({
      rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
    });
    expect(feed(events).outcome.failure).toBeUndefined();
  });

  test('an unknown model: the message the CLI makes up is the error, never an answer', () => {
    const { content, outcome } = feed(fixture('model-not-found'));

    expect(content).toEqual([]);
    expect(outcome).toEqual({
      completed: false,
      usage: { inputTokens: 0, outputTokens: 0 },
      failure: {
        code: 'model_not_found',
        message:
          "There's an issue with the selected model (no-such-model-zz9). It may not exist or you may not have access to it. Run --model to pick a different model.",
      },
    });
  });

  test('empty thinking deltas give no reasoning text, only the token count', () => {
    const events = fixture('tool-denied');
    const { content, outcome } = feed(events);

    expect(
      events.filter(
        (event) =>
          event.type === 'stream_event' &&
          (event.event as { delta?: { type?: string } }).delta?.type === 'thinking_delta',
      ).length,
    ).toBeGreaterThan(0);
    expect(content.filter((event) => event.type === 'reasoning')).toEqual([]);
    expect(outcome.usage).toEqual({ inputTokens: 3686, outputTokens: 424, reasoningTokens: 238 });
  });

  test('a tool call the CLI refuses is reported once, and the answer after it is kept', () => {
    const { content, outcome } = feed(fixture('tool-denied'));

    // The run was recorded with the search tool offered, which the first notice points out.
    expect(noticesOf(content as ProviderEvent[])).toEqual([
      'The CLI started with extras that this app switches off (1 tool(s)); they may affect the answer.',
      'The model asked for the tool "WebSearch"; tools are switched off.',
    ]);
    expect(answerOf(content as ProviderEvent[])).toMatch(/^I couldn't check this because/);
    expect(outcome.completed).toBe(true);
  });

  test('a refused search, when the search is offered, is reported as refused', () => {
    const { content } = feed(fixture('tool-denied'), { webSearch: true });

    expect(noticesOf(content as ProviderEvent[])).toEqual([
      'Searching the web: latest stable Python version release 2026',
      'The CLI refused the web search.',
    ]);
  });

  test('a web search: a notice with the query before the answer, the results never shown', () => {
    const events = fixture('web-search');
    const { content, outcome } = feed(events, { webSearch: true });

    expect(events[0]).toMatchObject({ subtype: 'init', tools: ['WebSearch'], mcp_servers: [] });
    expect(content[0]).toEqual({
      type: 'notice',
      message: 'Searching the web: Node.js latest release line and version number November 2026',
    });
    expect(noticesOf(content as ProviderEvent[])).toHaveLength(1);
    expect(answerOf(content as ProviderEvent[])).toMatch(/^The newest Node\.js release line is/);
    expect(answerOf(content as ProviderEvent[])).not.toContain('Web search results for query');
    // The search is a request of its own, which only `modelUsage` counts.
    expect(outcome).toEqual({
      completed: true,
      usage: { inputTokens: 19593, outputTokens: 861, reasoningTokens: 340 },
    });
  });

  test('a run that reports a tool although none is offered raises a notice', () => {
    const { content } = feed(fixture('web-search'));

    expect(noticesOf(content as ProviderEvent[])).toEqual([
      'The CLI started with extras that this app switches off (1 tool(s)); they may affect the answer.',
      'The model asked for the tool "WebSearch"; tools are switched off.',
    ]);
  });
});

describe('createClaudeParser on shapes that were not recorded', () => {
  test('counts what the init line should not list', () => {
    const { content } = feed([
      {
        type: 'system',
        subtype: 'init',
        tools: ['Bash', 'Read'],
        mcp_servers: [{ name: 'private-server', status: 'connected' }],
        skills: ['private-skill'],
        slash_commands: ['private-command'],
        plugins: [
          { name: 'shipped', path: 'builtin' },
          { name: 'private-plugin', path: '/home/someone/plugins/private-plugin' },
        ],
      },
    ]);

    expect(noticesOf(content as ProviderEvent[])).toEqual([
      'The CLI started with extras that this app switches off (2 tool(s), 1 MCP server(s), 1 skill(s), 1 command(s), 1 plugin(s)); they may affect the answer.',
    ]);
    expect(JSON.stringify(content)).not.toMatch(/private|someone/);
  });

  test('a search query is shown as one bounded line', () => {
    const { content } = feed(
      [
        assistant([
          {
            type: 'tool_use',
            name: 'WebSearch',
            input: { query: `first\nsecond\u001b[31m ${'x'.repeat(400)}` },
          },
        ]),
        assistant([{ type: 'tool_use', name: 'WebSearch', input: {} }]),
        assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      ],
      { webSearch: true },
    );
    const notices = noticesOf(content);

    expect(notices[0]).toMatch(/^Searching the web: first second \[31m x+…$/);
    expect(notices[0]?.length).toBeLessThan(220);
    expect(notices.slice(1)).toEqual([
      'Searching the web…',
      'The model asked for the tool "Bash"; tools are switched off.',
    ]);
  });

  test('the error of a made-up message outranks an earlier retry error', () => {
    const { content, outcome } = feed([
      { type: 'system', subtype: 'api_retry', error: 'overloaded' },
      {
        ...assistant([{ type: 'text', text: 'Not logged in' }]),
        error: 'authentication_failed',
        is_api_error_message: true,
      },
      { type: 'result', subtype: 'success', is_error: true, result: '' },
    ]);

    expect(answerOf(content as ProviderEvent[])).toBe('');
    expect(outcome.failure).toEqual({ message: 'Not logged in', code: 'not_logged_in' });
  });

  test('thinking tokens are reported as reasoning tokens', () => {
    const { outcome } = feed([
      {
        type: 'result',
        subtype: 'success',
        result: 'x',
        usage: {
          input_tokens: 2,
          output_tokens: 30,
          output_tokens_details: { thinking_tokens: 20 },
        },
      },
    ]);

    expect(outcome.usage).toEqual({ inputTokens: 2, outputTokens: 30, reasoningTokens: 20 });
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

    expect(typesOf(events)).toEqual(['start', 'delta', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'token' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 743, outputTokens: 13 } });
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
    expect(noticesOf(events)).toEqual([]);
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

  test("passes the CLI's own login token on and never the application's own variables", async () => {
    await harness.cleanup();
    await setup({
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-value',
      ANSWERWALL_TOKEN: 'static-token-0123456789',
      ANSWERWALL_SECRET_PROVIDER_EP_API_KEY: 'sk-endpoint-key',
    });

    for (const useEnvApiKey of [false, true]) {
      const events = await collect(
        adapter.run(cliInstance('claude', { useEnvApiKey }), await harness.request()),
      );
      expect(events.at(-1)?.type).toBe('done');
    }
    await adapter.detect(instance);

    const calls = await harness.invocations();
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.envNames).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(call.envNames?.filter((name) => name.startsWith('ANSWERWALL_'))).toEqual([]);
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

  test('says so when the effort level is one the CLI would silently ignore', async () => {
    const request = await harness.request({ effort: 'ultra' });

    const events = await collect(adapter.run(instance, request));

    expect(typesOf(events).slice(0, 2)).toEqual(['start', 'notice']);
    expect(noticesOf(events)).toEqual([
      'The effort level "ultra" is not one the CLI documents (low, medium, high, xhigh, max); it ignores an unknown level and uses its default.',
    ]);
    expect((await harness.invocations())[0]?.argv?.slice(-2)).toEqual(['--effort', 'ultra']);
    expect(events.at(-1)?.type).toBe('done');
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
      'The model asked for the tool "WebSearch"; tools are switched off.',
    ]);
    expect(answerOf(events)).toMatch(/^I couldn't check this because/);
    expect(events.at(-1)?.type).toBe('done');
  });

  test('an instance that allows web search starts the CLI with the search alone and reports the search', async () => {
    const events = await collect(
      adapter.run(cliInstance('claude', { webSearch: true }), await harness.request()),
    );

    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(buildClaudeArgs({ webSearch: true }));
    expect(noticesOf(events)).toHaveLength(1);
    expect(noticesOf(events)[0]).toMatch(/^Searching the web: \S/);
    expect(answerOf(events)).not.toBe('');
    expect(events.at(-1)?.type).toBe('done');
  });

  test('an instance without the switch never offers the search', async () => {
    await run();

    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(buildClaudeArgs({}));
    expect(call?.argv).not.toContain('WebSearch');
  });

  test('with the search allowed, a refused search is reported as refused', async () => {
    const events = await collect(
      adapter.run(
        cliInstance('claude', { webSearch: true }),
        await harness.request({ model: 'mock-tool-denied' }),
      ),
    );

    expect(noticesOf(events)).toContain('The CLI refused the web search.');
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

  test("an unknown model is reported with the CLI's own sentence", async () => {
    const events = await run('mock-model-not-found');

    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'model_not_found',
      message:
        "There's an issue with the selected model (no-such-model-zz9). It may not exist or you may not have access to it. Run --model to pick a different model.",
    });
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
      expect(calls.map((call) => call.argv)).toEqual([['--version'], ['auth', 'status', '--json']]);
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

    test('a base URL alone does not make it API key billing: the status command decides', async () => {
      await harness.cleanup();
      await setup({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });

      const detection = await adapter.detect(cliInstance('claude', { useEnvApiKey: true }));

      expect(detection).toMatchObject({ loggedIn: 'yes', billing: 'subscription' });
      expect(detection.hint).toBe(
        'Passed to the CLI from the environment: ANTHROPIC_BASE_URL. The CLI still reports its own login as the one in use.',
      );
    });

    test('names a profile variable that is present but not passed on', async () => {
      await harness.cleanup();
      await setup({ ANTHROPIC_PROFILE: 'work' });

      const detection = await adapter.detect(instance);

      expect(detection.hint).toContain('Not passed to the CLI: ANTHROPIC_PROFILE.');
      expect((await harness.invocations())[0]?.envNames).not.toContain('ANTHROPIC_PROFILE');
    });

    test('a login through the token variable is a subscription login, named without its value', async () => {
      await harness.cleanup();
      await setup({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-test-value' });

      const detection = await adapter.detect(instance);

      expect(detection).toMatchObject({ loggedIn: 'yes', billing: 'subscription' });
      expect(detection.hint).toBe(
        'CLAUDE_CODE_OAUTH_TOKEN is set in the environment and is passed to the CLI as its own login.',
      );
      expect(JSON.stringify([detection, harness.logger.entries])).not.toContain('oat-test-value');
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
