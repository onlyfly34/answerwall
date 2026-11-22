#!/usr/bin/env node
// Mock of the `opencode` CLI (version 2): `--version`, `auth list`, `models`
// and `run --standalone --format json`.
import { readFileSync } from 'node:fs';
import {
  UsageError,
  loadFixture,
  log,
  logInvocation,
  main,
  parseFlags,
  play,
  readStdin,
  requireFlag,
  scenarioFor,
  sleep,
  writeLines,
} from './lib/runtime.mjs';

const KIND = 'opencode';

const RUN_FLAGS = {
  '--standalone': 'boolean',
  '--format': 'value',
  '--thinking': 'boolean',
  '--archived': 'boolean',
  '--title': 'value',
  '--agent': 'value',
  '--model': 'value',
};
const STATUS_FLAGS = { '--standalone': 'boolean', '--format': 'value' };

/** The agent of the adapter's project file, and what that file must say about it. */
const AGENT = 'answerwall';
const PROJECT_FILE = 'opencode.json';
const REQUIRED_POLICIES = ['tool.use', 'mcp.use', 'skill.use', 'websearch.use'];

const ID = '0'.repeat(22);
const base = (extra) => ({ timestamp: 1700000000000, sessionID: `ses_${ID}`, ...extra });
const part = (n, type, extra = {}) => ({
  id: `prt_${ID}${String(n).padStart(4, '0')}`,
  sessionID: `ses_${ID}`,
  messageID: `msg_${ID}0001`,
  type,
  ...extra,
});

/** A complete successful answer; the real CLI prints the text as one part, whatever its length. */
function generate(pieces) {
  return [
    base({ type: 'step_start', part: part(1, 'step-start') }),
    base({
      type: 'text',
      part: part(2, 'text', {
        text: pieces.join(''),
        time: { start: 1700000000000, end: 1700000000000 },
      }),
    }),
    base({
      type: 'step_finish',
      part: part(3, 'step-finish', {
        reason: 'stop',
        cost: 0,
        tokens: { input: 10, output: pieces.length, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    }),
  ].map((event) => JSON.stringify(event));
}

/** One error line on stdout and exit code 1: how the real CLI reports a failure before a run. */
function fail(message) {
  process.stdout.write(
    `${JSON.stringify({ type: 'error', timestamp: 1700000000000, sessionID: '', error: { type: 'unknown', message } })}\n`,
  );
  return 1;
}

/**
 * The real CLI reads `opencode.json` from its working directory. The agent a
 * question is answered with must be defined there with every permission
 * denied, next to the policies that remove MCP servers, skills and the web
 * search; anything else is a drifting adapter.
 */
function checkProjectFile() {
  let config;
  try {
    config = JSON.parse(readFileSync(PROJECT_FILE, 'utf8'));
  } catch {
    return false;
  }
  const agent = config?.agents?.[AGENT];
  if (agent === undefined) return false;
  const denied = (rules, action) =>
    Array.isArray(rules) &&
    rules.some((rule) => rule.action === action && rule.resource === '*' && rule.effect === 'deny');
  if (agent.mode !== 'primary' || typeof agent.system !== 'string' || agent.system === '') {
    throw new UsageError(`the ${AGENT} agent must be a primary agent with a system prompt`);
  }
  if (!denied(agent.permissions, '*') || agent.permissions.length !== 1) {
    throw new UsageError(`the ${AGENT} agent must deny every permission and allow nothing`);
  }
  for (const action of REQUIRED_POLICIES) {
    if (!denied(config.policies, action)) {
      throw new UsageError(`the project file must deny the policy action ${action}`);
    }
  }
  for (const key of ['providers', 'model', 'mcp', 'plugins']) {
    if (key in config) throw new UsageError(`the project file must not configure "${key}"`);
  }
  return true;
}

/**
 * How the real CLI (2.3.2) decides that project configuration is off: the
 * second name wins whenever it is set at all, whatever its value.
 */
const PROJECT_CONFIG_SWITCHES = [
  'OPENCODE_CONFIG_PROJECT_DISABLE',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
];
function projectConfigOff() {
  const [second, first] = PROJECT_CONFIG_SWITCHES.map((name) => process.env[name]);
  return ['1', 'true'].includes((second ?? first ?? '').toLowerCase());
}

/** `provider/model` with an optional `#variant`; the scenario is named by the model part. */
function parseModel(reference) {
  if (reference === undefined) return {};
  const match = /^([^/#\s]+)\/([^#\s]+)(?:#([\w-]+))?$/.exec(reference);
  return match ? { model: match[2], variant: match[3] } : { invalid: true };
}

/** Milliseconds between a `retry` line and the next attempt (default 1500). */
const RETRY_DELAY_ENV = 'MOCK_OPENCODE_RETRY_MS';

/**
 * A failure the real CLI answers by trying again: it prints a `retry` line,
 * waits, and sends the question once more, ten times before the `error`
 * line. The mock waits once, after the first `retry` line, and logs `resent`
 * when it gets that far, which a caller that stops the CLI in time never sees.
 */
async function playRetries(scenario) {
  const lines = loadFixture(KIND, scenario);
  const first = lines.findIndex((line) => JSON.parse(line).type === 'retry');
  await writeLines(lines.slice(0, first + 1));
  await sleep(Number(process.env[RETRY_DELAY_ENV] ?? 1500));
  log({ kind: KIND, resent: true });
  await writeLines(lines.slice(first + 1));
  return 1;
}

const cli = {
  kind: KIND,
  generate,
  failures: {
    'logged-out': { exitCode: 1 },
    quota: { exitCode: 1 },
    'model-not-found': { exitCode: 1 },
  },
};

main(KIND, async (argv) => {
  // Version 1 of the CLI is installed under the same name and knows none of this.
  const legacy = process.env.MOCK_OPENCODE_LEGACY === '1';
  if (argv.length === 1 && argv[0] === '--version') {
    logInvocation(KIND);
    process.stdout.write(legacy ? '1.19.6\n' : 'opencode v2.3.2\n');
    return 0;
  }
  if (legacy) {
    // It answers an argument it does not know with its usage text on stderr and exit code 1.
    logInvocation(KIND);
    process.stderr.write('opencode run [message..]\n\nrun opencode with a message\n');
    return 1;
  }

  // Status and listing commands run where a stranger could have left a project file.
  const probe = (commandWords, expectedFormat) => {
    const { flags, positionals } = parseFlags(argv.slice(commandWords), STATUS_FLAGS);
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
    requireFlag(flags, '--standalone');
    if (flags['--format'] !== expectedFormat) {
      throw new UsageError(`--format must be ${expectedFormat ?? 'absent'}`);
    }
    // Either name alone leaves the decision to whatever the user set under the other.
    for (const name of PROJECT_CONFIG_SWITCHES) {
      if (process.env[name] !== '1') throw new UsageError(`${name} must be "1" outside a run`);
    }
    logInvocation(KIND);
  };

  if (argv[0] === 'auth' && argv[1] === 'list') {
    probe(2, 'json');
    // The names are here so that tests can prove they are never kept.
    const integrations =
      scenarioFor(undefined) === 'logged-out'
        ? []
        : [
            {
              id: 'mock',
              name: 'Mock gateway of jane.doe@example.com',
              connections: [{ type: 'env', name: 'MOCK_GATEWAY_KEY' }],
            },
          ];
    process.stdout.write(`${JSON.stringify(integrations, null, 2)}\n`);
    return 0;
  }
  if (argv[0] === 'models') {
    probe(1, undefined);
    process.stdout.write('mock/mock-large\nmock/mock-fast\n');
    return 0;
  }

  if (argv[0] !== 'run') throw new UsageError(`unexpected command: ${argv[0] ?? '(none)'}`);
  const { flags, positionals } = parseFlags(argv.slice(1), RUN_FLAGS, { '-m': '--model' });
  // The message would be user input in argv; it arrives on stdin.
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  requireFlag(flags, '--standalone');
  requireFlag(flags, '--format', 'json');
  requireFlag(flags, '--thinking');
  requireFlag(flags, '--archived');
  requireFlag(flags, '--title');
  requireFlag(flags, '--agent', AGENT);
  if (process.env.OPENCODE_DISABLE_CLAUDE_CODE !== '1') {
    throw new UsageError('OPENCODE_DISABLE_CLAUDE_CODE must be "1"');
  }

  const reference = parseModel(flags['--model']);
  if (reference.invalid) {
    logInvocation(KIND);
    return fail(`Invalid model reference: ${flags['--model']}`);
  }
  // With project configuration switched off the real CLI never sees the agent.
  if (projectConfigOff() || !checkProjectFile()) {
    logInvocation(KIND);
    return fail(`Agent not found: "${AGENT}"`);
  }
  const scenario = scenarioFor(reference.model);
  if (scenario === 'hang') {
    // Never reads stdin: a writer must not depend on the CLI draining it.
    logInvocation(KIND, { scenario, variant: reference.variant ?? null });
    return play(cli, scenario, { prompt: '' });
  }
  const prompt = await readStdin();
  logInvocation(KIND, { scenario, prompt, variant: reference.variant ?? null });
  if (prompt.trim() === '') return fail('You must provide a message');
  if (scenario === 'rate-limited') return playRetries(scenario);
  // The real CLI has one output mode: whole parts.
  return play(cli, scenario === 'block' ? 'ok' : scenario, { prompt });
});
