// Shared machinery of the mock CLIs: strict argument parsing, scenario
// selection, fixture replay and the behaviours every mock can simulate.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Exit code for an invocation the real CLI would not accept. */
export const USAGE_EXIT_CODE = 64;

/** Selects the scenario; a model named `mock-<scenario>` takes precedence. */
export const SCENARIO_ENV = 'MOCK_CLI_SCENARIO';
/** Milliseconds between lines in the `slow` scenario (default 40). */
export const DELAY_ENV = 'MOCK_CLI_DELAY_MS';
/** A file to which every invocation appends one JSON line describing itself. */
export const LOG_ENV = 'MOCK_CLI_LOG';
/** Total answer size of the `huge` scenario in bytes (default 3 MiB). */
export const HUGE_BYTES_ENV = 'MOCK_CLI_HUGE_BYTES';

export const SCENARIOS = [
  'ok',
  'echo',
  'slow',
  'chunked',
  'block',
  'reasoning',
  'tool-denied',
  'incremental',
  'hang',
  'init-hang',
  'logged-out',
  'quota',
  'rate-limited',
  'model-not-found',
  'exit-nonzero',
  'garbage',
  'huge',
  'stderr-noise',
  'tree',
  'stubborn-tree',
  'lingering-child',
];

const MODEL_PREFIX = 'mock-';
const FIXTURE_ROOT = new URL('../../fixtures/', import.meta.url);

/**
 * The prefix of the application's own settings and secrets (its token, its
 * secret overlay). A CLI child never gets them; a mock started with one fails.
 */
const APP_ENV_PREFIX = 'ANSWERWALL_';

export class UsageError extends Error {}

/**
 * Parses argv against a table of the flags the real CLI documents. Anything
 * else is a usage error, so a drifting adapter fails loudly.
 *
 * `spec` maps each flag to `'boolean'`, `'value'` or `'list'` (repeatable);
 * `aliases` maps alternative spellings to the canonical flag.
 */
export function parseFlags(argv, spec, aliases = {}) {
  const flags = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (word === '-' || !word.startsWith('-')) {
      positionals.push(word);
      continue;
    }
    const name = aliases[word] ?? word;
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`unexpected argument: ${word}`);
    if (kind === 'boolean') {
      flags[name] = true;
      continue;
    }
    if (index + 1 >= argv.length) throw new UsageError(`missing value for ${word}`);
    const value = argv[++index];
    if (kind === 'list') (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positionals };
}

export function requireFlag(flags, name, expected) {
  if (flags[name] === undefined) throw new UsageError(`missing required argument: ${name}`);
  if (expected !== undefined && flags[name] !== expected) {
    throw new UsageError(
      `${name} must be ${JSON.stringify(expected)}, got ${JSON.stringify(flags[name])}`,
    );
  }
}

export function scenarioFor(model) {
  const fromModel = model?.startsWith(MODEL_PREFIX) ? model.slice(MODEL_PREFIX.length) : undefined;
  const name =
    fromModel && SCENARIOS.includes(fromModel) ? fromModel : process.env[SCENARIO_ENV] || 'ok';
  if (!SCENARIOS.includes(name)) throw new UsageError(`unknown mock scenario: ${name}`);
  return name;
}

export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/**
 * The lines of a fixture: the scrubbed recording `<name>.jsonl` when there is
 * one, otherwise the synthetic `<name>.synthetic.jsonl`.
 */
export function loadFixture(kind, name) {
  const recorded = new URL(`${kind}/${name}.jsonl`, FIXTURE_ROOT);
  const file = existsSync(recorded)
    ? recorded
    : new URL(`${kind}/${name}.synthetic.jsonl`, FIXTURE_ROOT);
  if (!existsSync(file)) {
    throw new UsageError(`the mock ${kind} CLI has no "${name}" fixture (${fileURLToPath(file)})`);
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps the process alive until it is killed. */
function hang() {
  setInterval(() => undefined, 1 << 30);
  return new Promise(() => undefined);
}

/** Resolves once the data has been handed to the operating system, so an exit cannot cut it off. */
function write(stream, text) {
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
}

const writeLines = (lines) => write(process.stdout, lines.map((line) => `${line}\n`).join(''));

function log(entry) {
  const file = process.env[LOG_ENV];
  // `at` tells a reader whether a process id it finds later is still this process.
  if (file) appendFileSync(file, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
}

/** Records what the mock was started with, for assertions on argv, stdin and environment. */
export function logInvocation(kind, extra = {}) {
  log({
    kind,
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
    env: Object.fromEntries(
      ['NO_COLOR', 'TERM', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'GROK_MEMORY'].map((name) => [
        name,
        process.env[name] ?? null,
      ]),
    ),
    ...extra,
  });
}

/**
 * A descendant that ignores SIGTERM and inherits stdout: only a tree kill
 * removes it. Its command line names the mock's script, unused, so that the
 * search for leftover mocks (`pgrep -f 'src/(claude|codex|grok|agy).mjs'`)
 * finds it too.
 */
function spawnStubbornChild() {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      process.argv[1] ?? '',
      'stubborn-child',
    ],
    { stdio: ['ignore', 'inherit', 'ignore'] },
  );
  log({ grandchildPid: child.pid });
  return child;
}

/**
 * Plays one scenario.
 *
 * `cli.generate(text)` returns the lines of a complete successful answer
 * split into the given text pieces; `cli.failures[scenario]` gives the exit
 * code and stderr of the failure scenarios whose stdout comes from a fixture.
 */
export async function play(cli, scenario, context) {
  const fixture = (name) => loadFixture(cli.kind, name);
  switch (scenario) {
    case 'ok':
    case 'block':
    case 'reasoning':
    case 'tool-denied':
    case 'incremental':
      await writeLines(fixture(scenario));
      return 0;
    case 'echo':
      await writeLines(cli.generate(['You said: ', context.prompt]));
      return 0;
    case 'slow': {
      const delay = Number(process.env[DELAY_ENV] ?? 40);
      for (const line of fixture('ok')) {
        await writeLines([line]);
        await sleep(delay);
      }
      return 0;
    }
    case 'chunked': {
      // Windows line endings, written a few bytes at a time across line boundaries.
      const bytes = Buffer.from(fixture('ok').join('\r\n') + '\r\n', 'utf8');
      for (let offset = 0; offset < bytes.length; offset += 7) {
        await write(process.stdout, bytes.subarray(offset, offset + 7));
      }
      return 0;
    }
    case 'hang':
      return hang();
    case 'init-hang':
      await writeLines(fixture('ok').slice(0, 1));
      return hang();
    case 'logged-out':
    case 'quota':
    case 'rate-limited':
    case 'model-not-found': {
      const failure = cli.failures[scenario];
      if (failure.stdout !== false) await writeLines(fixture(scenario));
      if (failure.stderr) await write(process.stderr, `${failure.stderr}\n`);
      return failure.exitCode;
    }
    case 'exit-nonzero':
      await write(
        process.stderr,
        `mock ${cli.kind}: internal failure in /home/mock/.config/secret-dir\n`,
      );
      return 3;
    case 'garbage':
      await write(
        process.stdout,
        'This is not the documented output format.\nSecond line of plain text.\n',
      );
      return 0;
    case 'huge': {
      const total = Number(process.env[HUGE_BYTES_ENV] ?? 3 * 1024 * 1024);
      const piece = 'lorem ipsum dolor sit amet '.repeat(40);
      const pieces = Array.from({ length: Math.ceil(total / piece.length) }, () => piece);
      for (const line of cli.generate(pieces)) await writeLines([line]);
      return 0;
    }
    case 'stderr-noise': {
      const noise = `${'warning: this is diagnostic noise on stderr. '.repeat(20)}\n`;
      for (const line of fixture('ok')) {
        for (let index = 0; index < 40; index++) await write(process.stderr, noise);
        await writeLines([line]);
      }
      return 0;
    }
    case 'stubborn-tree':
      // The CLI itself ignores SIGTERM too: only SIGKILL ends this tree.
      process.on('SIGTERM', () => undefined);
    // falls through
    case 'tree':
      spawnStubbornChild();
      await writeLines(fixture('ok').slice(0, 1));
      return hang();
    case 'lingering-child':
      // The CLI answers and exits, but something it started keeps stdout open.
      spawnStubbornChild().unref();
      await writeLines(fixture('ok'));
      return 0;
    default:
      throw new UsageError(`unknown mock scenario: ${scenario}`);
  }
}

/** Runs a mock's entry function and turns usage errors into a loud failure. */
export async function main(kind, entry) {
  try {
    const leaked = Object.keys(process.env).filter((name) =>
      name.toUpperCase().startsWith(APP_ENV_PREFIX),
    );
    if (leaked.length > 0) {
      throw new UsageError(
        `the application's own variables must not reach a CLI: ${leaked.sort().join(', ')}`,
      );
    }
    process.exitCode = await entry(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`mock ${kind}: ${error.message}\n`);
    process.exitCode = USAGE_EXIT_CODE;
  }
  // Something may still hold the event loop open (an inherited pipe); the exit code is final.
  if (process.exitCode !== undefined) process.exit();
}
