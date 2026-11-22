#!/usr/bin/env node
// Mock of the `codex` CLI: `--version`, `login status`, `debug models` and
// `exec --json`.
import {
  UsageError,
  loadFixture,
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

/**
 * The `-c` overrides every run must carry, exactly once each: what keeps the
 * user's setup and the CLI's agent scaffolding away from the model. Each was
 * checked against codex-cli 0.167.0 with `codex debug prompt-input`.
 */
const REQUIRED_OVERRIDES = [
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
/** Web search is always stated: off, or the hosted search and nothing else. */
const SEARCH_OVERRIDES = ['web_search="disabled"', 'web_search="live"'];
const EFFORT_OVERRIDE = /^model_reasoning_effort="[A-Za-z0-9_-]+"$/;

/** Refuses any override other than the confirmed set; returns whether the web search is on. */
function checkOverrides(overrides) {
  const count = (wanted) => overrides.filter((override) => wanted.includes(override)).length;
  for (const required of REQUIRED_OVERRIDES) {
    if (count([required]) !== 1) {
      throw new UsageError(`configuration override expected exactly once: ${required}`);
    }
  }
  if (count(SEARCH_OVERRIDES) !== 1) {
    throw new UsageError(`exactly one of these is expected: ${SEARCH_OVERRIDES.join(', ')}`);
  }
  const efforts = overrides.filter((override) => EFFORT_OVERRIDE.test(override));
  if (efforts.length > 1) throw new UsageError('the reasoning effort may be given once');
  for (const override of overrides) {
    const known =
      REQUIRED_OVERRIDES.includes(override) ||
      SEARCH_OVERRIDES.includes(override) ||
      EFFORT_OVERRIDE.test(override);
    if (!known) throw new UsageError(`unexpected configuration override: ${override}`);
  }
  return overrides.includes('web_search="live"');
}

/**
 * A complete successful turn, with the lines and usage fields of a real run;
 * every piece is one whole agent message.
 */
function generate(pieces) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: '00000000-0000-0000-0000-000000000000' }),
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
        cache_write_input_tokens: 0,
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
  // The real CLI prints this sentence on stderr and nothing on stdout, and exits 1.
  if (scenarioFor(undefined) === 'logged-out') {
    process.stderr.write('Not logged in\n');
    return 1;
  }
  // The mock's saved login is a ChatGPT login. The real CLI reports it the
  // same way when OPENAI_API_KEY or CODEX_API_KEY is set (checked on 0.167.0),
  // although a run then authenticates with CODEX_API_KEY.
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
  const webSearch = checkOverrides(flags['--config'] ?? []);

  const scenario = scenarioFor(flags['--model']);
  if (scenario === 'hang') {
    logInvocation(KIND, { scenario });
    return play(cli, scenario, {});
  }
  const prompt = await readStdin();
  logInvocation(KIND, { scenario, prompt });
  // With the search switched on, the plain answer is the recorded run that used it.
  if (webSearch && scenario === 'ok') {
    const lines = loadFixture(KIND, 'web-search').map((line) => `${line}\n`);
    await new Promise((resolve) => process.stdout.write(lines.join(''), resolve));
    return 0;
  }
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
