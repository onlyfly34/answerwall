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
4. A CLI runs only because the user pressed Send (or pressed Refresh on the
   provider page). No schedules, no polling, no background automation, no
   automatic retries, no account rotation.
5. Single user. No multi-user accounts. Server mode refuses to start without
   authentication. Device pairing is capped and revocable.
6. No telemetry, no analytics, no third-party network calls. Allowed network
   peers: the CLIs the user enabled, the OpenAI-compatible endpoints the user
   configured, and (optional, off-switch in settings) the GitHub release check.
   No Web Push (it needs a vendor push service).
7. The README must **not** claim that using a subscription through this tool
   is "compliant" or "allowed". It quotes the vendors' own wording, links the
   source, and states the residual risk. Product name, icon and UI never use a
   vendor's name or logo as branding; plain-text provider labels are fine
   ("Claude", "Codex", "Gemini (agy)", "Grok").
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
type ProviderKind = 'claude' | 'codex' | 'agy' | 'grok' | 'openai-compat';
interface ProviderInstance {
  id: string;            // stable; CLI kinds use the kind as id, openai-compat uses a slug
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  concurrency: number;   // CLI kinds: 1..5 (default 2, agy fixed at 1); openai-compat: 1..32 (default 4)
  models: string[];      // user-editable list; merged with listModels() when available
  defaultModel?: string;
  // openai-compat only: baseUrl, hasApiKey (the key itself lives in SecretStore)
}
```

Each CLI kind has exactly one instance, which can be disabled but not removed;
only openai-compat instances are added and removed.

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
    `CLAUDE_PID` and every `CLAUDE_CODE_*`, except `CLAUDE_CODE_OAUTH_TOKEN`
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
  Exception: codex with `CODEX_API_KEY` kept reports billing `unknown` with a
  hint, because `codex exec` is documented to use that key for a run; P1
  settles which one wins. Also set `NO_COLOR=1`, `TERM=dumb`.
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
- Parse line-delimited JSON defensively: unknown event types are ignored, an
  unparsable stream falls back to showing the raw text rather than an empty
  cell. Do not assume the first line is the init event.
- A provider that only emits whole messages reports `streaming: 'block'`; the
  UI shows "generating (this provider does not stream token by token)".

### 5.2 Starting-point invocations

These come from `--help` output and official docs. They have **not** all been
confirmed with real prompts. Phase P1 confirms each one, records fixtures from
real runs, and updates this section.

- **claude** — `claude -p --output-format stream-json --verbose
  --include-partial-messages --tools "" --strict-mcp-config --safe-mode
  --disable-slash-commands --no-session-persistence --permission-prompts none
  --model <m> --effort <e>`, prompt on stdin; env `ENABLE_CLAUDEAI_MCP_SERVERS=false`.
  Never `--bare` (it ignores subscription login). Not `--permission-mode plan`.
  Consider `--system-prompt` with a short Q&A prompt. Text deltas:
  `type=="stream_event"` with `event.delta.type=="text_delta"`. Errors: the
  `system`/`api_retry` event's `error` field and the final `result` line.
  Login: `claude auth status` (JSON; exit 0 logged in, 1 not). No model
  listing command: models come from settings (`fable`, `opus`, `sonnet`,
  `haiku`, or a full id). P1 must check that the init event reports no tools,
  no MCP servers, no plugins.
- **codex** — `codex exec --json --color never --skip-git-repo-check
  --ephemeral --ignore-user-config --ignore-rules -s read-only -C <workDir>
  -m <model> -c model_reasoning_effort="<e>"` plus `--disable <feature>` for
  `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`,
  `image_generation`, `browser_use`, `computer_use`, `sleep_tool`,
  `view_image`, then a final `-`; prompt on stdin. These do not remove every
  tool: `--disable multi_agent` is a no-op for the default model family, and
  depending on the model family the model is still offered exec, wait,
  request_user_input and the collaboration tools. `--ignore-user-config`
  covers `config.toml` only, so the global `AGENTS.md` and skills still load;
  the provider page says so in codex's detection hint. A feature name the
  installed codex does not know makes it exit 1 ("Unknown feature flag"); the
  adapter reports that as `unsupported`. Use
  `codex debug prompt-input <flags> "hi"` (renders locally, costs nothing) to
  confirm what each flag removes. Login: `codex login status` (message is on
  **stderr**). Models: `codex debug models` (JSON; keep `visibility=="list"`).
  Documented JSONL events are item-level, so codex is probably
  `streaming: 'block'`; confirm in P1.
- **agy** (Gemini) — `agy -p "" --input-format stream-json --output-format
  stream-json --print-timeout <n>s --disable-slash-commands --model <slug>
  --effort <e>`, the prompt as one `{"event":"user","message":{"content":…}}`
  line on stdin, which is then closed; env `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
  `--disable-slash-commands` and the environment variable come from research
  notes, not from `agy --help`, and are unconfirmed. Documented `--mode`
  values are `accept-edits`, `auto`, `plan`. Since v1.5.7 an unset
  `agentMode` makes `agy -p` run in `auto` where available; P1 tries
  `--mode default` and confirms with `agy --help` after install. No documented flag disables tools; `--sandbox`
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
  renderer JavaScript. The launch token is the only credential a local
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
  (the exact official command to run), refresh button, agy risk notice.
- Settings: providers, limits, layout, TLS/CA download, devices, language.
- Pairing/sign-in page; a global 401 handler returns to it.
- PWA: manifest, icons, service worker that caches static assets only and
  never an `/api/` response; the app shell revalidates when
  `GET /api/meta` reports a different version.
- i18n: `en` and `zh-TW`, all strings through one dictionary module.

## 10. Packaging and release

- CI on every push to `main`, every pull request and on demand (a branch
  is checked through its pull request, so nothing runs twice):
  `ubuntu-latest` and `windows-latest`, lint, typecheck, unit tests,
  `smoke:mock`, e2e against mock CLIs. The Windows e2e leg does not fail the
  workflow until it has proven stable. No real account is ever used in CI.
- The server bundle is installed with `npm ci --omit=dev` from a
  `package-lock.json` generated at packaging time and checked against
  `pnpm-lock.yaml` (versions, integrity, registry, no install scripts); see
  `docs/RELEASING.md`.
- Release on a `v*` tag: build everything, create the GitHub Release as a
  draft, upload all assets, then publish it in the last step so the release is
  directly downloadable. `workflow_dispatch` only builds artifacts.
- Windows: Electron + electron-builder, NSIS x64, unsigned (documented,
  including Smart App Control). Auto-update checks only this repository's
  releases, asks before installing, can be turned off.
- Docker: multi-arch (amd64 + arm64) built on native runners and merged by
  digest; Debian-slim base (glibc); non-root fixed uid; `tini` as PID 1; the
  image contains **no** vendor CLI. Users install CLIs themselves into a
  volume using each vendor's official installer (documented, with an opt-in
  helper script) and log in with `docker exec -it`. The container is the
  security boundary: only `/data` and the CLI home volume are mounted, never
  the host home directory.

## 11. Phases

| Phase | Deliverable |
|---|---|
| P0 | Monorepo, core (runner, stream protocol, storage, auth, TLS), openai-compat adapter, CLI adapter base + mock CLIs, web UI + PWA, e2e, CI, release workflow skeleton |
| P1 | claude / codex / grok adapters confirmed against the real CLIs, agy adapter (mock-tested), `pnpm smoke:real` |
| P2 | Docker image + compose, deployment docs; Electron Windows app (local + remote), first downloadable release |
| P3 | Hardening, docs (EN + zh-TW), `docs/verify-on-windows.md`, GHCR publishing |
| later | Multi-turn conversations, desktop + remote sharing |

Planned additions, not yet scheduled into a phase's contract:

- **Web search switch (P1).** With all tools off, answers to questions about
  recent events are worse than the vendors' web apps. P1 checks, per CLI,
  whether its built-in web search can be enabled alone while every other tool
  stays off. Where that is confirmed, each CLI provider instance gets an
  "allow web search" switch; where it is not, the provider page says so.
- **Web cells (not planned for v1).** Embedding the vendors' web apps next to
  CLI cells is only possible in the desktop app, breaks whenever a site
  changes, and Google refuses sign-in inside embedded browsers. Browser
  extensions that run inside the user's real browser already do this well.
  If it is ever built: desktop only, the app types the prompt into the page
  and never reads the answer back, and it never disguises its browser
  identity.

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
  queued 14-slot ask, resume, cancel, history, presets, settings, static UI
  headers, shutdown with no process left behind, restart). No real CLI and
  no network beyond loopback; safe for CI. Interrupted (SIGINT, SIGTERM,
  SIGHUP), it stops the server and every mock CLI and removes its temporary
  directory; killed outright, its server shuts down when the IPC channel
  closes.
- `pnpm smoke:real`: manual only, never in CI; one tiny prompt per installed
  and logged-in CLI; asserts an answer and, for claude, an empty tool list.
