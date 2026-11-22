import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KINDS = ['claude', 'codex', 'agy', 'grok'] as const;
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

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'mock-cli-test-'));
  await writeFile(path.join(workDir, 'prompt.txt'), 'ping');
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
  }
}

const REQUIRED_ENV: Record<Kind, Record<string, string>> = {
  claude: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  codex: {},
  agy: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  grok: { GROK_MEMORY: '0' },
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
    const withModel =
      kind === 'codex'
        ? [...args.slice(0, -1), modelFlag, 'mock-exit-nonzero', '-']
        : [...args, modelFlag, 'mock-exit-nonzero'];

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
  test.each(['claude', 'codex', 'agy'] as const)(
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
