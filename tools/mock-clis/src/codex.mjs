#!/usr/bin/env node
// Mock of the `codex` CLI: `--version`, `login status`, `debug models` and
// `exec --json`.
import {
  UsageError,
  logInvocation,
  main,
  parseFlags,
  play,
  readStdin,
  requireFlag,
  scenarioFor,
} from './lib/runtime.mjs';

const KIND = 'codex';

const EXEC_FLAGS = {
  '--json': 'boolean',
  '--color': 'value',
  '--skip-git-repo-check': 'boolean',
  '--ephemeral': 'boolean',
  '--ignore-user-config': 'boolean',
  '--ignore-rules': 'boolean',
  '--sandbox': 'value',
  '--cd': 'value',
  '--model': 'value',
  '--config': 'list',
  '--disable': 'list',
  '--enable': 'list',
};
const EXEC_ALIASES = { '-s': '--sandbox', '-C': '--cd', '-m': '--model', '-c': '--config' };

const KNOWN_FEATURES = [
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
];

/** A complete successful turn; every piece is one whole agent message. */
function generate(pieces) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: pieces.join('') },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: pieces.length,
        reasoning_output_tokens: 0,
      },
    }),
  ];
}

const cli = {
  kind: KIND,
  generate,
  failures: {
    'logged-out': { exitCode: 1 },
    quota: { exitCode: 1 },
    'rate-limited': { exitCode: 1 },
    'model-not-found': { exitCode: 1 },
  },
};

function loginStatus() {
  // The real CLI prints this sentence on stderr and nothing on stdout.
  if (scenarioFor(undefined) === 'logged-out') {
    process.stderr.write('Not logged in\n');
    return 1;
  }
  // The mock's saved login is a ChatGPT login. The real CLI reports it the
  // same way when OPENAI_API_KEY or CODEX_API_KEY is set (checked on 0.167.0).
  process.stderr.write('Logged in using ChatGPT\n');
  return 0;
}

function models() {
  const level = (effort) => ({ effort, description: `Synthetic ${effort} level` });
  const catalogue = {
    models: [
      {
        slug: 'mock-codex-large',
        display_name: 'Mock Codex Large',
        visibility: 'list',
        supported_reasoning_levels: [level('low'), level('medium'), level('high')],
        base_instructions: 'synthetic',
      },
      {
        slug: 'mock-codex-small',
        display_name: 'Mock Codex Small',
        visibility: 'list',
        supported_reasoning_levels: [level('low')],
      },
      { slug: 'mock-codex-internal', display_name: 'Internal', visibility: 'hide' },
    ],
  };
  process.stdout.write(`${JSON.stringify(catalogue)}\n`);
  return 0;
}

async function exec(argv) {
  const { flags, positionals } = parseFlags(argv, EXEC_FLAGS, EXEC_ALIASES);
  if (positionals.length !== 1 || positionals[0] !== '-') {
    throw new UsageError('the prompt must arrive on stdin: the only positional argument is "-"');
  }
  requireFlag(flags, '--json');
  requireFlag(flags, '--color', 'never');
  requireFlag(flags, '--skip-git-repo-check');
  requireFlag(flags, '--ephemeral');
  requireFlag(flags, '--ignore-user-config');
  requireFlag(flags, '--ignore-rules');
  requireFlag(flags, '--sandbox', 'read-only');
  requireFlag(flags, '--cd');
  if (flags['--enable']) throw new UsageError('no feature may be enabled');
  const disabled = flags['--disable'] ?? [];
  for (const feature of disabled) {
    if (!KNOWN_FEATURES.includes(feature) || feature === process.env.MOCK_CLI_REMOVED_FEATURE) {
      // The real CLI's wording and exit code for a feature name it does not know.
      process.stderr.write(`Error: Unknown feature flag: ${feature}\n`);
      return 1;
    }
  }
  for (const feature of KNOWN_FEATURES) {
    if (!disabled.includes(feature)) throw new UsageError(`feature not disabled: ${feature}`);
  }
  for (const override of flags['--config'] ?? []) {
    if (!/^model_reasoning_effort="[A-Za-z0-9_-]+"$/.test(override)) {
      throw new UsageError(`unexpected configuration override: ${override}`);
    }
  }

  const scenario = scenarioFor(flags['--model']);
  if (scenario === 'hang') {
    logInvocation(KIND, { scenario });
    return play(cli, scenario, {});
  }
  const prompt = await readStdin();
  logInvocation(KIND, { scenario, prompt });
  return play(cli, scenario, { prompt });
}

main(KIND, async (argv) => {
  if (argv.length === 1 && argv[0] === '--version') {
    logInvocation(KIND);
    process.stdout.write('codex-cli 0.167.0\n');
    return 0;
  }
  if (argv.length === 2 && argv[0] === 'login' && argv[1] === 'status') {
    logInvocation(KIND);
    return loginStatus();
  }
  if (argv.length === 2 && argv[0] === 'debug' && argv[1] === 'models') {
    logInvocation(KIND);
    return models();
  }
  if (argv[0] === 'exec') return exec(argv.slice(1));
  throw new UsageError(`unexpected command: ${argv.join(' ')}`);
});
