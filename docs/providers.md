# Providers

[繁體中文](providers.zh-TW.md)

A provider is something that answers a prompt: one of four vendor
command-line tools (CLIs) that you install and sign in to yourself, or an
OpenAI-compatible HTTP endpoint that you configure. This page says, for each
one, how to get it ready, how AnswerWall runs it, what stays switched on
whether you like it or not, and who is billed.

Before you use a subscription login here, read
[Using your subscriptions](../README.md#using-your-subscriptions-read-this-first)
in the README.

## What is the same for every CLI

- **You install it and you log in.** AnswerWall contains no vendor CLI and no
  vendor SDK. It looks for the command on `PATH` (in Docker: in the CLI
  volume; in the Windows app: on your Windows `PATH`). Login happens in a
  terminal, with the vendor's own command. AnswerWall never reads, copies or
  stores a login; it learns the login state only from the CLI's own status
  command, where the CLI has one.
- **When a CLI is started.** For a check (version and login state, no
  prompt): when the server starts, and when you press **Refresh** or
  **Refresh all** on the Providers page. For an answer: when you press Send.
  Never otherwise. There is no background polling and no retry.
- **How it is started.** Directly, with a fixed argument list and without a
  shell. Your prompt is never part of the command line: it goes to the CLI's
  standard input, or into a file where the CLI cannot read standard input.
  On Windows an npm launcher (`.cmd` or `.ps1`) is not executed; AnswerWall
  reads it and starts the program it points to (`node.exe <script>` or an
  `.exe`).
- **Where it runs.** Each cell of each ask gets a new, empty directory under
  `work/` in the data directory. It is the CLI's working directory and is
  deleted when the cell finishes.
- **Its environment.** Your environment, minus: every `ANSWERWALL_*`
  variable; the variables that mark a nested coding-agent session
  (`CLAUDECODE`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `AI_AGENT`, `CLAUDE_CODE_*`
  other than the login token `CLAUDE_CODE_OAUTH_TOKEN`); and, unless you
  switch it on, the API-key variables listed under
  [Billing](#billing-subscription-login-or-api-key). `NO_COLOR=1` and
  `TERM=dumb` are added.
- **Stopping.** Cancel, the time limit (**Settings > Limits > Time limit per
  answer**, 5 minutes by default) and quitting all end the CLI and every
  process it started: on Linux and macOS a terminate signal to the process
  group, then a kill after 3 seconds; on Windows `taskkill /T /F`.
- **Parallel requests.** 1 to 5 per CLI, 2 by default (`agy`: always 1).
  Further cells wait in a queue.

The Providers page shows, per CLI: **Installed** and the version, **Logged
in**, **Billing source**, **Streaming**, **Tool access**, the hint the check
produced, the login command with a copy button, and the switches below. The
hints come from the server and are in English in both languages.

### Billing: subscription login or API key

Some environment variables make a CLI bill an API key instead of the login
you made in the terminal, without saying so. By default AnswerWall removes
them before it starts a CLI:

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`,
`ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, every
`CLAUDE_CODE_USE_*` together with
`CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `CLAUDE_CODE_SKIP_VERTEX_AUTH` and
`CLAUDE_CODE_SKIP_FOUNDRY_AUTH`, `CODEX_API_KEY`, `OPENAI_API_KEY`,
`XAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`.

Each CLI has a switch **Use the API key from the server environment**. Off
(the default): the variables are removed and the CLI uses its own login. On:
they are kept, for that CLI and for its checks. "Server environment" means
the environment of the AnswerWall process: the container's, the service's,
or, for the Windows app in local mode, the one Windows gave the app.

**Billing source** on the Providers page says what is in effect:
**Subscription login**, **API key** or **Unknown**. The hint below it names
the variables that were found and whether they were passed on. AnswerWall
never reads the value of any of these variables.

### Web search

With every tool off, a model cannot look anything up. Where a real run
confirmed that a CLI's built-in web search works while every other tool
stays off, the CLI has a switch **Allow web search**, off by default:

| CLI      | Switch | With the switch on                                                                             |
| -------- | ------ | ---------------------------------------------------------------------------------------------- |
| `claude` | Yes    | The model is offered the `WebSearch` tool and nothing else. Never `WebFetch`.                  |
| `codex`  | Yes    | The CLI's hosted web search is set to `live`. Every other restriction stays.                   |
| `agy`    | No     | The page says "Web search: not available": it has not been confirmed that it works on its own. |
| `grok`   | No     | The same.                                                                                      |

Both searches appear to run on the vendor's servers, not on your machine.
When a search happens, the cell shows a note: for `claude` with the query
("Searching the web: …"), for `codex` without ("The model searched the
web."). Your prompt, and whatever the model decides to search for, then
also reaches the vendor's search.

## Claude (`claude`)

|                   |                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Install           | <https://code.claude.com/docs/en/setup>                                                           |
| Log in            | `claude auth login`                                                                               |
| Login check       | `claude auth status --json` (only the login flag, the login method and the API provider are read) |
| Output            | Streams token by token                                                                            |
| Tool access       | Switched off                                                                                      |
| Web search switch | Yes                                                                                               |
| Checked against   | claude 2.1.330 on Linux with a subscription login. Nothing on Windows.                            |

**How AnswerWall runs it.** In print mode (`claude -p`), with the prompt on
standard input and the answer as a JSON event stream. It replaces the CLI's
coding-agent system prompt with a short one that asks for a direct answer in
the language of the question. It passes the model and, when a cell carries
one, the effort level.

**What is disabled.** All tools (`--tools ""`), MCP servers including the
connectors of your claude.ai account, skills, slash commands, your settings
files, plugins and hooks (`--safe-mode` and `--restricted` together), and
session files (`--no-session-persistence`). In a real run the CLI then
reported no tools, no MCP servers, no skills and no commands. If a CLI
version starts with anything else, the cell shows a note saying so.

**What cannot be disabled.**

- The CLI attaches **the e-mail address of the signed-in account and the
  working directory path** to every question it sends to Anthropic. No flag
  removes this. The working directory is the empty per-cell directory under
  the data directory, so the path usually contains your user name.
  AnswerWall's system prompt tells the model never to repeat either one.
- The CLI always lists the plugins it ships with and its built-in agent
  types. Without a tool they cannot be started.
- While it runs, the CLI keeps a small session marker in its own state
  directory and removes it on exit; it may also rewrite its own
  configuration file.
- AnswerWall changes nothing about the CLI's own update or diagnostic
  traffic.

**Billing.** With the switch off, the `ANTHROPIC_*` and `CLAUDE_CODE_USE_*`
variables are removed and the CLI uses the login from `claude auth login`.
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is not an API key but
the CLI's own headless subscription login; it is always passed through, and
the hint says when it is set. With the switch on, the CLI decides which
credential wins; the page shows **API key** when the CLI's status reports an
API-key or third-party method, and **Subscription login** with the hint "The
CLI still reports its own login as the one in use" when it does not (for
example with only `ANTHROPIC_BASE_URL` set).

**Models and effort.** The CLI has no command that lists models. The list
starts as `fable`, `opus`, `sonnet`, `haiku`; add or remove names, including
full model ids, under **Your models** on the Providers page. The wall offers
an effort picker only for models that come with a list of effort levels, and
models you typed in have none, so a Claude cell has no effort picker and the
CLI's default effort is used.

**Known limits.**

- No reasoning text: the CLI sends thinking as empty fragments. Only the
  reasoning token count is shown.
- Not confirmed with the real CLI: what a logged-out, rate-limited or
  over-quota run looks like (AnswerWall maps the documented error names to
  "not logged in", "quota" and "rate limited"); whether a user-level
  `CLAUDE.md` is kept out (this rests on the help text of `--safe-mode`).

## Codex (`codex`)

|                   |                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------- |
| Install           | <https://developers.openai.com/codex/cli> (npm package `@openai/codex`)                |
| Log in            | `codex login`                                                                          |
| Login check       | `codex login status` (only "logged in or not" and the kind of login are taken from it) |
| Output            | Whole messages: the answer appears at once when it is finished                         |
| Tool access       | Cannot be switched off completely; read-only sandbox in an empty directory             |
| Web search switch | Yes                                                                                    |
| Checked against   | codex-cli 0.167.0 on Linux with a ChatGPT login. Nothing on Windows.                   |

**How AnswerWall runs it.** `codex exec --json`, with the prompt on standard
input, in a read-only sandbox (`-s read-only`), with the empty per-cell
directory as its working directory, ignoring your `config.toml` and your
execpolicy rules, and without writing a session file (`--ephemeral`).

**What is disabled.** The shell and command tools, file reading, web search
(unless the switch is on), skills, apps and connectors, plugins, hooks,
sub-agents, image generation, browser and computer use, the tools that ask
the user a question, and any `AGENTS.md` in or above the working directory.
The block that tells the model its working directory, shell, date and time
zone is removed too, so the model does not know today's date.

**What cannot be disabled.**

- The CLI's own instructions to the model.
- **Your global `AGENTS.md`** (`AGENTS.md` or `AGENTS.override.md` in the
  CLI's home directory). It is sent with every question. The only way to
  avoid that would be to move the CLI's home directory, and the login lives
  there, so AnswerWall does not.
- A script tool (`exec`, with `wait`). Through it the model can read the
  clock, get empty MCP resource listings, and attempt a file edit, which the
  read-only sandbox refuses. In a real run the model, asked to read and to
  write a file, could do neither, and the working directory stayed empty.
- The CLI still updates its own log, state and model cache in its home
  directory.

The Providers page repeats this in the hint under Codex.

**Billing.** With the switch off, `CODEX_API_KEY` and `OPENAI_API_KEY` are
removed and the CLI uses the login from `codex login`. With the switch on:

- `CODEX_API_KEY` set: the CLI authenticates with that key whatever login is
  saved, so the page shows **API key**, even though `codex login status`
  still reports the ChatGPT login. (Seen with `codex doctor`; no prompt was
  sent with a key.)
- Only `OPENAI_API_KEY` set: it does not replace a ChatGPT login. The page
  shows **Subscription login** and says the CLI still reports its own login.

`CODEX_ACCESS_TOKEN` is not touched in either case; its effect was not
examined.

**Models and effort.** Models and their effort levels come from the CLI
(`codex debug models`); you can add names by hand. An effort level the
service does not accept ends the cell with an error.

**Known limits.**

- No token-by-token output and no reasoning text. The cell shows
  "Generating — this provider does not stream token by token" until the
  answer arrives.
- A codex version that no longer knows one of the switches AnswerWall passes
  refuses to start; the cell then says so and nothing is sent. Update
  AnswerWall, or use a supported CLI version.
- Not confirmed with the real CLI: the usage-limit and rate-limit failures,
  a prompt billed through `CODEX_API_KEY`, and the models that were listed
  but not run.

## Gemini (`agy`)

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Install           | <https://antigravity.google/docs/getting-started>                                |
| Log in            | Start `agy` in a terminal and sign in there; the CLI has no login subcommand     |
| Login check       | None: the CLI has no status command, so **Logged in** always shows **Unknown**   |
| Output            | Streams token by token                                                           |
| Tool access       | **Unrestricted**: no documented way to switch off or restrict its tools          |
| Web search switch | No                                                                               |
| Checked against   | Nothing. Written from the vendor's documentation and tested only against a mock. |

### The notice

`agy` is disabled on a new installation. When you tick **Enabled**,
AnswerWall first shows the vendor's own wording from its
[FAQ](https://antigravity.google/docs/faq):

> Antigravity CLI headless mode (`agy -p`) is intended for direct scripting
> and CI workflows. Wrapping `agy` inside third-party coding agents or
> applications, or automating account rotation, is not supported under
> consumer plans.

You have to tick "I have read this and accept the risk." and press **Enable
anyway**. Until then the CLI is never started, not even for a check, and a
cell that uses it fails with "This provider stays off until its notice has
been acknowledged in the settings." The vendor's
[terms](https://antigravity.google/terms) call "Using third party software,
tools, or services to access the Service" "a breach of this Agreement".
AnswerWall is such software. Decide with that in mind.

**How AnswerWall runs it.** In print mode with JSON events in both
directions; the prompt is written to standard input as one JSON line. The
CLI's own time limit is set to the cell's time limit, slash commands are
switched off so that a question starting with `/` stays a question, and the
CLI's background self-update is switched off. Parallel requests are fixed at 1.

**What is disabled.** Nothing about its tools. It gets an empty working
directory, and that is all. Treat an answer from this provider as coming
from an agent that can read and change what your user can. Where this
matters, run it only inside the Docker container.

**Billing.** With the switch off, `GEMINI_API_KEY` and `GOOGLE_API_KEY` are
removed. With it on they are kept and the page shows **API key**, but the
vendor's [authentication page](https://antigravity.google/docs/install)
says that setting `GEMINI_API_KEY` alone "has no effect" without also
choosing the Gemini provider in the CLI's own settings. AnswerWall cannot
see which one the CLI uses.

**Known limits.**

- The CLI keeps its login in the operating system's keyring, not in a
  directory. In a container there is usually no keyring, so signing in there
  needs extra work; see [deploy-docker.md](deploy-docker.md).
- Two of the things AnswerWall passes (`--disable-slash-commands` and the
  variable that stops the self-update) come from notes, not from the CLI's
  help output, and may be wrong for your version. If the CLI rejects an
  argument, the cell fails with the CLI's message.
- Since version 1.5.7 the CLI's print mode may run in its automatic mode
  where that is available. AnswerWall does not pass a mode.

## Grok (`grok`)

|                   |                                                                                  |
| ----------------- | -------------------------------------------------------------------------------- |
| Install           | <https://docs.x.ai/build/overview>                                               |
| Log in            | `grok login --device-auth`                                                       |
| Login check       | None documented, so **Logged in** always shows **Unknown**                       |
| Output            | Streams token by token                                                           |
| Tool access       | Linux and macOS: read-only sandbox, best effort. Windows: **unrestricted**.      |
| Web search switch | No                                                                               |
| Checked against   | Nothing. Written from the vendor's documentation and tested only against a mock. |

**How AnswerWall runs it.** The CLI does not read standard input, so the
prompt is written to `prompt.txt` in the per-cell directory and passed with
`--prompt-file`. The answer comes back as a JSON event stream. No effort
level is passed: the CLI documents no option for it.

**What is disabled.** AnswerWall asks for an empty tool list (`--tools ""`),
one turn (`--max-turns 1`), no planning, no sub-agents, no self-update and no
cross-session memory (`GROK_MEMORY=0`). On Linux and macOS it adds
`--sandbox read-only`.

**What cannot be relied on.** None of the above has been confirmed with the
real CLI. The sandbox is best effort: the CLI's documentation says it
continues without one when it cannot be applied, and the hint on the
Providers page says so. On Windows the CLI has no sandbox at all, and the
page shows the tool access as unrestricted. When the model does try a tool,
the cell shows a note.

**Billing.** With the switch off, `XAI_API_KEY` is removed. With it on, it
is kept, but the CLI uses the key only when it has no login session, so the
page shows **Unknown** and says so.

**Known limits.** Everything: this adapter has not met the real CLI. Expect
to find differences, and please report them.

## OpenAI-compatible endpoints

Any server that speaks the OpenAI chat completions API: a vendor's API, a
gateway, or a model server on your own machine. You can add up to 60
endpoints.

**Add one.** Providers page, **OpenAI-compatible endpoints**, **Add
endpoint**:

| Field             | Meaning                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| Name              | What the wall shows.                                                                                         |
| Identifier        | Lowercase letters, digits and dashes, at most 32. Cannot be changed later.                                   |
| Base URL          | `http://` or `https://`, with or without a trailing `/v1`. No user name, password, query string or fragment. |
| API key           | Optional. Stored on the server, never shown again.                                                           |
| Parallel requests | 1 to 32, 4 by default.                                                                                       |

Then press **Refresh** on the new card. AnswerWall requests `GET
<base>/v1/models`; **Reachable** and the model list come from the answer. If
the endpoint has no model list, add model names by hand under **Your
models**.

**What is sent.** One `POST <base>/v1/chat/completions` per cell, with
`stream: true`, the model you picked, and your prompt as a single user
message. No system prompt, no tools, no history. An effort level, when a
cell carries one, is sent as `reasoning_effort`. The API key, when there is
one, goes in the `Authorization` header. Requests go from the server (or
from the Windows app in local mode), not from your browser, and only to the
address you entered.

**The key.** It is kept in the secrets file, apart from the database, and
the API only ever reports that a key exists. A key belongs to the scheme,
host and port it was entered for: if you change the base URL to another
origin without entering a key again, the stored key is deleted.

### Example: a model server or proxy on the same machine

Anything that serves `/v1/chat/completions` works; two common ones:

| Software                     | Base URL to enter        | API key                        |
| ---------------------------- | ------------------------ | ------------------------------ |
| Ollama (default port)        | `http://127.0.0.1:11434` | none                           |
| LiteLLM proxy (default port) | `http://127.0.0.1:4000`  | the proxy's key, if it has one |

Check the port in that software's own documentation. `127.0.0.1` means the
machine AnswerWall runs on. For a server in Docker that is the container
itself, so use an address the container can reach instead (the compose
file provides `host.docker.internal` for the Docker host); see
[deploy-docker.md](deploy-docker.md).

A proxy such as LiteLLM is also the way to put a vendor API that is not
OpenAI-compatible, or several keys, behind one endpoint. That uses API
billing, not a subscription.

### A key from the environment

On a server you can supply an endpoint's key without typing it into the
page. For an endpoint with the identifier `local-proxy`:

```
ANSWERWALL_SECRET_PROVIDER_LOCAL_PROXY_API_KEY=sk-...
ANSWERWALL_SECRET_PROVIDER_LOCAL_PROXY_API_KEY_ORIGIN=http://127.0.0.1:4000
```

The name is the identifier in upper case with every other character as `_`.
The second variable is required: a key from the environment is sent only to
that origin (scheme, host and port). Without it, or when the endpoint points
somewhere else, the key is not sent and the card says why. This is so that
someone holding a signed-in device cannot point the endpoint at their own
server and collect a key they could never read.

**Known limits.** Text only. Reasoning text is shown when the endpoint sends
it as `reasoning_content` or `reasoning`. Some servers reject the option
that asks for token usage in a stream; AnswerWall then sends the same
request once more without it.
