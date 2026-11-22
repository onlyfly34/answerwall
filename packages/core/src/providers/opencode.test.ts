import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ProviderAdapter } from '../contracts/index.ts';
import type { ContentEvent } from './cli/run-cli.ts';
import {
  buildOpencodeArgs,
  buildOpencodeProjectConfig,
  createOpencodeAdapter,
  createOpencodeParser,
  OPENCODE_AGENT,
  OPENCODE_MODELS_ARGS,
  OPENCODE_PROJECT_FILE,
  OPENCODE_STATUS_ARGS,
  OPENCODE_SYSTEM_PROMPT,
  OPENCODE_VERSION_ARGS,
  opencodeModelReference,
  parseOpencodeAuthList,
  parseOpencodeModels,
} from './opencode.ts';
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

/** The events of a fixture recorded from the real CLI. */
function recording(name: string): Record<string, unknown>[] {
  const file = fileURLToPath(
    new URL(`../../../../tools/mock-clis/fixtures/opencode/${name}.jsonl`, import.meta.url),
  );
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function feed(events: Record<string, unknown>[]) {
  const parser = createOpencodeParser();
  const content: ContentEvent[] = events.flatMap((event) => parser.event(event));
  return { content, outcome: parser.outcome() };
}

describe('buildOpencodeArgs', () => {
  test('is the headless run on a private server with the tool-less agent', () => {
    expect(buildOpencodeArgs({ model: 'acme/qwen3-coder' })).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '--thinking',
      '--archived',
      '--title',
      'AnswerWall',
      '--agent',
      'answerwall',
      '--model',
      'acme/qwen3-coder',
    ]);
  });

  test('without a model the CLI keeps the default of its own configuration', () => {
    const args = buildOpencodeArgs({});

    expect(args).not.toContain('--model');
    expect(args.at(-1)).toBe(OPENCODE_AGENT);
  });

  test('never approves permissions, continues a session or carries a message', () => {
    const args = buildOpencodeArgs({ model: 'acme/m', effort: 'high' });

    for (const flag of ['--auto', '--continue', '-c', '--session', '--server', '--file']) {
      expect(args).not.toContain(flag);
    }
    // Every argument is a fixed word or the model reference: the prompt travels on stdin.
    expect(args.filter((arg) => !arg.startsWith('-'))).toEqual([
      'run',
      'json',
      'AnswerWall',
      'answerwall',
      'acme/m#high',
    ]);
  });

  test('the status commands use a private server too', () => {
    expect(OPENCODE_VERSION_ARGS).toEqual(['--version']);
    expect(OPENCODE_STATUS_ARGS).toEqual(['auth', 'list', '--standalone', '--format', 'json']);
    expect(OPENCODE_MODELS_ARGS).toEqual(['models', '--standalone']);
  });
});

describe('opencodeModelReference', () => {
  test.each([
    [{}, undefined],
    [{ effort: 'high' }, undefined],
    [{ model: 'acme/m' }, 'acme/m'],
    [{ model: 'acme/m', effort: 'high' }, 'acme/m#high'],
    [{ model: 'acme/m#deep' }, 'acme/m#deep'],
    [{ model: 'acme/m#deep', effort: 'low' }, 'acme/m#low'],
  ])('%j gives %s', (selection, reference) => {
    expect(opencodeModelReference(selection)).toBe(reference);
  });
});

describe('buildOpencodeProjectConfig', () => {
  const config = JSON.parse(buildOpencodeProjectConfig()) as {
    agents: Record<string, { mode: string; system: string; permissions: unknown[] }>;
    policies: unknown[];
    snapshots: boolean;
  };

  test('defines one agent that denies every permission and replaces the system prompt', () => {
    expect(Object.keys(config.agents)).toEqual(['answerwall']);
    expect(config.agents.answerwall).toMatchObject({
      mode: 'primary',
      system: OPENCODE_SYSTEM_PROMPT,
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    });
  });

  test('denies tools, MCP servers, skills and web search by policy', () => {
    expect(config.policies).toEqual(
      ['tool.use', 'mcp.use', 'skill.use', 'websearch.use'].map((action) => ({
        action,
        resource: '*',
        effect: 'deny',
      })),
    );
    expect(config.snapshots).toBe(false);
  });

  test('says nothing about providers, models or credentials', () => {
    expect(Object.keys(config).sort()).toEqual(['agents', 'policies', 'snapshots']);
    expect(buildOpencodeProjectConfig()).not.toMatch(/provider|apiKey|baseURL|"model"/);
  });
});

describe('createOpencodeParser', () => {
  test('a recorded answer is one whole text part with the usage of its step', () => {
    const { content, outcome } = feed(recording('ok'));

    expect(content).toEqual([{ type: 'delta', text: 'Hello from the mock CLI.' }]);
    expect(outcome).toEqual({ completed: true, usage: { inputTokens: 18, outputTokens: 9 } });
  });

  test('reasoning is printed before the answer and counted as part of the output', () => {
    const { content, outcome } = feed(recording('reasoning'));

    expect(content).toEqual([
      { type: 'reasoning', text: 'The user greets me.\n' },
      { type: 'delta', text: 'Hello from the mock CLI.' },
    ]);
    // The CLI reports output 7 and reasoning 2 for a completion of 9 tokens.
    expect(outcome.usage).toEqual({ inputTokens: 18, outputTokens: 9, reasoningTokens: 2 });
  });

  test('a refused tool call is a notice, and the steps of the turn are added up', () => {
    const { content, outcome } = feed(recording('tool-denied'));

    expect(content).toEqual([
      {
        type: 'notice',
        message:
          'The model asked for a tool (skill). Tools are switched off, so the call was refused.',
      },
      { type: 'delta', text: 'I cannot use tools here.' },
    ]);
    expect(outcome).toEqual({ completed: true, usage: { inputTokens: 29, outputTokens: 16 } });
  });

  test('a step that ends with tool calls does not complete the answer', () => {
    const steps = recording('tool-denied');

    expect(feed(steps.slice(0, 3)).outcome.completed).toBe(false);
  });

  test('a tool that did run is reported as such, once per tool, with a harmless name', () => {
    const tool = (name: unknown, status: string) => ({
      type: 'tool_use',
      part: { type: 'tool', tool: name, state: { status } },
    });

    expect(
      noticesOf(
        feed([
          tool('shell', 'completed'),
          tool('shell', 'completed'),
          tool('web<script>fetch', 'error'),
          tool(undefined, 'error'),
        ]).content,
      ),
    ).toEqual([
      'The model used a tool (shell) although tools are switched off for this agent. Check the opencode configuration on this machine.',
      'The model asked for a tool (webscriptfetch). Tools are switched off, so the call was refused.',
      'The model asked for a tool (unknown). Tools are switched off, so the call was refused.',
    ]);
  });

  test('text parts of one answer are separated by a blank line', () => {
    const text = (id: string, value: string) => ({
      type: 'text',
      part: { id, type: 'text', text: value },
    });

    expect(feed([text('a', 'First.'), text('b', 'Second.')]).content).toEqual([
      { type: 'delta', text: 'First.' },
      { type: 'delta', text: '\n\nSecond.' },
    ]);
  });

  test('a part that is printed again while it grows is emitted as it grows', () => {
    const text = (value: string) => ({
      type: 'text',
      part: { id: 'p', type: 'text', text: value },
    });

    expect(feed([text('Hel'), text('Hello'), text('Hello')]).content).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
  });

  test.each([
    ['quota', { code: 'quota', message: 'You exceeded your current quota (HTTP 429)' }],
    ['logged-out', { code: 'not_logged_in', message: 'bad key (HTTP 401)' }],
    [
      'model-not-found',
      { code: 'model_not_found', message: 'The model `stub-missing` does not exist (HTTP 404)' },
    ],
    ['no-route', { code: 'model_not_found', message: 'Model unavailable: stub/nope' }],
    [
      'bad-variant',
      { code: 'model_not_found', message: 'Variant unavailable for stub/stub-hello: nope' },
    ],
  ] as const)('the recorded %s failure is %j', (name, failure) => {
    expect(feed(recording(name)).outcome).toEqual({ completed: false, failure });
  });

  const STOPPED =
    'opencode was about to send the question again by itself and was stopped; press Send to try again. The model provider reported: ';

  test.each([
    [
      'rate-limited',
      { code: 'rate_limited', message: 'Rate limit reached for requests (HTTP 429)' },
    ],
    [
      'network',
      {
        code: 'network',
        message: 'ECONNREFUSED: Unable to connect. Is the computer able to access the url?',
      },
    ],
    // A server error has no code of its own; it is judged by its message.
    ['server-error', { message: 'internal stub failure (HTTP 500)' }],
  ] as const)(
    'the first retry line of the recorded %s failure stops the run with that failure',
    (name, reported) => {
      const lines = recording(name);
      const first = lines.findIndex((line) => line.type === 'retry');
      const parser = createOpencodeParser();

      for (const line of lines.slice(0, first)) parser.event(line);
      expect(parser.stopped?.()).toBe(false);
      expect(parser.event(lines[first]!)).toEqual([]);

      expect(parser.stopped?.()).toBe(true);
      const failure = { ...reported, message: STOPPED + reported.message };
      expect(parser.outcome()).toEqual({ completed: false, failure });
      // What the CLI prints while it is being killed changes nothing.
      for (const line of lines.slice(first + 1)) expect(parser.event(line)).toEqual([]);
      expect(parser.outcome()).toEqual({ completed: false, failure });
    },
  );

  test('a run without a retry line is never stopped', () => {
    const parser = createOpencodeParser();

    for (const name of ['ok', 'quota', 'tool-denied']) {
      for (const line of recording(name)) parser.event(line);
    }

    expect(parser.stopped?.()).toBe(false);
  });

  test('a run that did not load the agent says why instead of the CLI message', () => {
    const { failure } = feed(recording('agent-not-found')).outcome;

    expect(failure?.code).toBe('unsupported');
    expect(failure?.message).toContain('did not load the agent');
    expect(failure?.message).toContain('OPENCODE_DISABLE_PROJECT_CONFIG');
  });

  test('an error after a finished step is still a failure', () => {
    const [start, , finish] = recording('ok');
    const { outcome } = feed([
      start!,
      finish!,
      { type: 'error', error: { type: 'unknown', message: 'late failure' } },
    ]);

    expect(outcome.completed).toBe(false);
    expect(outcome.failure).toEqual({ message: 'late failure' });
  });

  test('ignores unknown events and malformed parts', () => {
    const { content, outcome } = feed([
      { type: 'step_start' },
      { type: 'session.updated', part: { text: 'x' } },
      { type: 'text' },
      { type: 'text', part: 7 },
      { type: 'text', part: { id: 'p', text: 7 } },
      { type: 'reasoning', part: {} },
      { type: 'step_finish', part: { reason: 'tool-calls', tokens: 'many' } },
      { type: 'error' },
      {},
    ]);

    expect(content).toEqual([]);
    expect(outcome).toEqual({
      completed: false,
      failure: { message: 'The CLI reported an error.' },
    });
  });
});

describe('parseOpencodeAuthList', () => {
  test('any connection means a provider is connected', () => {
    expect(
      parseOpencodeAuthList(
        JSON.stringify([
          { id: 'a', name: 'A', connections: [] },
          { id: 'b', name: 'B', connections: [{ type: 'env', name: 'B_KEY' }] },
        ]),
      ),
    ).toBe('yes');
  });

  test.each(['[]', '[{"id":"a","connections":[]}]', '{}', 'No authenticated integrations', ''])(
    '%j is unknown, never "no"',
    (output) => {
      expect(parseOpencodeAuthList(output)).toBe('unknown');
    },
  );
});

describe('parseOpencodeModels', () => {
  test('keeps the provider/model lines, also without a dash or digit in them', () => {
    expect(
      parseOpencodeModels(
        'opencode/big-pickle\r\nacme/qwen\nacme/qwen\n\nUsage: opencode models\nnot a model\n-x/y\n',
      ),
    ).toEqual([{ id: 'opencode/big-pickle' }, { id: 'acme/qwen' }]);
  });
});

describe('the opencode adapter against the mock CLI', () => {
  let harness: MockCliHarness;
  let adapter: ProviderAdapter;
  const instance = cliInstance('opencode');

  const setup = async (env: Record<string, string> = {}) => {
    harness = await createMockCliHarness({ env });
    adapter = createOpencodeAdapter(harness.context);
  };
  beforeEach(() => setup());
  afterEach(() => harness.cleanup());

  const run = async (model?: string, prompt = 'What is 2 + 2?', effort?: string) =>
    collect(
      adapter.run(
        instance,
        await harness.request({
          prompt,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
        }),
      ),
    );

  test('declares its tools as switched off and the official login command', () => {
    expect(adapter).toMatchObject({
      kind: 'opencode',
      toolAccess: 'disabled',
      loginCommand: 'opencode auth login',
    });
  });

  test('answers in one block with usage', async () => {
    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'delta', 'done']);
    expect(events[0]).toEqual({ type: 'start', streaming: 'block' });
    expect(answerOf(events)).toBe('Hello from the mock CLI.');
    expect(events.at(-1)).toMatchObject({ usage: { inputTokens: 18, outputTokens: 9 } });
  });

  test('passes the prompt on stdin and the agent in a project file of the work dir', async () => {
    await harness.cleanup();
    await setup({
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ACME_API_KEY: 'gateway-key',
      CLAUDECODE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '0',
    });
    const prompt = '--auto\n$(id) "quoted" 問題';
    const request = await harness.request({ prompt, model: 'mock/mock-echo', effort: 'high' });

    const events = await collect(adapter.run(instance, request));

    expect(answerOf(events)).toBe(`You said: ${prompt}`);
    const [call] = await harness.invocations();
    expect(call?.argv).toEqual(buildOpencodeArgs({ model: 'mock/mock-echo', effort: 'high' }));
    expect(call?.argv?.join(' ')).not.toContain('quoted');
    expect(call?.prompt).toBe(prompt);
    expect(call?.cwd).toBe(request.workDir);
    expect(await readFile(path.join(request.workDir, OPENCODE_PROJECT_FILE), 'utf8')).toBe(
      buildOpencodeProjectConfig(),
    );
    expect(call?.env).toMatchObject({
      NO_COLOR: '1',
      TERM: 'dumb',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: null,
    });
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE']) {
      expect(call?.envNames).not.toContain(name);
    }
    // A key under a name of the user's own choosing is how a gateway is usually configured.
    expect(call?.envNames).toContain('ACME_API_KEY');
  });

  test('keeps the API key variables when the instance says to use them', async () => {
    await harness.cleanup();
    await setup({ OPENAI_API_KEY: 'sk-test' });

    await collect(
      adapter.run(cliInstance('opencode', { useEnvApiKey: true }), await harness.request()),
    );

    expect((await harness.invocations())[0]?.envNames).toContain('OPENAI_API_KEY');
  });

  test('echoes a long prompt intact', async () => {
    const prompt = 'x'.repeat(100_000);

    expect(answerOf(await run('mock/mock-echo', prompt))).toBe(`You said: ${prompt}`);
  });

  test('maps reasoning and refused tool calls', async () => {
    expect(reasoningOf(await run('mock/mock-reasoning'))).toBe('The user greets me.\n');

    const denied = await run('mock/mock-tool-denied');
    expect(noticesOf(denied)).toEqual([
      'The model asked for a tool (skill). Tools are switched off, so the call was refused.',
    ]);
    expect(answerOf(denied)).toBe('I cannot use tools here.');
    expect(denied.at(-1)?.type).toBe('done');
  });

  test.each([
    ['mock/mock-logged-out', 'not_logged_in'],
    ['mock/mock-quota', 'quota'],
    ['mock/mock-model-not-found', 'model_not_found'],
    ['no-slash', 'model_not_found'],
  ] as const)('%s ends with the error code %s', async (model, code) => {
    const events = await run(model);

    expect(events.at(-1)).toMatchObject({ type: 'error', code });
    expect(events.filter((event) => event.type === 'done' || event.type === 'error')).toHaveLength(
      1,
    );
  });

  test('a failure the CLI would answer by sending the question again ends the run at once', async () => {
    await harness.cleanup();
    await setup({ MOCK_OPENCODE_RETRY_MS: '300' });

    const events = await run('mock/mock-rate-limited');

    expect(typesOf(events)).toEqual(['start', 'error']);
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'rate_limited',
      message:
        'opencode was about to send the question again by itself and was stopped; press Send to try again. The model provider reported: Rate limit reached for requests (HTTP 429)',
    });
    const [call] = await harness.invocations();
    expect(call?.pid !== undefined && isAlive(call.pid)).toBe(false);
    // Past the moment the CLI would have tried again: it never got that far.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await harness.invocations()).some((entry) => entry.resent)).toBe(false);
  });

  test.each([
    ['acme/m#a#b', undefined, 'model_not_found'],
    ['acme/m#bad variant', undefined, 'model_not_found'],
    ['--auto', undefined, 'model_not_found'],
    ['acme/m', 'two words', 'unsupported'],
    [undefined, 'high', 'unsupported'],
  ] as const)(
    'refuses model %j with effort %j before starting anything',
    async (model, effort, code) => {
      const events = await run(model, 'hi', effort);

      expect(events).toMatchObject([{ type: 'start' }, { type: 'error', code }]);
      expect(await harness.invocations()).toEqual([]);
    },
  );

  test('a run whose project file was not read fails instead of answering with tools', async () => {
    await harness.cleanup();
    // The user's own environment can switch project configuration off; the CLI then lacks the agent.
    await setup({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' });

    const events = await run();

    expect(typesOf(events)).toEqual(['start', 'error']);
    expect(events.at(-1)).toMatchObject({ code: 'unsupported' });
    expect(events.at(-1)).toMatchObject({
      message: expect.stringContaining('did not load the agent') as unknown,
    });
  });

  test('version 1 of the CLI is reported as too old, by detection and by a run', async () => {
    await harness.cleanup();
    await setup({ MOCK_OPENCODE_LEGACY: '1' });

    const detection = await adapter.detect(instance);
    expect(detection).toMatchObject({ installed: true, version: '1.19.6', loggedIn: 'unknown' });
    expect(detection.hint).toContain('opencode 2 or later');
    // Only the version command ran: the status command of version 2 is not tried on version 1.
    expect((await harness.invocations()).map((call) => call.argv)).toEqual([OPENCODE_VERSION_ARGS]);

    expect((await run()).at(-1)).toEqual({
      type: 'error',
      code: 'unsupported',
      message:
        'This opencode does not accept the arguments used here. Version 2 or later is needed.',
    });
  });

  test('a crash is an error with the sanitised diagnostics', async () => {
    expect((await run('mock/mock-exit-nonzero')).at(-1)).toMatchObject({
      type: 'error',
      code: 'unknown',
      message: '`opencode` exited with code 3: mock opencode: internal failure in <path>',
    });
  });

  test.each(['mock/mock-hang', 'mock/mock-init-hang', 'mock/mock-tree'])(
    'cancelling a %s run stops it and leaves no process',
    async (model) => {
      const stop = new AbortController();
      const done = collect(
        adapter.run(instance, await harness.request({ model, signal: stop.signal })),
      );

      await until(async () =>
        (await harness.invocations()).some((call) => call.scenario !== undefined),
      );
      if (model === 'mock/mock-tree') {
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
    test('reports the version and a connected provider, without its name', async () => {
      const detection = await adapter.detect(instance);

      expect(detection).toMatchObject({
        installed: true,
        version: '2.3.2',
        loggedIn: 'yes',
        billing: 'unknown',
        streaming: 'block',
      });
      expect(detection.hint).toContain('uses its own default');
      expect(detection.hint).toContain('session database');
      expect(JSON.stringify(detection)).not.toMatch(/jane|example\.com|MOCK_GATEWAY_KEY/);
      const calls = await harness.invocations();
      expect(calls.map((call) => call.argv)).toEqual([OPENCODE_VERSION_ARGS, OPENCODE_STATUS_ARGS]);
      // Outside a run the CLI must not read a project file from the directory it happens to be in.
      for (const call of calls) {
        expect(call.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1' });
      }
    });

    test('no connected provider is "unknown" and names the login command', async () => {
      await harness.cleanup();
      await setup({ MOCK_CLI_SCENARIO: 'logged-out' });

      const detection = await adapter.detect(instance);

      expect(detection.loggedIn).toBe('unknown');
      expect(detection.hint).toContain('`opencode auth login`');
      expect(detection.hint?.length).toBeLessThanOrEqual(500);
    });

    test('names the API key variables it does not pass on, never their values', async () => {
      await harness.cleanup();
      await setup({ OPENAI_API_KEY: 'sk-test-value', GOOGLE_API_KEY: 'g-test-value' });

      const detection = await adapter.detect(instance);

      expect(detection.billing).toBe('unknown');
      expect(detection.hint).toContain('Not passed to the CLI: GOOGLE_API_KEY, OPENAI_API_KEY.');
      expect(detection.hint).not.toContain('test-value');
    });

    test('reports a missing CLI', async () => {
      await harness.cleanup();
      await setup({ PATH: '' });

      expect(await adapter.detect(instance)).toMatchObject({
        installed: false,
        loggedIn: 'unknown',
      });
    });

    test('lists the models of the CLI as provider/model references', async () => {
      expect(await adapter.listModels?.(instance)).toEqual([
        { id: 'mock/mock-large' },
        { id: 'mock/mock-fast' },
      ]);
      expect((await harness.invocations())[0]?.env).toMatchObject({
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      });
    });
  });
});
