# AnswerWall — engineering decisions

This file is the binding contract for everyone working on this repository. It
amends the original plan after a fact-checking review. Where it conflicts with
older notes, this file wins. Change it in the same commit as any change that
contradicts it.

## 1. Product

- Name: **AnswerWall**. The name lives in exactly one place
  (`packages/core/src/brand.ts`) and is imported everywhere else (UI title,
  Electron `productName`, Docker labels, CLI binary name `answerwall`).
- One prompt in, N answers side by side, streamed. It is a question/answer
  comparison tool, **not** a coding agent.
- Repository: `github.com/onlyfly34/answerwall`, public, MIT.
- Stack: TypeScript strict, Node 24 LTS (pinned in `.nvmrc` and `engines`),
  pnpm 12 workspaces (`packageManager` pinned), SolidJS + Vite for the web UI,
  Vitest, Playwright, ESLint. English first, Traditional Chinese (zh-TW) second.

## 2. Hard rules (never violate)

1. Only spawn the official, unmodified CLI binaries as child processes, using
   their documented non-interactive modes. Never embed a vendor SDK package to
   reach a subscription (`@anthropic-ai/claude-agent-sdk` and similar are
   forbidden dependencies).
2. Never read, stat, copy, proxy, log or store any CLI credential or OAuth
   token file. Login state is detected only through the CLI's own status
   subcommand. Login is always performed by the CLI itself, in a terminal that
   this app does not capture.
3. Never restrict, disable or bypass any authentication method built into a
   CLI. Never inject credentials to "repair" a CLI.
4. A CLI answers a prompt only because the user pressed Send. Its version
   and status commands (never a prompt) run only at server start (§5) and
   when the user presses Refresh on the provider page. No schedules, no
   polling, no background automation, no automatic retries, no account
   rotation.
5. Single user. No multi-user accounts. Server mode refuses to start without
   authentication. Device pairing is capped and revocable.
6. No telemetry, no analytics, no third-party network calls. Allowed network
   peers: the CLIs the user enabled, the OpenAI-compatible endpoints the user
   configured, and (optional, off-switch in settings, desktop app only) the
   GitHub release check. No Web Push (it needs a vendor push service).
7. The README must **not** claim that using a subscription through this tool
   is "compliant" or "allowed". It quotes the vendors' own wording, links the
   source, and states the residual risk. Product name, icon and UI never use a
   vendor's name or logo as branding; plain-text provider labels are fine
   ("Claude", "Codex", "Gemini (agy)", "Grok", "OpenCode").
8. Commits: authored by and `Signed-off-by` the repository owner
   (`git commit -s`). No AI attribution lines of any kind in commits, PR
   bodies, code comments or docs.

## 3. Deployment modes

| Mode | What runs where |
|---|---|
| Server | `apps/server` (Node) — in Docker or directly on a host. Serves UI + API on one origin. |
| Desktop (local) | Electron app starts core in a `utilityProcess`, bound to `127.0.0.1` on a random port. |
| Desktop (remote) | Electron window does `loadURL(<server origin>)` — it shows the **server's own** UI, so UI and API versions always match. |

- The server **always** serves the web UI and the API from the same origin.
  There is no CORS support at all: no `Access-Control-*` headers are ever sent.
- The Electron "connection settings" screen (local/remote switch, remote URL)
  is a small page bundled in the app, not part of the remote UI.
- Remote windows: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, no preload (or a minimal one), `will-navigate`
  blocks leaving the origin, `setWindowOpenHandler` denies and forwards
  http(s) links to `shell.openExternal`.

## 4. Repository layout

```
packages/core     server library: providers, runner, HTTP API, storage, auth, TLS
packages/web      SolidJS + Vite UI, PWA
apps/server       Node entry point, `answerwall` CLI (serve, pair), Dockerfile
apps/desktop      Electron shell (phase P2)
tools/mock-clis   fake CLIs replaying recorded fixtures
e2e               Playwright tests against server + mock CLIs
docs              user and developer docs
```

- No native Node modules in the default build. Storage uses the built-in
  `node:sqlite` behind a small `Storage` interface. `node-pty` is **not** a
  dependency; if a PTY fallback is ever needed it is an optional, lazily
  imported dependency behind an adapter-level switch.
- HTTP: Hono on `@hono/node-server` (http and https). Request validation with
  zod. Keep dependencies few and mainstream; verify current versions with
  `npm view` before pinning — do not guess versions from memory.
- Each provider adapter is one file under `packages/core/src/providers/`.
  Adding a provider means adding one file and one registry line.

## 5. Providers

Provider **instances** are configured in settings:

```ts
type ProviderKind = 'claude' | 'codex' | 'agy' | 'grok' | 'opencode' | 'openai-compat';
interface ProviderInstance {
  id: string;            // stable; CLI kinds use the kind as id, openai-compat uses a slug
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  concurrency: number;   // CLI kinds: 1..5 (default 2, agy fixed at 1); openai-compat: 1..32 (default 4)
  models: string[];      // user-editable list; merged with listModels() when available
  defaultModel?: string;
  // CLI kinds only: useEnvApiKey (§5.1), riskAcknowledged (agy), webSearch (§5.3)
  // openai-compat only: baseUrl, hasApiKey (the key itself lives in SecretStore)
}
```

Each CLI kind has exactly one instance, which can be disabled but not removed;
only openai-compat instances are added and removed. agy (vendor notice) and
opencode (without a configuration of its own it answers with a hosted model
the user never chose) are disabled on a new installation.

Adapter contract:

```ts
interface ProviderAdapter {
  kind: ProviderKind;
  detect(inst): Promise<{ installed: boolean; version?: string;
    loggedIn: 'yes'|'no'|'unknown'; billing?: 'subscription'|'api-key'|'unknown';
    streaming: 'token'|'block'|'unknown'; hint?: string }>;
  listModels?(inst): Promise<{ id: string; label?: string; efforts?: string[] }[]>;
  run(inst, req: { prompt: string; model?: string; effort?: string;
    timeoutMs: number; signal: AbortSignal; workDir: string }): AsyncIterable<ProviderEvent>;
}
type ProviderEvent =
  | { type: 'start'; streaming?: 'token'|'block'|'unknown' }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'notice'; message: string }            // e.g. a tool call was denied
  | { type: 'done'; usage?: Usage; elapsedMs: number }
  | { type: 'error'; code: ErrorCode; message: string };
type ErrorCode = 'not_installed' | 'not_logged_in' | 'quota' | 'rate_limited'
  | 'model_not_found' | 'timeout' | 'cancelled' | 'spawn_failed'
  | 'bad_output' | 'network' | 'prompt_too_long' | 'unsupported' | 'unknown';
```

`detect()` results are cached; they are recomputed only at server start and
when the user presses Refresh. `GET /api/providers` never spawns anything.
While a detection is running, the status of that provider says
`detecting: true`; a page that was loaded meanwhile reads the list again
(once a second, a plain `GET`) until it is `false`, so the result of the
detection at server start reaches a page opened right after the start.
`detect()` must drop identifying fields (email, org, absolute paths) before
anything reaches the API, the log or the database.

### 5.1 Common rules for CLI adapters

- Spawn with an argv array, `shell: false`, always. On Windows resolve the real
  executable first: if PATH yields a `.cmd`/`.ps1` npm shim, resolve the
  underlying `node <script>` or `.exe` and spawn that. Never fall back to
  `shell: true`. User input never appears in argv.
- Prompt transport: stdin when the CLI documents it (write, then **close**
  stdin). Otherwise a prompt file inside the per-request work dir.
- Every request gets a fresh empty work dir under the app data dir; it is the
  child's cwd and is deleted when the slot finishes.
- Environment: start from the user's environment, then **remove**
  - always: every `ANSWERWALL_*` variable (the app's own settings and
    secrets; no CLI needs them, and a CLI whose tools can read its
    environment must never see them);
  - always: the nested-session markers `CLAUDECODE`, `CLAUDE_EFFORT`,
    `CLAUDE_PID`, `AI_AGENT` and every `CLAUDE_CODE_*`, except `CLAUDE_CODE_OAUTH_TOKEN`
    and the billing group below. `CLAUDE_CODE_OAUTH_TOKEN` is the CLI's own
    headless subscription login (rule 2.3): it is passed through as the user
    set it, and its value is never read, logged or stored;
  - by default: API-key style variables that silently switch billing away
    from the subscription (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
    `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`,
    `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`,
    `CLAUDE_CODE_USE_*` together with `CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY}_AUTH`,
    `CODEX_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`,
    `GOOGLE_API_KEY`).

  A per-provider setting "use API key from environment" keeps the billing
  group; the provider page shows which billing source is in effect. When the
  CLI's own status reports a subscription login although such variables are
  kept, the page shows that status and a hint that the CLI reports its own
  login (claude with only `ANTHROPIC_BASE_URL`, codex with `OPENAI_API_KEY`).
  Exception: codex with `CODEX_API_KEY` kept reports billing `api-key`,
  because the CLI then authenticates with that key whatever login is saved
  (`codex doctor` reports API key auth while `codex login status` still
  reports the ChatGPT login; checked on 0.167.0, no prompt was sent with a
  key). `OPENAI_API_KEY` alone does not replace a ChatGPT login. Also set
  `NO_COLOR=1`, `TERM=dumb`.
- Run each CLI in its most restricted question-answering configuration: no
  tools where the CLI allows it, no user customisations, no session
  persistence. Where a CLI cannot disable tools, say so in the provider page
  and README.
- Cancellation and timeout (default 5 min, configurable): POSIX — spawn
  `detached`, `kill(-pid, SIGTERM)`, then `SIGKILL` after 3 s. Windows —
  `taskkill /T /F /PID`. On server/Electron shutdown kill every child. An
  exit that does not wait for the shutdown (a second signal, a shutdown that
  timed out, a crash) first kills every child tree whose slot has not
  finished, synchronously (`killChildProcessTrees`: `SIGKILL` to the group,
  or `taskkill /T /F` run to completion), because no timer runs after it.
- The server stops on SIGINT, SIGTERM, SIGHUP and SIGBREAK, on the IPC
  message `shutdown` (the only way to stop it gracefully on Windows), and
  when the supervisor that started it with an IPC channel disconnects. A
  closed stdout or stderr never ends the process: output to it is dropped.
  In the desktop app the core process is a utility process, which ends
  without running any code when the main process is killed: a helper
  process started by the core process is told of every child tree
  (`watchChildProcessTrees`) and kills those still running when its pipe to
  the core process closes (`docs/desktop.md`).
- Parse line-delimited JSON defensively: unknown event types are ignored, an
  unparsable stream falls back to showing the raw text rather than an empty
  cell. Do not assume the first line is the init event.
- A provider that only emits whole messages reports `streaming: 'block'`; the
  UI shows "generating (this provider does not stream token by token)".

### 5.2 Invocations

claude and codex are confirmed: each was run against the real CLI with tiny
prompts (claude 2.1.330 and codex-cli 0.167.0, both on Linux with a
subscription login), fixtures were recorded from those runs, and each
paragraph ends with what is still unconfirmed. Nothing was run on Windows.
opencode is confirmed too, in another way: the real CLI (2.3.2, Linux) was
run against the local OpenAI-compatible stub endpoint with a throwaway home
directory, so every behaviour of the CLI itself is observed and nothing
about a hosted provider or a sign-in is.
agy and grok are starting points from `--help` output and official docs and
have **not** been confirmed with real prompts. `tools/mock-clis/README.md`
lists the evidence item by item.

- **claude** (confirmed on 2.1.330) — `claude -p --output-format stream-json
  --verbose --include-partial-messages --tools "" --strict-mcp-config
  --safe-mode --restricted --disable-slash-commands --no-session-persistence
  --permission-prompts none --system-prompt <short Q&A prompt> --model <m>
  --effort <e>`, prompt on stdin; env `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
  `--verbose` is required with stream-json. Never `--bare` (it ignores
  subscription login). Not `--permission-mode plan`. `--safe-mode` and
  `--restricted` are both needed: either alone leaves a built-in extra. The
  init event then reports no tools, MCP servers, skills or commands; it always
  lists the plugins the CLI ships with (`path: "builtin"`) and its built-in
  agent types, which are inert without tools, and the adapter raises a notice
  for anything else. The CLI attaches the account's e-mail address and the
  working directory to every question and no flag removes that; the system
  prompt tells the model never to repeat them. Text deltas:
  `type=="stream_event"` with `event.delta.type=="text_delta"`. Thinking
  deltas arrive empty, so there is no reasoning text, only a token count.
  Errors: an `assistant` line with `is_api_error_message` and an `error`
  value (shown as the error, never as the answer), the `system`/`api_retry`
  event's `error` field, and the final `result` line; usage comes from
  `modelUsage`. Cancel: SIGTERM ends it with exit code 143. Login:
  `claude auth status --json` (exit 0 when logged in; only `loggedIn`,
  `authMethod`, `apiProvider` are read). No model listing command: models
  come from settings (`haiku`, `sonnet`, `opus`, `fable`, or a full id);
  effort levels `low`, `medium`, `high`, `xhigh`, `max`. Web search: §5.3.
  Confirmed only as a set: which of `--strict-mcp-config`,
  `--disable-slash-commands` and the environment variable is redundant was
  not tested. Unconfirmed: the logged-out, quota and rate-limit failure
  shapes and `auth status` when logged out (exit 1 is from the CLI
  reference); `api_retry` in practice; whether a user-level `CLAUDE.md` is
  suppressed (it rests on the help text of `--safe-mode`); the warning for an
  unknown effort level; and everything on Windows.
- **codex** (confirmed on 0.167.0) — `codex exec --json --color never
  --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
  -s read-only -C <workDir> -m <model> -c model_reasoning_effort="<e>"
  -c web_search="disabled"`, then `-c` for `project_doc_max_bytes=0`,
  `skills.bundled.enabled=false`, `skills.include_instructions=false`,
  `include_permissions_instructions=false`, `include_apps_instructions=false`,
  `include_environment_context=false`,
  `include_collaboration_mode_instructions=false`,
  `tools.experimental_request_user_input.enabled=false`, `agents.max_depth=0`,
  `features.multi_agent_v2.disable_native_tools=true`,
  `features.multi_agent_v2.multi_agent_mode_hint_text=""`,
  `features.multi_agent_v2.root_agent_usage_hint_text=""`, then `--disable`
  for `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`,
  `image_generation`, `browser_use`, `computer_use`, `sleep_tool`,
  `view_image`, then a final `-`; prompt on stdin. With these the model gets
  no shell, no file access, no web search, no skills, no sub-agents and no
  environment block (so it does not know the date). What cannot be removed:
  the CLI's own instructions, the user's global `AGENTS.md`, and the
  `exec`/`wait` script tools, through which only a file edit (refused by the
  read-only sandbox), empty MCP resource listings and a clock are reachable;
  the detection hint says so. `CODEX_HOME` is never moved: the login lives
  there. A feature name or override the installed codex does not accept makes
  it exit 1; the adapter reports `unsupported`. Output is whole items only
  (`item.completed`; no `item.updated`, no deltas): `streaming: 'block'`.
  Reasoning summaries appear only with `-c model_reasoning_summary`, which is
  not passed. Cancel: SIGTERM ends it by the signal. Login:
  `codex login status` (message on **stderr**; exit 0 / 1). Models:
  `codex debug models` (JSON; keep `visibility=="list"`).
  `codex debug prompt-input <flags> "hi"` renders the prompt locally, costs
  nothing, and is how each flag is re-checked after a CLI update. Web search:
  §5.3. Unconfirmed: the usage-limit and rate-limit failure shapes; a prompt
  billed through `CODEX_API_KEY` and the effect of `CODEX_ACCESS_TOKEN`
  (which is therefore passed through untouched); `login status` after an
  API-key login; the listed models that were not run; and everything on
  Windows, including how the `""` override values survive argument quoting.
- **agy** (Gemini) — `agy -p "" --input-format stream-json --output-format
  stream-json --print-timeout <n>s --disable-slash-commands --model <slug>
  --effort <e>`, the prompt as one `{"event":"user","message":{"content":…}}`
  line on stdin, which is then closed; env `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
  `--disable-slash-commands` and the environment variable come from research
  notes, not from `agy --help`, and are unconfirmed. Documented `--mode`
  values are `accept-edits`, `auto`, `plan`. Since v1.5.7 an unset
  `agentMode` makes `agy -p` run in `auto` where available; the adapter
  passes no `--mode` (none of the documented values restricts the agent,
  and `default` is not documented). No documented flag disables tools; `--sandbox`
  silently does nothing where unavailable. Credentials live in the OS keyring,
  not in a dot-directory, so containers need extra work. Disabled by default;
  first enable shows the vendor's FAQ wording about third-party wrappers and
  consumer plans. Concurrency fixed at 1.
- **grok** — `grok --prompt-file <file> --output-format streaming-json
  -m <model> --cwd <workDir> --no-auto-update --max-turns 1 --no-plan
  --no-subagents --tools ""`, env `GROK_MEMORY=0`, Linux and macOS add
  `--sandbox read-only` (best effort: the CLI continues without it if it
  cannot be applied; the detection hint says so). Windows has no sandbox,
  so grok's tools are unrestricted there. No effort flag is documented, so effort is not
  passed. Note the
  format name is `streaming-json`. It does not read stdin. Login:
  `grok login --device-auth`. Models: `grok models`.
- **opencode** (confirmed on 2.3.2, the npm package `@opencode/cli`, one of
  the documented ways to install it, put into a scratch prefix; against the
  local stub only; version 1.x is not supported) — `opencode run
  --standalone --format json --thinking --archived --title AnswerWall --agent
  answerwall --model <provider/model[#variant]>`, prompt on stdin, env
  `OPENCODE_DISABLE_CLAUDE_CODE=1`, and one file written into the work dir
  before the start: `opencode.json`, a project configuration that defines the
  agent `answerwall` (`mode: primary`, a short Q&A `system` prompt, the single
  permission rule `*`/`*`/`deny`), the policies `tool.use`, `mcp.use`,
  `skill.use` and `websearch.use` with `*`/`deny`, and `snapshots: false`.
  **This file is the only thing AnswerWall writes for opencode.** It never
  writes the global configuration, the database or a credential, and the file
  names no provider, model or key: the model is whatever the user configured
  in opencode. A variable whose name suggests inline configuration exists in
  the binary but is not documented; it was not tried and is not used
  (rule 2.1).
  - `--standalone`: a private server (`opencode serve --stdio`, a child of
    the run) instead of the shared background service that the CLI, by its
    documentation, otherwise discovers or starts for the user account (in
    the one run made without the flag no service stayed behind). Variables
    stored with `opencode service set env` therefore do not apply.
  - Why an agent and not only rules: with no file, `run` executed a shell
    command the stub asked for, without any prompt, and thirteen tools were
    offered. The CLI appends agent rules after the user's global rules, so a
    global `allow` did not reopen anything; and a run that did not read the
    file fails with `Agent not found` (also when the user's environment has
    `OPENCODE_DISABLE_PROJECT_CONFIG=1`) instead of answering with the
    default agent. With the file one tool stays listed, `skill`, which
    cannot load a skill (`Unable to load skill`); an MCP server of the user's
    configuration was not started; no skill was listed. Policies only
    tighten and a broader configuration of the user outranks them, which is
    why the agent rule carries the weight.
  - `--title` stops a second model request per question (the CLI otherwise
    asks the model for a session title). `--thinking` prints reasoning
    parts. `--archived` is documented to keep scripted runs out of session
    lists; `opencode session list` still showed the session.
  - Prompt on stdin: `run --help` calls the message optional and the docs
    only show it as an argument; that stdin is read was confirmed (252 kB of
    multi-byte and shell-special text arrived byte for byte). User input never
    appears in argv, so no Windows quoting is involved.
  - Output: JSON lines `step_start`, `text`, `reasoning`, `tool_use`,
    `step_finish`, `retry`, `error`. A text part is printed once, when it is
    complete (`streaming: 'block'`; nothing was printed while the stub held a
    half-sent answer). Usage is `step_finish.part.tokens` (`input`, `output`,
    `reasoning`, `cache.read`, `cache.write`), added up over the steps;
    `output` excludes reasoning. There is no final event: the answer ends
    with a `step_finish` whose reason is not `tool-calls` and exit code 0.
  - Failure: one `error` line on stdout and exit code 1, nothing on stderr.
    Seen types: `provider.auth` (401), `provider.quota` (429 with
    `insufficient_quota`), `provider.rate-limit` (429), `provider.transport`
    (connection refused), `provider.internal` (500), `provider.invalid-request`
    (400, and 404 for a model the endpoint does not have), `provider.no-route`
    (a model or variant the configuration does not list), `unknown` (`Invalid
    model reference`, `Agent not found`, `You must provide a message`). For
    transport, 5xx and rate-limit failures **the CLI retries by itself**, ten
    times over 83 to 89 seconds, printing a `retry` line before each new
    attempt; no documented switch turns that off. One Send is one request
    (rule 2.4), so **the adapter ends the run at the first `retry` line**:
    it kills the process tree and reports the failure that line names
    (`rate_limited`, `network`, or the message of a 5xx), with a message
    that says the CLI was stopped. Confirmed with the real CLI against the
    stub answering 429 and 500: the stub saw one request, the run ended
    0.7 s after its start, no second request came in the 20 s after it and
    no process was left. How long the CLI waits before its second attempt
    was not measured; the stop relies on that wait being longer than the
    kill.
  - Effort: the CLI's name for it is a variant, selected as
    `provider/model#variant`; an effort without a model is refused.
  - Cancel: SIGTERM, and SIGKILL, to the process group of the run ended it
    within 0.2 s. The private server is in a session and group of its own,
    so the group kill does not reach it; it ended by itself within a second
    both times and the request to the stub was closed. Nothing was left.
  - Status: `opencode --version` (`opencode v2.3.2`); `opencode auth list
    --standalone --format json` (an array of integrations with their
    `connections`; only whether one exists is read, and none means
    `unknown`, never `no`, because a provider without a key still answered);
    `opencode models --standalone` (one `provider/model` per line, about
    0.6 s, works with the network refused). These run in the system's
    temporary directory with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, because the
    CLI reads project configuration from its working directory upwards and a
    file planted there could name commands to start. Both commands load
    the user's global configuration and start the MCP servers named in it
    for their duration (3.6 s instead of 0.6 s with a test server that
    takes 3 s); nothing documented prevents that outside a project file.
    Billing is reported as unknown.
  - What cannot be removed: the working directory, the date and the platform
    in the system prompt; the global `AGENTS.md` and any between the work dir
    and the home directory (`CLAUDE.md` is removed by the variable above);
    the session the CLI stores in its own database for every question (there
    is no ephemeral mode, and `OPENCODE_DB` is never moved: the saved logins
    are in that database); the user's own configuration above the data
    directory.
  - Network of the CLI itself, seen with `strace` and a refusing proxy: its
    private server on a random loopback port (the API answered 401 without
    credentials), `models.opencode.ai:443` at every start, and probes of
    `127.0.0.1` ports 11434, 1234 and 8000. No telemetry or update host was
    contacted during a run. No documented switch for the catalogue fetch was
    found (`update` in the global configuration governs update checks); an
    undocumented variable stopped it and is not set. The CLI also creates
    `opencode` in the system's temporary directory, and sends trace and
    session headers to the model endpoint.
  - Unconfirmed: any hosted provider or plan sign-in, and what `auth list`
    prints for a saved account; a run without any configuration (the listing
    then shows only the vendor's own hosted models); the shared background
    service running beside a `--standalone` run; the update check; macOS; and
    everything on Windows, where `taskkill /T` is expected to reach the
    private server because it is a child of the run.
- **openai-compat** — `POST {baseUrl}/v1/chat/completions` with
  `stream: true` (SSE), `GET {baseUrl}/v1/models`; supports
  `reasoning_content`; normalise base URLs with or without `/v1`; tolerate
  non-chat models in the list. Any number of endpoints. A base URL never
  carries a user name, password, query string or fragment (rejected on
  write, cut from an address stored by an older version): the address is
  returned by the API, and the credential belongs in the write-only API key.
  A stored API key belongs to the origin it was entered for: changing an
  endpoint's base URL to another scheme, host or port without sending a new
  key deletes the stored one.

### 5.3 Web search switch

With every tool off, answers about recent events are worse than the vendors'
own apps. Where a CLI's built-in web search was confirmed, by a real run, to
work while every other tool stays off, that CLI's provider instance has an
"allow web search" boolean (`webSearch`, default `false`; a stored document
without it reads as off).

| CLI | Switch | Invocation with the switch on | Confirmed by |
|---|---|---|---|
| claude | yes | `--tools WebSearch --allowedTools WebSearch` in place of `--tools ""` | A real run: init reported `tools: ["WebSearch"]`, the model listed no other tool and answered with a current fact. Without the allow rule the search is refused. |
| codex | yes | `-c web_search="live"` in place of `-c web_search="disabled"` | A real run each way: `"live"` printed a `web_search` item and an answer; with `"disabled"` the model said it had no web access. |
| agy | no | — | Not confirmed. |
| grok | no | — | Not confirmed. |
| opencode | no | — | Not examined. Its web search is denied by policy with the other tools. |

- Never claude's `WebFetch`: it is treated as able to reach private
  addresses from this machine, and it was never enabled. Both searches appear
  to run on the vendor's servers.
- `ProviderStatus.webSearch` says `available`, `unconfirmed` (a CLI without
  the switch) or `none` (openai-compat has no tools). The settings refuse
  `webSearch: true` for a kind that is not `available`, repair drops it from
  a stored document, and the adapters ignore it. The providers page shows the
  switch for `available` and "not available" with the reason for
  `unconfirmed`.
- A search is reported in the stream as a `notice`: claude's with the query
  (`Searching the web: <query>`), codex's without. With the switch on, the
  claude adapter accepts `WebSearch` in the init event and still raises a
  notice for any other tool.
- The switch changes nothing else in the invocations of §5.2.
- Unconfirmed: the claude search arguments in the adapter's exact order (the
  real run used the same flags in another order); whether codex searches by
  default when `web_search` is not given (the adapter always states it);
  codex's `cached` and `indexed` values, which are not used.

## 6. HTTP API

All responses are JSON except the SSE stream. Errors:
`{ error: { code, message } }`. Every route except `GET /api/meta`,
`POST /api/auth/pair`, `POST /api/auth/session` and static assets needs auth.

```
GET    /api/meta                       { name, version, apiVersion, mode, tls, authRequired }
POST   /api/auth/pair                  { code, deviceName } -> sets session cookie
POST   /api/auth/session               { token }            -> sets session cookie
POST   /api/auth/logout
GET    /api/auth/devices
DELETE /api/auth/devices/:id
POST   /api/auth/pairing-codes         -> { code, expiresAt }   (from a signed-in device)
GET    /api/providers
POST   /api/providers/refresh          { id? }                  re-run detect()/listModels()
POST   /api/ask                        { prompt, targets: [{ slotId, providerId, model?, effort? }], conversationId? } -> { askId }
GET    /api/ask/:askId                 snapshot: status and accumulated text per slot
GET    /api/ask/:askId/stream?after=N  SSE
POST   /api/ask/:askId/cancel          { slotId? }
GET/PUT/DELETE /api/presets[/:id]
GET    /api/history?q=&cursor=&limit=  (paged; list rows carry no answer bodies)
GET/DELETE /api/history/:askId
GET/PUT /api/settings                  secrets are write-only: reads return { hasKey: true }
```

### 6.1 Stream protocol

- The server keeps, per ask, an append-only event log with a monotonically
  increasing `seq` (in memory, flushed to the database periodically and at
  completion). Every SSE message carries `id: <seq>`.
- A client may connect at any time and any number of clients may subscribe.
  On connect the server replays from `Last-Event-ID` or `?after=`. If that
  point is no longer available it first sends a `snapshot` event (accumulated
  text and status per slot), then continues live.
- A client disconnecting does **not** cancel anything. Only an explicit cancel
  or the timeout stops a slot.
- Slot state machine: `queued -> running -> done | error | cancelled | timeout`.
- Event types: `snapshot`, `queued`, `start`, `delta`, `reasoning`, `notice`,
  `done`, `error`, `cancelled`, `timeout` (each with `slotId`, `providerId`),
  and a final `ask_done`.
- Every stream ends with a terminal event, after which the server closes it
  and the client does not reconnect: `ask_done`, or — when the ask is already
  done and nothing remains to replay — a single `snapshot` whose status is
  `done`.
- `: ping` comment every 15 s. Headers: `Cache-Control: no-store`,
  `X-Accel-Buffering: no`. No compression on this route.
- If the server restarts, slots that were running are marked `error` with
  code `unknown` and message "server restarted".

### 6.2 Limits (all configurable, all bounded)

| Limit | Default | Hard max |
|---|---|---|
| targets per ask | 32 | 64 |
| request body (also chunked or without a length: the bytes are counted) | 1 MB | — |
| prompt | 200 KB | — |
| asks in flight | 4 | 16 |
| queued slots total | 64 | 256 |
| output per slot | 2 MB (then truncated, flagged) | — |
| history | 1000 asks or 500 MB, oldest pruned | — |
| failed auth / pairing attempts | 10 per minute per IP | — |

The UI does not impose a column limit; the target cap exists so a bug or a
leaked token cannot fan out into thousands of processes.

## 7. Auth, TLS and network safety

- **Tokens never appear in a URL or in any log.** Logs also mask
  `Authorization`, cookies and API keys.
- Browser clients (PWA, Electron remote window): `HttpOnly; SameSite=Strict`
  session cookie, plus `Secure` whenever the request is HTTPS. Non-browser
  clients and tests: `Authorization: Bearer`.
- Desktop local mode: random port, fresh token per launch; the Electron main
  process injects the `Authorization` header for `http://127.0.0.1:<port>`
  with `session.webRequest.onBeforeSendHeaders`. The token never reaches
  renderer JavaScript. The port is chosen by the system at the first launch
  and tried again at later ones (another is chosen when it is taken), so
  that the page keeps its origin and what the browser stores for it. The
  token travels from the main process to the core process in a message of
  the utility process's port: never in an environment, on a command line or
  in a file. The launch token is the only credential a local
  instance accepts: it has no paired devices, refuses to create pairing
  codes, and its settings page shows no devices section.
- Server mode first device: when no device is paired the server prints a
  one-time 8-digit pairing code (valid 5 minutes) to its log at level `warn`,
  so it is hidden only by `--log-level error`;
  `answerwall pair` prints a new one. Further devices: a signed-in device
  creates a pairing code in settings (5 minutes, single use, void after 5
  wrong attempts, constant-time comparison). Each device gets its own 256-bit
  token; the database stores only its SHA-256, a device name and last-used
  time. Devices are listed and revocable; revoking a device or logging out
  also ends that device's open event streams at once (the ask keeps
  running). Max 8 devices. The session cookie
  lives 400 days and its lifetime is renewed at most once a day on use; the
  token itself is not rotated (revoking the device is how it ends).
- An optional static token from `ANSWERWALL_TOKEN` exists for automation and
  tests.
- Every request: `Host` must be in the allowlist (loopback names plus the
  configured public origins). Every non-GET request: `Origin` must be
  same-origin and `Content-Type` must be `application/json`. A non-GET request
  without an `Origin` header is accepted only when it carries an
  `Authorization` header and no session cookie (non-browser clients). Being
  on loopback never bypasses auth.
- Only failed attempts that presented a credential count towards the failed
  auth limit (wrong pairing code, wrong or revoked token or cookie); a 401
  for a request without any credential does not.
- TLS modes (`ANSWERWALL_TLS`):
  - `cert` — `ANSWERWALL_TLS_CERT` / `ANSWERWALL_TLS_KEY` point to PEM files;
    reload automatically when the files change (certificate renewals).
  - `auto` — generate and persist a private CA and a server certificate for
    the configured hostnames/IPs on first start; the settings page offers the
    CA certificate for download with per-platform install steps. A CA that
    is expired, does not match its key or is not a CA is replaced; a CA that
    is not valid yet is kept with a warning that the system clock looks
    wrong, so a clock that runs behind never invalidates installed copies.
  - `off` — plain HTTP; allowed only on loopback unless
    `ANSWERWALL_ALLOW_INSECURE=1` is set, and then with a warning in log and UI.
- Behind a TLS-terminating reverse proxy (a first-class setup: the proxy owns
  the certificate, AnswerWall serves plain HTTP to it): set
  `ANSWERWALL_TLS=off`, `ANSWERWALL_PUBLIC_ORIGINS=https://<name>` and
  `ANSWERWALL_TRUSTED_PROXIES=<ip or CIDR list>`. Then
  - `X-Forwarded-Proto` / `X-Forwarded-For` are honoured **only** when the
    socket peer is a trusted proxy; from anyone else they are ignored;
  - a request counts as secure (and gets a `Secure` cookie) when it arrived
    over TLS or a trusted proxy says `https`;
  - with TLS off and a non-loopback bind, connections from peers that are
    neither loopback nor a trusted proxy are refused, so nobody on the LAN can
    talk to the plain-HTTP port directly. `ANSWERWALL_ALLOW_INSECURE=1` lifts
    this (with the warning above);
  - rate limiting keys on the forwarded client address when it is trusted;
  - the stream route must work through nginx-style proxies (no buffering
    header, pings), and docs include a sample proxy configuration.
- Binding: `ANSWERWALL_HOST` defaults to `127.0.0.1`. In Docker the process
  binds `0.0.0.0` and the compose file publishes on a host address chosen by
  the user (default `127.0.0.1`). `ANSWERWALL_PUBLIC_ORIGINS` (comma list)
  feeds the Host/Origin allowlist.
- CSP: `default-src 'self'; img-src 'self' data:; connect-src 'self';
  script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'; form-action 'self'`. Remote images
  in answers are never loaded; they render as links. Links get
  `rel="noopener noreferrer"` and open externally.
- Secrets (`SecretStore` interface: get/set/delete): OpenAI-compatible API
  keys, the Electron app's remote token, TLS private keys. Server: a `0600`
  file in the data dir, separate from the database, with environment
  variables as a read-only overlay (`ANSWERWALL_SECRET_<KEY>`, the key
  upper-cased with every other character replaced by `_`). Desktop: Electron `safeStorage`, injected
  from the main process. The database never holds a plaintext secret.
- An endpoint's API key supplied by the environment
  (`ANSWERWALL_SECRET_PROVIDER_<ID>_API_KEY`) is sent only to the origin
  named by `ANSWERWALL_SECRET_PROVIDER_<ID>_API_KEY_ORIGIN` (scheme, host and
  port; the path may differ). Without that variable, or for any other
  origin, the key is not sent and the provider page says why. Reason:
  anyone holding a session can create or retarget an endpoint with that id,
  and the stored-key rule in §5.2 cannot apply, because the environment
  value cannot be deleted.

## 8. Storage

`node:sqlite`, in the data dir (`ANSWERWALL_DATA_DIR`, default
`~/.answerwall`; Docker `/data`; Electron `userData`). Schema anticipates multi-turn conversations:

```
conversations 1—N turns 1—N slot_runs
slot_runs: provider_id, kind, model, effort, status, error_code, text,
           reasoning, usage_json, started_at, elapsed_ms,
           provider_session_id NULL, cwd_key NULL
```

In v1 a conversation has exactly one turn. Also: `presets`, `settings`,
`devices`, `pairing_codes`, schema version + forward-only migrations. No CLI
credential is ever stored.

One server per data dir: the runner holds an OS-level lock (an exclusive
SQLite transaction on the empty file `<dataDir>/work.lock`) from before it
fails interrupted slots and resets the work dirs until the end of its
shutdown. A second server on the same data dir refuses to start. The lock
ends with the process, even on `SIGKILL`, so it never goes stale.
`answerwall pair` does not take it.

## 9. Web UI

- Layout: CSS grid `repeat(auto-fill, minmax(<min width>, 1fr))`; user can
  switch to a fixed column count, change the minimum width, drag to reorder,
  and maximise one cell. Tablet defaults to 2 columns. Phone: one cell at a
  time with swipe/tabs and a scrollable row of status dots.
- Per cell: provider label, model (and effort) pickers, streamed Markdown
  (re-parse the accumulated text on a 50–100 ms throttle, then sanitise;
  never insert per-delta HTML), code-block copy, elapsed time and token
  usage, cancel, clear error states for queued / not logged in / quota /
  timeout / cancelled / block-streaming.
- Composer: Ctrl/Cmd+Enter sends, cancel all. Send is disabled while the
  wall's current ask still has unfinished cells, so an ask is never left
  running unseen. Presets: save, rename, delete, one-click switch; the
  default preset is chosen per device. History: list, search (prompt and
  answers), reopen, delete.
- Providers page: install and login state, billing source, login instructions
  (the exact official command to run), refresh button, agy risk notice, the
  "allow web search" switch where §5.3 has one. In the desktop app's local
  window also "Open a terminal to log in": an external terminal window
  running that command (the page names the provider kind; the command comes
  from the one table `LOGIN_COMMANDS`), never captured, and followed by no
  automatic detection.
- Settings: providers, limits, layout, TLS/CA download, devices, language;
  in the desktop app also the release check (§10), which a server never
  makes and therefore does not show.
- Pairing/sign-in page; a global 401 handler returns to it.
- PWA: manifest, icons, service worker that caches static assets only and
  never an `/api/` response; the app shell revalidates when
  `GET /api/meta` reports a different version.
- i18n: `en` and `zh-TW`, all strings through one dictionary module.

## 10. Packaging and release

- CI on every push to `main`, every pull request and on demand (a branch
  is checked through its pull request, so nothing runs twice):
  `ubuntu-latest` and `windows-latest`, lint, typecheck, unit tests,
  `smoke:mock`, e2e against mock CLIs, the server bundle started with plain
  Node, the Windows installer installed and its app tested on
  `windows-latest`, and the container image built and tested for amd64 and
  arm64 (not pushed). Every job is binding, the Windows e2e leg included.
  No real account is ever used in CI.
- One version for the whole workspace: every `package.json` carries the
  version of the root one (`scripts/check-versions.mjs`, run by `pnpm lint`),
  and a release tag must equal it, pre-release suffix included.
- The server bundle is installed with `npm ci --omit=dev` from a
  `package-lock.json` generated at packaging time and checked against
  `pnpm-lock.yaml` (versions, integrity, registry, no install scripts); see
  `docs/RELEASING.md`.
- Release on a `v*` tag: check the versions against the tag first, build
  everything, push the image only after every asset was built and CI
  passed, create the GitHub Release as a draft, upload all assets and
  `SHA256SUMS`, then publish it in the last step so the release is directly
  downloadable. A tag with a hyphen is a pre-release (no `latest` image tag,
  ignored by the desktop updater). The image tag `latest` and GitHub's
  "Latest" move only for a release higher than every other one, and
  `<major>.<minor>` only for the highest patch of its line, so a fix for an
  older line never moves them back. A tag whose release is already
  published is refused before anything is built or pushed. Only the push of
  a tag publishes: `workflow_dispatch` only builds and tests artifacts and
  pushes nothing, whichever ref it is started on, a tag included.
- Windows: Electron + electron-builder, NSIS x64, unsigned (documented,
  including Smart App Control). Auto-update checks only this repository's
  releases, asks before installing, can be turned off.
- Docker: multi-arch (amd64 + arm64) built on native runners and merged by
  digest; Debian-slim base (glibc); non-root fixed uid; `tini` as PID 1; the
  image contains **no** vendor CLI. Users install CLIs themselves into a
  volume using each vendor's official installer (documented, with an opt-in
  helper script) and log in with `docker exec -it`. The container is the
  security boundary: only `/data` and the CLI home volume are mounted (plus,
  in the own-certificate setup, the certificate directory read-only), never
  the host home directory. The image defaults to TLS `auto`, because a
  request from the Docker host to a published port arrives from the bridge
  gateway, which plain HTTP refuses (§7); the reverse-proxy setup trusts that
  gateway explicitly.

## 11. Phases

| Phase | Deliverable |
|---|---|
| P0 | Monorepo, core (runner, stream protocol, storage, auth, TLS), openai-compat adapter, CLI adapter base + mock CLIs, web UI + PWA, e2e, CI, release workflow skeleton |
| P1 | claude / codex adapters confirmed against the real CLIs; grok and agy adapters from documentation (mock-tested, §5.2), `pnpm smoke:real` |
| P2 | Docker image + compose, deployment docs; Electron Windows app (local + remote), first downloadable release |
| P3 | Hardening, docs (EN + zh-TW), `docs/verify-on-windows.md`, GHCR publishing |
| later | Multi-turn conversations, desktop + remote sharing |

Planned additions, not yet scheduled into a phase's contract:

- **Web cells (browser extension, off by default).** The owner asked for
  cells that show a vendor's own web app next to CLI and API cells, so the
  web apps' own features (memory, projects, search) stay available, with the
  prompt filled in automatically and the answer kept in history.
  - **Where it runs.** In the user's own Chrome or Edge, through an
    extension in `apps/extension` (Manifest V3). Not in the Electron app and
    not on phones or in the PWA; those show the stored answers only. The
    user is signed in to each vendor in that browser as usual; the extension
    has no `cookies` permission and never reads, exports or sends a session.
  - **The wall is an extension page.** The extension ships the web UI and
    opens it as its own page; that page talks to the AnswerWall server the
    user paired it with (device token as `Authorization: Bearer`, kept in
    the extension's storage; the server origin is an optional host
    permission the user grants). Vendor pages are frames directly under that
    page, mixed into the grid with the other cells. This is what makes the
    vendor's own sign-in cookies apply inside the frame without touching
    them. The first task of the implementation is to prove this in a real
    Chromium against a local stand-in site (frame-refusing headers, a
    `SameSite=Lax` session cookie); if it does not hold, stop and report
    instead of rewriting cookies.
  - **Headers.** The extension removes the response headers that refuse
    framing (`X-Frame-Options`, `Content-Security-Policy`) only for
    sub-frame requests to the listed vendor hosts that the extension's own
    page started. No other request, tab or site is changed. It never changes
    the user agent or any other request header.
  - **Send.** A content script, active only in a vendor frame whose parent
    is the extension's wall page, types the prompt into the page and submits
    it. When the answer has finished it reads the text of the last answer
    and the wall page submits it to the server.
  - **History.** The protocol gains a `web` provider kind. The server does
    not execute a web slot: it records it as running, and the paired client
    submits the result (text, or failed/cancelled) once, within the slot
    timeout and the answer size limit. The text is stored and rendered like
    any other answer (same sanitising). Other devices see it in history.
  - **Site rules.** Input, submit, answer and "finished" detection are data
    files, one per site, so a site change is a rule update. When a rule
    fails the cell stays usable by hand and that answer is not stored.
    First sites: claude.ai, chatgpt.com, gemini.google.com, grok.com,
    chat.z.ai. Rules for real sites cannot be tested in CI; they are marked
    unverified until checked by hand, and CI tests the mechanism against the
    stand-in site.
  - **Opt-in and terms.** Filling in the prompt and reading the answer are
    two separate switches, both off by default. Vendor terms restrict
    automated access to their web apps more explicitly than CLI use; the
    README says so plainly and claims nothing about what is allowed.
  - **Distribution.** A zip in the GitHub Release, loaded unpacked. No
    store listing for now.

- **opencode provider.** Built; its contract is in §5 and §5.2. The plan
  said that AnswerWall does not write opencode's configuration or
  credentials. That holds for everything opencode owns. The one file the
  adapter writes is a project configuration in its own per-request work dir,
  which only defines the tool-less agent (§5.2).

## 12. Testing

- `tools/mock-clis`: one fake executable per CLI kind that replays fixtures
  and can simulate slow streaming, hang with stdin open, init-then-hang,
  logged out, quota exhausted, non-zero exit, garbage output, block (non
  token) streaming. On Windows the mocks exist in the `.cmd` and `.ps1`
  shim forms npm writes; the resolution of a native `.exe` is covered by
  the resolver's unit tests.
- Unit: parsers, SSE, queueing/concurrency, cancel/timeout, auth middleware,
  host/origin checks, settings, storage migrations, TLS mode selection.
- e2e (Playwright; desktop, tablet, phone viewports): ask with 12 mock slots,
  queueing visible, cancel, reconnect mid-stream, presets, history, pairing,
  hostile Markdown (`<img src=http://…>`, `<script>`, `javascript:` links)
  causes no outbound request.
- `pnpm smoke:mock`: builds everything and drives the compiled server end to
  end against the mock CLIs and a local OpenAI-compatible stub (pairing, a
  queued 16-slot ask, resume, cancel, history, presets, settings, static UI
  headers, shutdown with no process left behind, restart). No real CLI and
  no network beyond loopback; safe for CI. Interrupted (SIGINT, SIGTERM,
  SIGHUP), it stops the server and every mock CLI and removes its temporary
  directory; killed outright, its server shuts down when the IPC channel
  closes.
- `pnpm smoke:real` (`scripts/smoke-real.mjs`): manual only. It is never run
  by CI or by another script (a unit test fails when a workflow or another
  package script mentions it), refuses to run when `CI` is set, and sends
  nothing without `--yes` or a typed confirmation. It first prints which
  CLIs it will call and that each call uses the owner's subscription. Then,
  for each installed and logged-in CLI, it sends one tiny prompt through the
  compiled adapter (the server's argv builder, child environment and
  parser), one CLI after the other, no retries. It asserts an answer and a
  terminal event; for claude that the init event lists no tools, MCP
  servers, skills or commands and only built-in plugins; for codex that the
  turn completed without any tool item. `--only <kind>` calls one CLI,
  `--search` uses the §5.3 variant and also asserts that a search happened.
  agy, and a CLI whose login state is unknown, are called only when named
  with `--only`.
