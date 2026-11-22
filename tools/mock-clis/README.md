# Mock CLIs

One fake executable per CLI provider kind (`claude`, `codex`, `agy`, `grok`).
Each accepts the argument shapes of the real CLI, replays a fixture in the
real CLI's output format, and can misbehave on request, so adapters and
end-to-end tests never need a real account or the network.

Nothing here talks to a vendor. The mocks never read a credential file.

## Layout

| Path                                | Content                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `src/<kind>.mjs`                    | The mock: argument validation, status subcommands, the run mode.               |
| `src/lib/runtime.mjs`               | Shared: strict flag parser, scenario selection, fixture replay, the scenarios. |
| `fixtures/<kind>/*.synthetic.jsonl` | Output streams, one JSON event per line after a `#` header line.               |
| `bin/<kind>`                        | POSIX launcher (a `sh` script).                                                |
| `bin/<kind>.cmd`, `bin/<kind>.ps1`  | Windows launchers in the exact form npm writes for a package's bin entry.      |

## Using the mocks

Put `bin/` first on the `PATH` handed to the provider registry (the `env`
dependency of `createProviderRegistry`), together with the directory of the
`node` executable:

```
PATH=<repo>/tools/mock-clis/bin:<dir of node>
```

On POSIX the adapters find `bin/claude` and run it. On Windows they find
`bin/claude.cmd`, which is never executed: executable resolution reduces the
shim to `node.exe <repo>\tools\mock-clis\src\claude.mjs` and starts that, the
same way it treats a CLI installed with `npm install -g`. There is no compiled
`.exe` form of the mocks; resolution of a native `.exe` on `PATH` is covered
by the resolver's unit tests against synthetic directory layouts.

The `bin` entries of `package.json` point at the same scripts, for a package
that wants them linked into its `node_modules/.bin`.

## Choosing a scenario

A model named `mock-<scenario>` selects the scenario for that run. Otherwise
the environment variable `MOCK_CLI_SCENARIO` does; the default is `ok`. The
status subcommands only look at the environment variable.

| Scenario          | Behaviour                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `ok`              | A short answer, token by token where the CLI streams tokens, with usage.                  |
| `echo`            | Answers `You said: <prompt>`, to prove how the prompt travelled.                          |
| `slow`            | The `ok` answer with `MOCK_CLI_DELAY_MS` (default 40) between lines.                      |
| `chunked`         | The `ok` answer with CRLF line endings, written seven bytes at a time.                    |
| `block`           | A whole message at once, no token deltas.                                                 |
| `reasoning`       | Reasoning before the answer.                                                              |
| `tool-denied`     | The model asks for a tool; the call is denied; an answer follows.                         |
| `incremental`     | codex only: one item growing through `item.updated` events.                               |
| `hang`            | Prints nothing, does not read stdin, never exits.                                         |
| `init-hang`       | Prints the first line of the `ok` answer, then never exits.                               |
| `logged-out`      | The run fails as it does without a login; the status subcommand reports "not logged in".  |
| `quota`           | The run fails with the usage limit reached.                                               |
| `rate-limited`    | The run fails after being rate limited.                                                   |
| `model-not-found` | The run fails because the model does not exist.                                           |
| `exit-nonzero`    | Exit code 3 with a diagnostic on stderr that contains a path.                             |
| `garbage`         | Plain text instead of the documented format, exit code 0.                                 |
| `huge`            | An answer of `MOCK_CLI_HUGE_BYTES` (default 3 MiB).                                       |
| `stderr-noise`    | The `ok` answer with tens of kilobytes of noise on stderr between the lines.              |
| `tree`            | Starts a child that ignores SIGTERM and shares stdout, prints one line, then never exits. |
| `stubborn-tree`   | Like `tree`, but the CLI itself ignores SIGTERM too, so only SIGKILL ends it.             |
| `lingering-child` | Answers and exits, while a child it started keeps stdout open.                            |

The mocks that take their prompt on stdin (`claude`, `codex`, `agy`) answer
only after stdin has been closed, so an adapter that forgets to close it
hangs here exactly as it would with the real CLI. `grok` never reads stdin.

Set `MOCK_CLI_LOG` to a file and every invocation appends one JSON line to
it: `kind`, `pid`, `argv`, `cwd`, the names of all environment variables, the
values of a few fixed ones, the scenario and the prompt it received. The
`tree`, `stubborn-tree` and `lingering-child` scenarios also log `grandchildPid`. That child's
command line ends with the mock's script path and `stubborn-child`, so
`pgrep -af 'src/(claude|codex|grok|agy).mjs'` lists it with the mocks when
something has left it behind.

Set `MOCK_CLI_REMOVED_FEATURE` to a feature name and the mock `codex` treats
that name as one it does not know: it prints `Error: Unknown feature flag:
<name>` and exits 1, as the real CLI does for any unknown `--disable` name.

## Strictness

An argument the mock does not know, a missing required argument, a wrong
value, a prompt in the wrong place or a missing environment setting ends the
mock with exit code 64 and a message on stderr. This is deliberate: when an
adapter's invocation drifts from what is written down here, its tests fail.
The same happens when a variable named `ANSWERWALL_*` (the application's own
settings and secrets) is in the mock's environment, whatever the command: a
CLI child must never receive those.
When phase P1 changes an invocation, change the adapter's `build…Args`
function, its unit test, and the flag table of the mock together.

## Fixtures

Every fixture is named `*.synthetic.jsonl` and starts with a header line
`# synthetic, from documentation (…)`. None is a recording of a real run:
they were written from each CLI's documented stream format. Phase P1 replaces
them with recordings (keep the scenario name, drop `.synthetic` from the file
name and update `loadFixture` in `src/lib/runtime.mjs` accordingly), with
account identifiers removed.

## What is confirmed and what is assumed

"Confirmed" means checked on a machine with the CLI installed, by reading
`--help` output or running a status subcommand (claude 2.1.330, codex-cli
0.167.0). No prompt was ever sent to a real CLI, so no output stream is
confirmed. `agy` and `grok` were not installed; everything about them comes
from their documentation.

### claude

| Item                                                                                                                                                                                         | Source                                           | Confirmed                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `-p`, `--output-format stream-json`, `--verbose`, `--include-partial-messages` exist                                                                                                         | `claude --help`                                  | yes                                                         |
| `--tools ""` disables all built-in tools                                                                                                                                                     | `claude --help`                                  | yes (flag exists; effect on a run not checked)              |
| `--strict-mcp-config`, `--safe-mode`, `--disable-slash-commands`, `--no-session-persistence` exist                                                                                           | `claude --help`                                  | yes                                                         |
| `--permission-prompts none` exists                                                                                                                                                           | `claude --help`                                  | yes                                                         |
| `--model <m>`, `--effort <level>` exist                                                                                                                                                      | `claude --help`                                  | yes                                                         |
| `--version` prints `<semver> (Claude Code)`                                                                                                                                                  | `claude --version`                               | yes                                                         |
| `auth status` prints JSON with `loggedIn`, `authMethod`, `apiProvider` (and identifying fields)                                                                                              | `claude auth status`                             | yes                                                         |
| `auth status` exits 0 when logged in                                                                                                                                                         | `claude auth status`                             | yes                                                         |
| `auth status` exits 1 and prints `loggedIn: false` when logged out                                                                                                                           | CLI reference                                    | no                                                          |
| `authMethod` values `api_key`, `api_key_helper`, `third_party` mean API billing                                                                                                              | CLI reference                                    | no                                                          |
| The prompt is read from stdin when `-p` has no argument                                                                                                                                      | headless docs                                    | no                                                          |
| Text deltas are `stream_event` lines with `event.delta.type == "text_delta"`                                                                                                                 | headless docs                                    | no                                                          |
| Thinking deltas are `thinking_delta` with a `thinking` field                                                                                                                                 | API streaming docs                               | no                                                          |
| The final `result` line carries `is_error`, `result`, `usage`, `permission_denials`                                                                                                          | headless docs                                    | no                                                          |
| `system`/`api_retry` lines carry `error` (`rate_limit`, `billing_error`, …)                                                                                                                  | headless docs                                    | no                                                          |
| `rate_limit_event` with `rate_limit_info.status == "rejected"` precedes a usage-limit failure                                                                                                | assumption                                       | no                                                          |
| A logged-out run prints a `result` with `is_error: true` and exits 1                                                                                                                         | assumption                                       | no                                                          |
| `ENABLE_CLAUDEAI_MCP_SERVERS=false` keeps account connectors out                                                                                                                             | docs                                             | no                                                          |
| With these flags the init event reports no tools, MCP servers or plugins                                                                                                                     | assumption                                       | no                                                          |
| `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is a subscription login; `auth status` then reports `authMethod: "oauth_token"`                                                        | `claude setup-token --help`, authentication docs | no (the variable exists; the status output was not checked) |
| `ANTHROPIC_PROFILE` and the federation variables (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`) select a login that outranks the subscription | authentication docs                              | no (what `auth status` reports for them is unknown)         |

### codex

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Source                                          | Confirmed                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `exec --json --color never --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules` exist                                                                                                                                                                                                                                                                                                                                                                                                                        | `codex exec --help`                             | yes                                                                                         |
| `-s read-only`, `-C <dir>`, `-m <model>`, `-c key=value`, `--disable <feature>` exist                                                                                                                                                                                                                                                                                                                                                                                                                                          | `codex exec --help`                             | yes                                                                                         |
| A prompt of `-` is read from stdin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `codex exec --help`                             | yes                                                                                         |
| Features `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`, `image_generation`, `browser_use`, `computer_use`, `sleep_tool`, `view_image` exist                                                                                                                                                                                                                                                                                                                                                          | `codex features list`                           | yes                                                                                         |
| An unknown `--disable` name ends the CLI with `Error: Unknown feature flag: <name>`, exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                    | `codex debug prompt-input`                      | yes                                                                                         |
| Disabling those features does **not** leave the model without tools. With the default model family the model is still offered `exec` (code mode), `wait`, `request_user_input` and a `collaboration` namespace (`spawn_agent`, `send_message`, …) with a sub-agent role message; `--disable multi_agent` changes nothing there. `sleep_tool` and `view_image` do remove their tools. An older model (`gpt-5.5`) renders with no tools under the same flags. Whether sub-agents actually start in `codex exec` was not observed | `codex debug prompt-input`                      | yes (rendered prompt only)                                                                  |
| `--ignore-user-config` skips `config.toml` only: the global `AGENTS.md` and the skills under `CODEX_HOME` still reach the model, and no tested switch removes them (`project_doc_max_bytes=0`, `skills.enabled=false`, `--disable skill_search` do not)                                                                                                                                                                                                                                                                        | `codex debug prompt-input`, `codex exec --help` | yes (rendered prompt; the exec-time effect of `--ignore-user-config` is from its help text) |
| `--version` prints `codex-cli <semver>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `codex --version`                               | yes                                                                                         |
| `login status` prints `Logged in using ChatGPT` on stderr, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `codex login status`                            | yes                                                                                         |
| `login status` when logged out prints `Not logged in`, non-zero exit                                                                                                                                                                                                                                                                                                                                                                                                                                                           | assumption                                      | no                                                                                          |
| `login status` with a ChatGPT login prints the same sentence when `OPENAI_API_KEY` or `CODEX_API_KEY` is set                                                                                                                                                                                                                                                                                                                                                                                                                   | `codex login status`                            | yes                                                                                         |
| `login status` after a login with an API key mentions "API key"                                                                                                                                                                                                                                                                                                                                                                                                                                                                | assumption                                      | no                                                                                          |
| `codex exec` uses `CODEX_API_KEY` for the run even when a ChatGPT login exists                                                                                                                                                                                                                                                                                                                                                                                                                                                 | non-interactive docs                            | no                                                                                          |
| `debug models` prints `{ models: [{ slug, display_name, visibility, supported_reasoning_levels: [{ effort }] }] }`                                                                                                                                                                                                                                                                                                                                                                                                             | `codex debug models --bundled`                  | yes                                                                                         |
| `-c model_reasoning_effort="<level>"` selects the effort                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | configuration docs                              | no                                                                                          |
| Events: `thread.started`, `turn.started`, `item.started/updated/completed`, `turn.completed`, `turn.failed`, `error`                                                                                                                                                                                                                                                                                                                                                                                                           | non-interactive docs                            | no                                                                                          |
| `agent_message` and `reasoning` items carry `text`; `turn.completed` carries `usage`                                                                                                                                                                                                                                                                                                                                                                                                                                           | non-interactive docs                            | no                                                                                          |
| The answer arrives as whole items (`streaming: 'block'`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | non-interactive docs                            | no                                                                                          |
| Failure messages for logged out, usage limit, 429 and unknown model                                                                                                                                                                                                                                                                                                                                                                                                                                                            | assumption                                      | no                                                                                          |

### agy

| Item                                                                                                                                                                                                              | Source                           | Confirmed                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------- |
| `-p <prompt>` selects print mode and takes the next argument as the prompt                                                                                                                                        | headless docs, third-party guide | no                                  |
| `--input-format stream-json` reads `{"event":"user","message":{"content":…}}` lines from stdin; the `-p` prompt is then ignored                                                                                   | headless docs                    | no                                  |
| The run starts when stdin is closed                                                                                                                                                                               | headless docs                    | no                                  |
| `--output-format stream-json` prints `init`, `step_update`, `result` events                                                                                                                                       | headless docs                    | no                                  |
| The event name is in a `type` field (the adapter also accepts `event`)                                                                                                                                            | assumption                       | no                                  |
| Text deltas are `step_update` with `step_type: "agent_response"` and `text_delta`                                                                                                                                 | headless docs                    | no                                  |
| Thinking and tool steps have step types containing `think`/`reason` or `tool`/`command`/…                                                                                                                         | assumption                       | no                                  |
| `result.status` is `SUCCESS`, `ERROR`, `CANCELED`, …; `usage` has `input_tokens`, `output_tokens`, `thinking_tokens`                                                                                              | headless docs                    | no                                  |
| A failed `result` carries its message in `error` or `message`                                                                                                                                                     | assumption                       | no                                  |
| `--print-timeout <n>s` takes a duration in seconds                                                                                                                                                                | CLI reference                    | no                                  |
| `--model <slug>`, `--effort <level>`, `--disable-slash-commands` exist                                                                                                                                            | CLI reference                    | no                                  |
| An unknown model exits 1 with a message on stderr, no fallback                                                                                                                                                    | headless docs                    | no                                  |
| A logged-out headless run fails with `authentication required` instead of hanging                                                                                                                                 | docs                             | no                                  |
| `--version` prints a version number                                                                                                                                                                               | assumption                       | no                                  |
| `models` lists model slugs, one per line                                                                                                                                                                          | assumption (format undocumented) | no                                  |
| `AGY_CLI_DISABLE_AUTO_UPDATE=true` stops the background self-update                                                                                                                                               | troubleshooting docs             | no                                  |
| No flag disables tools; there is no login status command                                                                                                                                                          | CLI reference                    | no                                  |
| With `agentMode` unset, `agy -p` runs in `auto` mode since v1.5.7 where that mode is available (it approves edits in the work dir and sandboxed commands), otherwise in `default`. The adapter passes no `--mode` | headless docs                    | no                                  |
| `--mode default` is accepted (the reference lists only `accept-edits`, `auto`, `plan`; the headless page mentions `auto` and `default`)                                                                           | headless docs                    | no (try in P1 before relying on it) |

### grok

| Item                                                                                                                       | Source                           | Confirmed |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------- |
| `--prompt-file <path>`, `--output-format streaming-json`, `-m <model>`, `--cwd <path>` exist                               | headless docs                    | no        |
| `--no-auto-update`, `--max-turns <n>`, `--no-plan`, `--no-subagents` exist                                                 | CLI reference                    | no        |
| `--tools ""` (an empty allowlist) leaves the model without tools                                                           | assumption                       | no        |
| `--sandbox read-only` exists; a sandbox is documented for Linux (Landlock) and macOS (Seatbelt), not for Windows           | sandbox docs                     | no        |
| A sandbox that cannot be applied is skipped with a warning and the run continues without it, so "read-only" is best effort | sandbox docs                     | no        |
| Headless mode never reads the prompt from stdin                                                                            | headless docs                    | no        |
| `GROK_MEMORY=0` switches cross-session memory off                                                                          | headless docs                    | no        |
| Events have a `type`: `text` and `thought` with the fragment in `data`, `tool_call`, `usage`, `end`, `error`               | headless docs                    | no        |
| `end` is the last event and carries `stopReason`, `sessionId`, `usage`                                                     | headless docs                    | no        |
| Field names inside `usage` (`inputTokens`, `outputTokens`, `reasoningTokens`)                                              | assumption                       | no        |
| `tool_call` carries the tool name in `data.name`                                                                           | assumption                       | no        |
| `error` carries `message`; the process exits 1                                                                             | headless docs                    | no        |
| `version` prints a version number                                                                                          | CLI reference                    | no        |
| `models` lists model ids, one per line                                                                                     | assumption (format undocumented) | no        |
| There is no effort flag (a requested effort is not passed on) and no login status command                                  | CLI reference                    | no        |
