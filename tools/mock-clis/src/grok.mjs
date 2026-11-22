#!/usr/bin/env node
// Mock of the `grok` CLI: `version`, `models` and the headless mode with
// `--output-format streaming-json`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  UsageError,
  logInvocation,
  main,
  parseFlags,
  play,
  requireFlag,
  scenarioFor,
} from './lib/runtime.mjs';

const KIND = 'grok';

const RUN_FLAGS = {
  '--prompt-file': 'value',
  '--output-format': 'value',
  '--model': 'value',
  '--cwd': 'value',
  '--no-auto-update': 'boolean',
  '--max-turns': 'value',
  '--no-plan': 'boolean',
  '--no-subagents': 'boolean',
  '--tools': 'value',
  '--disallowed-tools': 'value',
  '--sandbox': 'value',
};

/** A complete successful answer whose text arrives as the given fragments. */
function generate(pieces) {
  const usage = { inputTokens: 10, outputTokens: pieces.length };
  return [
    ...pieces.map((data) => JSON.stringify({ type: 'text', data })),
    JSON.stringify({ type: 'usage', data: usage }),
    JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'synthetic', usage }),
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

main(KIND, async (argv) => {
  if (argv.length === 1 && argv[0] === 'version') {
    logInvocation(KIND);
    process.stdout.write('grok 1.0.92\n');
    return 0;
  }
  if (argv.length === 1 && argv[0] === 'models') {
    logInvocation(KIND);
    process.stdout.write('mock-grok-large\nmock-grok-fast\n');
    return 0;
  }

  const { flags, positionals } = parseFlags(argv, RUN_FLAGS, { '-m': '--model' });
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  requireFlag(flags, '--prompt-file');
  requireFlag(flags, '--output-format', 'streaming-json');
  requireFlag(flags, '--cwd');
  requireFlag(flags, '--no-auto-update');
  requireFlag(flags, '--max-turns', '1');
  requireFlag(flags, '--no-plan');
  requireFlag(flags, '--no-subagents');
  requireFlag(flags, '--tools', '');
  if (flags['--sandbox'] !== undefined && flags['--sandbox'] !== 'read-only') {
    throw new UsageError(`--sandbox must be read-only, got ${flags['--sandbox']}`);
  }
  if (process.env.GROK_MEMORY !== '0') throw new UsageError('GROK_MEMORY must be "0"');
  if (path.dirname(flags['--prompt-file']) !== flags['--cwd']) {
    throw new UsageError('the prompt file must be inside the working directory');
  }

  // The real CLI never reads a prompt from stdin.
  let prompt;
  try {
    prompt = readFileSync(flags['--prompt-file'], 'utf8');
  } catch {
    throw new UsageError(`cannot read the prompt file ${flags['--prompt-file']}`);
  }
  const scenario = scenarioFor(flags['--model']);
  logInvocation(KIND, { scenario, prompt });
  return play(cli, scenario, { prompt });
});
