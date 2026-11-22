#!/usr/bin/env node
// Mock of the `agy` CLI: `--version`, `models` and the print mode with
// stream-json on both stdin and stdout.
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

const KIND = 'agy';

const RUN_FLAGS = {
  '--print': 'value',
  '--input-format': 'value',
  '--output-format': 'value',
  '--print-timeout': 'value',
  '--model': 'value',
  '--effort': 'value',
  '--disable-slash-commands': 'boolean',
};

/** A complete successful answer whose text arrives as the given deltas. */
function generate(pieces) {
  return [
    JSON.stringify({ type: 'init', session_id: 'synthetic', model: 'mock' }),
    ...pieces.map((text_delta) =>
      JSON.stringify({
        type: 'step_update',
        step_type: 'agent_response',
        state: 'ACTIVE',
        text_delta,
      }),
    ),
    JSON.stringify({
      type: 'result',
      status: 'SUCCESS',
      usage: {
        input_tokens: 10,
        output_tokens: pieces.length,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 10 + pieces.length,
      },
    }),
  ];
}

const cli = {
  kind: KIND,
  generate,
  failures: {
    // Diagnostics go to stderr; a run that cannot start prints nothing on stdout.
    'logged-out': { exitCode: 1, stdout: false, stderr: 'Error: authentication required' },
    quota: { exitCode: 1 },
    'rate-limited': { exitCode: 1 },
    'model-not-found': {
      exitCode: 1,
      stdout: false,
      stderr: 'Error: unknown model "mock-model-not-found"',
    },
  },
};

/** The prompts of the stream-json input: one `user` event per line. */
function promptsFrom(input) {
  return input
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new UsageError('stdin is not stream-json');
      }
      if (event?.event !== 'user' || typeof event.message?.content !== 'string') {
        throw new UsageError('stdin lines must be {"event":"user","message":{"content":"..."}}');
      }
      return event.message.content;
    });
}

main(KIND, async (argv) => {
  if (argv.length === 1 && argv[0] === '--version') {
    logInvocation(KIND);
    process.stdout.write('agy 1.5.14\n');
    return 0;
  }
  if (argv.length === 1 && argv[0] === 'models') {
    logInvocation(KIND);
    process.stdout.write('Available models:\n  mock-gemini-pro\n  mock-gemini-flash\n');
    return 0;
  }

  const { flags, positionals } = parseFlags(argv, RUN_FLAGS, { '-p': '--print' });
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  requireFlag(flags, '--print', '');
  requireFlag(flags, '--input-format', 'stream-json');
  requireFlag(flags, '--output-format', 'stream-json');
  requireFlag(flags, '--print-timeout');
  requireFlag(flags, '--disable-slash-commands');
  if (!/^[1-9]\d*s$/.test(flags['--print-timeout'])) {
    throw new UsageError(`--print-timeout must be whole seconds, got ${flags['--print-timeout']}`);
  }
  if (process.env.AGY_CLI_DISABLE_AUTO_UPDATE !== 'true') {
    throw new UsageError('AGY_CLI_DISABLE_AUTO_UPDATE must be "true"');
  }

  const scenario = scenarioFor(flags['--model']);
  if (scenario === 'hang') {
    logInvocation(KIND, { scenario });
    return play(cli, scenario, {});
  }
  // Like the real CLI, this waits for stdin to be closed before answering.
  const prompts = promptsFrom(await readStdin());
  if (prompts.length !== 1) throw new UsageError(`expected one prompt, got ${prompts.length}`);
  logInvocation(KIND, { scenario, prompt: prompts[0] });
  return play(cli, scenario, { prompt: prompts[0] });
});
