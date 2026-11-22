#!/usr/bin/env node
// Mock of the `claude` CLI: `--version`, `auth status` and the print mode
// with `--output-format stream-json`.
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

const KIND = 'claude';

const RUN_FLAGS = {
  '--print': 'boolean',
  '--output-format': 'value',
  '--verbose': 'boolean',
  '--include-partial-messages': 'boolean',
  '--tools': 'value',
  '--strict-mcp-config': 'boolean',
  '--safe-mode': 'boolean',
  '--disable-slash-commands': 'boolean',
  '--no-session-persistence': 'boolean',
  '--permission-prompts': 'value',
  '--model': 'value',
  '--effort': 'value',
  '--system-prompt': 'value',
};

const stream = (event) =>
  JSON.stringify({
    type: 'stream_event',
    event,
    session_id: 'synthetic',
    parent_tool_use_id: null,
  });

/** A complete successful answer whose text arrives as the given deltas. */
function generate(pieces) {
  const whole = pieces.join('');
  return [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'synthetic',
      model: 'mock',
      tools: [],
      mcp_servers: [],
      plugins: [],
      slash_commands: [],
    }),
    stream({ type: 'message_start', message: { role: 'assistant', content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...pieces.map((text) =>
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ),
    stream({ type: 'content_block_stop', index: 0 }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: whole }] },
      session_id: 'synthetic',
      parent_tool_use_id: null,
    }),
    stream({ type: 'message_stop' }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: whole,
      session_id: 'synthetic',
      usage: { input_tokens: 10, output_tokens: pieces.length },
      permission_denials: [],
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

function authStatus() {
  const loggedIn = scenarioFor(undefined) !== 'logged-out';
  // The identifying fields are here so that tests can prove they are dropped.
  const status = loggedIn
    ? {
        loggedIn: true,
        authMethod: process.env.ANTHROPIC_API_KEY ? 'api_key' : 'claude.ai',
        apiProvider: 'firstParty',
        email: 'mock.user@example.com',
        orgId: 'org-mock-0001',
        orgName: 'Mock Organisation',
        subscriptionType: 'max',
        configDirectory: '/home/mock/.claude',
      }
    : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return loggedIn ? 0 : 1;
}

main(KIND, async (argv) => {
  if (argv.length === 1 && argv[0] === '--version') {
    logInvocation(KIND);
    process.stdout.write('2.1.330 (Claude Code)\n');
    return 0;
  }
  if (argv.length === 2 && argv[0] === 'auth' && argv[1] === 'status') {
    logInvocation(KIND);
    return authStatus();
  }

  const { flags, positionals } = parseFlags(argv, RUN_FLAGS, { '-p': '--print' });
  if (positionals.length > 0) {
    throw new UsageError(`the prompt must arrive on stdin, not as an argument: ${positionals[0]}`);
  }
  requireFlag(flags, '--print');
  requireFlag(flags, '--output-format', 'stream-json');
  requireFlag(flags, '--verbose');
  requireFlag(flags, '--include-partial-messages');
  requireFlag(flags, '--tools', '');
  requireFlag(flags, '--strict-mcp-config');
  requireFlag(flags, '--safe-mode');
  requireFlag(flags, '--disable-slash-commands');
  requireFlag(flags, '--no-session-persistence');
  requireFlag(flags, '--permission-prompts', 'none');
  if (process.env.ENABLE_CLAUDEAI_MCP_SERVERS !== 'false') {
    throw new UsageError('ENABLE_CLAUDEAI_MCP_SERVERS must be "false"');
  }
  if (process.env.CLAUDECODE !== undefined) {
    throw new UsageError('started inside another session (CLAUDECODE is set)');
  }

  const scenario = scenarioFor(flags['--model']);
  if (scenario === 'hang') {
    logInvocation(KIND, { scenario });
    return play(cli, scenario, {});
  }
  const prompt = await readStdin();
  logInvocation(KIND, { scenario, prompt });
  return play(cli, scenario, { prompt });
});
