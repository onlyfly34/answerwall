import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KINDS = ['claude', 'codex', 'agy', 'grok', 'opencode'] as const;
type Kind = (typeof KINDS)[number];

const CODEX_FEATURES = [
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
].flatMap((feature) => ['--disable', feature]);

const CODEX_OVERRIDES = [
  'web_search="disabled"',
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
].flatMap((override) => ['-c', override]);

/** The project file the opencode adapter writes into the work dir: one agent without any permission. */
function opencodeProject() {
  const deny = (action: string) => ({ action, resource: '*', effect: 'deny' });
  return {
    agents: {
      answerwall: { mode: 'primary', system: 'Answer the question.', permissions: [deny('*')] },
    },
    policies: ['tool.use', 'mcp.use', 'skill.use', 'websearch.use'].map(deny),
    snapshots: false,
  };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'mock-cli-test-'));
  await writeFile(path.join(workDir, 'prompt.txt'), 'ping');
  await writeFile(path.join(workDir, 'opencode.json'), JSON.stringify(opencodeProject()));
});
afterEach(() => rm(workDir, { recursive: true, force: true }));

/** The invocation each adapter is expected to make. */
function validArgs(kind: Kind): string[] {
  switch (kind) {
    case 'claude':
      return [
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
        'Answer the question.',
      ];
    case 'codex':
      return [
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
        ...CODEX_OVERRIDES,
        ...CODEX_FEATURES,
        '-',
      ];
    case 'agy':
      return [
        '-p',
        '',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--print-timeout',
        '300s',
        '--disable-slash-commands',
      ];
    case 'grok':
      return [
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
      ];
    case 'opencode':
      return [
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
      ];
  }
}

const REQUIRED_ENV: Record<Kind, Record<string, string>> = {
  claude: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  codex: {},
  agy: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  grok: { GROK_MEMORY: '0' },
  opencode: { OPENCODE_DISABLE_CLAUDE_CODE: '1' },
};

const stdinFor = (kind: Kind, prompt: string): string =>
  kind === 'agy' ? `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n` : prompt;

function start(
  kind: Kind,
  args: string[],
  env: Record<string, string> = {},
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [path.join(ROOT, 'src', `${kind}.mjs`), ...args], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      ...REQUIRED_ENV[kind],
      ...env,
    },
  });
}

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function finished(child: ChildProcessWithoutNullStreams): Promise<Finished> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runMock(
  kind: Kind,
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
) {
  const child = start(kind, args, options.env);
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.stdin ?? stdinFor(kind, 'ping'));
  return finished(child);
}

const jsonLines = (output: string): Record<string, unknown>[] =>
  output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe.each(KINDS)('the mock %s CLI', (kind) => {
  test('answers the expected invocation with JSON lines and exit code 0', async () => {
    const result = await runMock(kind, validArgs(kind));

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(jsonLines(result.stdout).length).toBeGreaterThan(1);
  });

  test('fails loudly on a flag the adapter is not expected to pass', async () => {
    const args = validArgs(kind);
    const result = await runMock(kind, [
      ...args.slice(0, -1),
      '--surprise-flag',
      ...args.slice(-1),
    ]);

    expect(result.code).toBe(64);
    expect(result.stderr).toContain(`mock ${kind}:`);
    expect(result.stdout).toBe('');
  });

  test('fails loudly when a required flag is missing', async () => {
    const dropped = {
      claude: '--safe-mode',
      codex: '--ephemeral',
      agy: '--disable-slash-commands',
      grok: '--no-plan',
      opencode: '--standalone',
    }[kind];
    const result = await runMock(
      kind,
      validArgs(kind).filter((arg) => arg !== dropped),
    );

    expect(result.code).toBe(64);
    expect(result.stderr).toContain(dropped);
  });

  test('fails loudly when the environment the adapter must set is missing', async () => {
    const name = Object.keys(REQUIRED_ENV[kind])[0];
    if (name === undefined) return;

    const result = await runMock(kind, validArgs(kind), { env: { [name]: '' } });

    expect(result.code).toBe(64);
    expect(result.stderr).toContain(name);
  });

  test("fails loudly when one of the application's own variables reaches it", async () => {
    for (const name of ['ANSWERWALL_TOKEN', 'answerwall_secret_tls_server_key']) {
      for (const args of [validArgs(kind), [kind === 'grok' ? 'version' : '--version']]) {
        const result = await runMock(kind, args, { env: { [name]: 'x' } });

        expect(result.code).toBe(64);
        expect(result.stderr).toContain(name);
        expect(result.stdout).toBe('');
      }
    }
  });

  test('selects the scenario from the model name or the environment', async () => {
    const modelFlag = kind === 'codex' || kind === 'grok' ? '-m' : '--model';
    const args = validArgs(kind);
    // opencode names a model as provider/model.
    const model = kind === 'opencode' ? 'mock/mock-exit-nonzero' : 'mock-exit-nonzero';
    const withModel =
      kind === 'codex'
        ? [...args.slice(0, -1), modelFlag, model, '-']
        : [...args, modelFlag, model];

    expect((await runMock(kind, withModel)).code).toBe(3);
    expect((await runMock(kind, args, { env: { MOCK_CLI_SCENARIO: 'exit-nonzero' } })).code).toBe(
      3,
    );
    expect(
      (await runMock(kind, args, { env: { MOCK_CLI_SCENARIO: 'no-such-scenario' } })).code,
    ).toBe(64);
  });

  test('records its invocation when asked to', async () => {
    const log = path.join(workDir, 'log.jsonl');

    await runMock(kind, validArgs(kind), { env: { MOCK_CLI_LOG: log } });

    const [entry] = jsonLines(await readFile(log, 'utf8'));
    expect(entry).toMatchObject({ kind, argv: validArgs(kind), prompt: 'ping', scenario: 'ok' });
  });

  test('prints garbage, noise or nothing but a non-zero exit on request', async () => {
    const garbage = await runMock(kind, validArgs(kind), { env: { MOCK_CLI_SCENARIO: 'garbage' } });
    expect(garbage.code).toBe(0);
    expect(() => jsonLines(garbage.stdout)).toThrow();

    const noisy = await runMock(kind, validArgs(kind), {
      env: { MOCK_CLI_SCENARIO: 'stderr-noise' },
    });
    expect(noisy.code).toBe(0);
    expect(noisy.stderr.length).toBeGreaterThan(64 * 1024);
    expect(jsonLines(noisy.stdout).length).toBeGreaterThan(1);
  });

  test('its fixtures are labelled as recorded or synthetic and hold one JSON object per line', async () => {
    const dir = path.join(ROOT, 'fixtures', kind);
    const files = await readdir(dir);

    for (const scenario of ['ok', 'quota']) {
      expect(files.some((file) => file.replace(/(\.synthetic)?\.jsonl$/, '') === scenario)).toBe(
        true,
      );
    }
    for (const file of files) {
      expect(file).toMatch(/\.jsonl$/);
      const [header, ...lines] = (await readFile(path.join(dir, file), 'utf8'))
        .trimEnd()
        .split('\n');
      // A recording says which CLI version printed it; anything else says it is synthetic.
      expect(header).toMatch(
        file.endsWith('.synthetic.jsonl')
          ? /^# synthetic\b/
          : new RegExp(`^# recorded from ${kind}(-cli)? \\d+\\.\\d+\\.\\d+, scrubbed`),
      );
      for (const line of lines) expect(typeof JSON.parse(line)).toBe('object');
    }
  });
});

describe('stdin handling', () => {
  test.each(['claude', 'codex', 'agy', 'opencode'] as const)(
    'the mock %s CLI waits until stdin is closed before it answers',
    async (kind) => {
      const child = start(kind, validArgs(kind));
      const done = finished(child);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stdin.write(stdinFor(kind, 'ping'));

      // Long enough for the mock to have answered if it were not waiting for the end of stdin.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(output).toBe('');
      expect(child.exitCode).toBeNull();

      child.stdin.end();
      expect((await done).code).toBe(0);
    },
  );

  test('the mock grok CLI never reads stdin: it answers while stdin stays open', async () => {
    const child = start('grok', validArgs('grok'));

    const result = await finished(child);

    expect(result.code).toBe(0);
    expect(jsonLines(result.stdout).at(-1)).toMatchObject({ type: 'end' });
  });

  test('the hang scenario ignores stdin and stays alive until it is killed', async () => {
    const child = start('codex', validArgs('codex'), { MOCK_CLI_SCENARIO: 'hang' });
    const done = finished(child);
    child.stdin.end('ping');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(child.exitCode).toBeNull();

    child.kill('SIGKILL');
    expect((await done).stdout).toBe('');
  });

  test('the init-hang scenario prints the first event and then nothing', async () => {
    const child = start('claude', validArgs('claude'), { MOCK_CLI_SCENARIO: 'init-hang' });
    const done = finished(child);
    child.stdin.end('ping');
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(child.exitCode).toBeNull();

    child.kill('SIGKILL');
    expect(jsonLines((await done).stdout)).toEqual([
      expect.objectContaining({ type: 'system', subtype: 'init' }),
    ]);
  });
});

describe('descendants', () => {
  // Reads the command line from /proc, which only Linux has.
  test.skipIf(process.platform !== 'linux')(
    'the child left behind names the mock script, so the search for leftover mocks finds it',
    async () => {
      const log = path.join(workDir, 'invocations.jsonl');
      const child = start('claude', validArgs('claude'), {
        MOCK_CLI_SCENARIO: 'tree',
        MOCK_CLI_LOG: log,
      });
      child.stdin.end('ping');
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      let grandchild: number | undefined;
      for (let attempt = 0; attempt < 100 && grandchild === undefined; attempt++) {
        const text = await readFile(log, 'utf8').catch(() => '');
        grandchild = jsonLines(text).find((entry) => typeof entry.grandchildPid === 'number')
          ?.grandchildPid as number | undefined;
        if (grandchild === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      try {
        expect(grandchild).toBeTypeOf('number');
        const commandLine = (await readFile(`/proc/${grandchild}/cmdline`, 'utf8')).split('\0');
        expect(commandLine.join(' ')).toMatch(/src\/claude\.mjs stubborn-child/);
      } finally {
        if (grandchild !== undefined) process.kill(grandchild, 'SIGKILL');
        child.kill('SIGKILL');
      }
    },
  );
});

describe.skipIf(process.platform === 'win32')('a child in a session of its own', () => {
  const started = async (scenario: string) => {
    const log = path.join(workDir, 'invocations.jsonl');
    const child = start('opencode', validArgs('opencode'), {
      MOCK_CLI_SCENARIO: scenario,
      MOCK_CLI_LOG: log,
    });
    child.stdin.end('ping');
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    const detached = jsonLines(await readFile(log, 'utf8')).find(
      (entry) => typeof entry.detachedPid === 'number',
    )?.detachedPid as number | undefined;
    if (detached === undefined) throw new Error('the pid of the child was not recorded');
    return { child, detached };
  };
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 100 && alive(pid); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return !alive(pid);
  };

  test('own-session-child: it ends with the pipe from the CLI when the CLI is killed', async () => {
    const { child, detached } = await started('own-session-child');
    const done = finished(child);

    child.kill('SIGKILL');
    await done;

    expect(await gone(detached)).toBe(true);
  });

  test('own-session-orphan: it stays after the CLI is gone', async () => {
    const { child, detached } = await started('own-session-orphan');
    const done = finished(child);

    try {
      child.kill('SIGKILL');
      await done;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(detached)).toBe(true);
    } finally {
      process.kill(detached, 'SIGKILL');
    }
  });
});

describe('status subcommands', () => {
  test('claude auth status reports the login as JSON and by exit code', async () => {
    const loggedIn = await runMock('claude', ['auth', 'status', '--json']);
    const loggedOut = await runMock('claude', ['auth', 'status', '--json'], {
      env: { MOCK_CLI_SCENARIO: 'logged-out' },
    });

    expect(loggedIn.code).toBe(0);
    expect(JSON.parse(loggedIn.stdout)).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
    expect(loggedOut.code).toBe(1);
    expect(JSON.parse(loggedOut.stdout)).toMatchObject({ loggedIn: false });
  });

  test('codex login status prints on stderr only', async () => {
    const loggedIn = await runMock('codex', ['login', 'status']);
    const loggedOut = await runMock('codex', ['login', 'status'], {
      env: { MOCK_CLI_SCENARIO: 'logged-out' },
    });

    expect(loggedIn).toEqual({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' });
    expect(loggedOut).toEqual({ code: 1, stdout: '', stderr: 'Not logged in\n' });
  });

  test.each([
    ['claude', ['--version'], /^\d+\.\d+\.\d+ /],
    ['codex', ['--version'], /^codex-cli \d+\.\d+\.\d+/],
    ['agy', ['--version'], /\d+\.\d+\.\d+/],
    ['grok', ['version'], /\d+\.\d+\.\d+/],
    ['opencode', ['--version'], /^opencode v\d+\.\d+\.\d+/],
  ] as const)('%s prints its version', async (kind, args, pattern) => {
    const result = await runMock(kind, [...args]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(pattern);
  });

  test.each(['agy', 'grok'] as const)('%s models lists model ids', async (kind) => {
    expect((await runMock(kind, ['models'])).stdout).toContain(
      `mock-${kind === 'agy' ? 'gemini' : 'grok'}-`,
    );
  });

  test('codex debug models prints the catalogue as JSON', async () => {
    const { models } = JSON.parse((await runMock('codex', ['debug', 'models'])).stdout) as {
      models: { slug: string; visibility: string }[];
    };

    expect(models.map((model) => model.visibility)).toEqual(['list', 'list', 'hide']);
  });

  test('codex refuses an unknown feature name the way the real CLI does', async () => {
    const args = validArgs('codex');
    const result = await runMock('codex', [
      ...args.slice(0, -1),
      '--disable',
      'no_such_feature',
      '-',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('Error: Unknown feature flag: no_such_feature\n');
  });

  test('claude offers the web search only in the confirmed form', async () => {
    const args = validArgs('claude');
    const tools = args.indexOf('--tools');
    const withSearch = [
      ...args.slice(0, tools),
      '--tools',
      'WebSearch',
      '--allowedTools',
      'WebSearch',
      ...args.slice(tools + 2),
    ];
    const noAllowRule = withSearch.filter(
      (arg, index) => index !== tools + 2 && index !== tools + 3,
    );
    const withFetch = withSearch.map((arg) => (arg === 'WebSearch' ? 'WebSearch,WebFetch' : arg));

    const searched = await runMock('claude', withSearch);
    expect(searched.code).toBe(0);
    expect(jsonLines(searched.stdout)[0]).toMatchObject({ subtype: 'init', tools: ['WebSearch'] });
    expect(jsonLines((await runMock('claude', args)).stdout)[0]).toMatchObject({ tools: [] });
    for (const refused of [noAllowRule, withFetch]) {
      const result = await runMock('claude', refused);
      expect(result.code).toBe(64);
      expect(result.stderr).toContain('--tools');
    }
  });

  test('claude fails on an unknown model the way the real CLI does', async () => {
    const result = await runMock('claude', [
      ...validArgs('claude'),
      '--model',
      'mock-model-not-found',
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      '[claude-code:unrecognized_model] {"model":"mock-model-not-found","query_source":"sdk"}\n',
    );
    expect(jsonLines(result.stdout).at(-1)).toMatchObject({ type: 'result', is_error: true });
  });

  test('codex accepts the confirmed overrides and nothing else', async () => {
    const args = validArgs('codex');
    const withSearch = args.map((arg) =>
      arg === 'web_search="disabled"' ? 'web_search="live"' : arg,
    );
    const without = (override: string) => {
      const at = args.indexOf(override);
      return [...args.slice(0, at - 1), ...args.slice(at + 1)];
    };

    const searched = await runMock('codex', withSearch);
    expect(searched.code).toBe(0);
    expect(jsonLines(searched.stdout).map((line) => line.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'item.completed',
      'turn.completed',
    ]);
    expect(jsonLines(searched.stdout)[3]).toMatchObject({ item: { type: 'web_search' } });
    expect(JSON.stringify(jsonLines((await runMock('codex', args)).stdout))).not.toContain(
      'web_search',
    );
    for (const dropped of ['web_search="disabled"', 'agents.max_depth=0']) {
      const result = await runMock('codex', without(dropped));
      expect(result.code).toBe(64);
      expect(result.stderr).toContain(dropped.split('=')[0]);
    }
    const extra = [...args.slice(0, -1), '-c', 'sandbox_mode="danger-full-access"', '-'];
    expect((await runMock('codex', extra)).stderr).toContain('unexpected configuration override');
  });

  test('codex reports its ChatGPT login whether or not a key variable is set', async () => {
    for (const env of [{}, { OPENAI_API_KEY: 'k' }, { CODEX_API_KEY: 'k' }]) {
      const result = await runMock('codex', ['login', 'status'], { env });

      expect(result).toEqual({ code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' });
    }
  });

  test('an unknown subcommand is a usage error', async () => {
    expect((await runMock('codex', ['login'])).code).toBe(64);
    expect((await runMock('grok', ['login', '--device-auth'])).code).toBe(64);
  });
});

describe('the mock opencode CLI and its project file', () => {
  const args = validArgs('opencode');
  const writeProject = (config: unknown) =>
    writeFile(path.join(workDir, 'opencode.json'), JSON.stringify(config));
  const lastEvent = (result: Finished) => jsonLines(result.stdout).at(-1);

  test('answers with whole parts and the usage of the step, as the real CLI does', async () => {
    const result = await runMock('opencode', args);

    expect(jsonLines(result.stdout).map((line) => line.type)).toEqual([
      'step_start',
      'text',
      'step_finish',
    ]);
    expect(lastEvent(result)).toMatchObject({ part: { reason: 'stop', tokens: { input: 18 } } });
  });

  test('without the project file the agent does not exist: one error line, exit code 1', async () => {
    await rm(path.join(workDir, 'opencode.json'));

    const result = await runMock('opencode', args);

    expect(result.code).toBe(1);
    expect(lastEvent(result)).toMatchObject({
      type: 'error',
      error: { message: 'Agent not found: "answerwall"' },
    });
  });

  test('with project configuration switched off the file is not read', async () => {
    const result = await runMock('opencode', args, {
      env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
    });

    expect(result.code).toBe(1);
    expect(lastEvent(result)).toMatchObject({
      error: { message: 'Agent not found: "answerwall"' },
    });
  });

  test('refuses an agent that allows something, a missing policy and provider settings', async () => {
    const project = opencodeProject();
    const allow = { action: 'read', resource: '*', effect: 'allow' };
    const variants = [
      {
        ...project,
        agents: {
          answerwall: {
            ...project.agents.answerwall,
            permissions: [...project.agents.answerwall.permissions, allow],
          },
        },
      },
      { ...project, policies: project.policies.slice(1) },
      { ...project, providers: { acme: {} } },
    ];

    for (const variant of variants) {
      await writeProject(variant);
      expect((await runMock('opencode', args)).code).toBe(64);
    }
  });

  test('a model is provider/model, with the scenario in the model part and an optional variant', async () => {
    const log = path.join(workDir, 'log.jsonl');

    const echoed = await runMock('opencode', [...args, '--model', 'mock/mock-echo#high'], {
      env: { MOCK_CLI_LOG: log },
    });
    const bare = await runMock('opencode', [...args, '--model', 'mock-echo']);

    expect(JSON.stringify(jsonLines(echoed.stdout))).toContain('You said: ping');
    expect(jsonLines(await readFile(log, 'utf8'))[0]).toMatchObject({
      scenario: 'echo',
      variant: 'high',
    });
    expect(bare.code).toBe(1);
    expect(lastEvent(bare)).toMatchObject({
      error: { message: 'Invalid model reference: mock-echo' },
    });
  });

  test('a message as an argument is a usage error: the prompt arrives on stdin', async () => {
    expect((await runMock('opencode', [...args, 'What is 2 + 2?'])).code).toBe(64);
  });

  test('the status and listing commands insist on a private server and no project configuration', async () => {
    const off = { env: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' } };
    const list = ['auth', 'list', '--standalone', '--format', 'json'];

    const listed = await runMock('opencode', list, off);
    const none = await runMock('opencode', list, {
      env: { ...off.env, MOCK_CLI_SCENARIO: 'logged-out' },
    });
    const models = await runMock('opencode', ['models', '--standalone'], off);

    expect(JSON.parse(listed.stdout)).toMatchObject([{ connections: [{ type: 'env' }] }]);
    expect(JSON.parse(none.stdout)).toEqual([]);
    expect(models.stdout).toBe('mock/mock-large\nmock/mock-fast\n');
    for (const refused of [
      await runMock('opencode', list),
      await runMock('opencode', ['models', '--standalone']),
      await runMock('opencode', ['models'], off),
      await runMock('opencode', ['auth', 'list', '--standalone'], off),
    ]) {
      expect(refused.code).toBe(64);
    }
  });

  test('as version 1 it knows none of the arguments and prints its usage text', async () => {
    const legacy = { env: { MOCK_OPENCODE_LEGACY: '1' } };

    expect((await runMock('opencode', ['--version'], legacy)).stdout).toBe('1.19.6\n');
    expect(await runMock('opencode', args, legacy)).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('opencode run [message..]') as unknown,
    });
  });
});
