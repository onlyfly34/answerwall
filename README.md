# AnswerWall

AnswerWall sends one prompt to several AI models at once and shows their
answers side by side as they arrive. It is a question-and-answer comparison
tool for one person: it drives the official command-line tools you installed
and signed in to yourself, plus any OpenAI-compatible endpoints you configure.

[繁體中文](README.zh-TW.md)

It is not a coding agent and not a chat client: one prompt, one answer per
cell, no follow-up turns, no file attachments.

## Features

- **The wall.** A grid of cells. Each cell has a provider, a model and, where
  the provider has one, an effort level. Add, duplicate, remove, drag to
  reorder, maximise one cell. Columns are automatic (as many as fit a minimum
  width) or a fixed number. A phone shows one cell at a time, with tabs, swipe
  and a row of status dots.
- **Answers.** Rendered as Markdown while they arrive, with a copy button per
  answer and per code block, the elapsed time and the token usage the provider
  reports. Images in an answer are never loaded; they are shown as links.
- **Queue, cancel, time limit.** Each provider runs a set number of requests
  in parallel (2 by default for a CLI); further cells wait and show their
  position. Cancel one cell or all of them. An answer that takes longer than
  the time limit (5 minutes by default) is stopped.
- **Asks run on the server.** Closing the page does not stop an ask. Open the
  wall again, on the same or another device, and it catches up.
- **Presets.** Save a set of cells and its layout under a name, switch with
  one click, pick a default preset per device.
- **History.** Every ask is kept with its answers: search, open read-only,
  ask again, delete. The oldest entries are pruned beyond 1000 asks or
  500 MiB (both adjustable).
- **Providers page.** For each command-line tool: installed or not, version,
  login state, billing source, the official login command, what its tools can
  still do, and the switches described below.
- **Several devices.** Up to 8 devices pair with a server through one-time
  codes and can be revoked one by one. The web UI can be installed as an app
  (PWA) when it is served over HTTPS.
- **Web cells (optional, off by default).** A browser extension for Chrome
  and Edge shows the vendors' own web apps (Claude, ChatGPT, Gemini, Grok,
  Z.ai) as cells next to the others, in the browser where you are signed in
  to them. Two separate switches let it type your prompt into those pages and
  read the finished answer into the history. Read
  [Web cells](#web-cells-the-vendors-web-apps-in-a-browser-extension) before
  you switch anything on.
- **Languages.** English and Traditional Chinese.

## Three ways to run it

The Windows app and the container image are published on the
[Releases page](https://github.com/onlyfly34/answerwall/releases). If no
release is listed there yet, use "From source" below.

### 1. A server in Docker

For a machine that stays on and is used from browsers, phones or the Windows
app. Full guide: [docs/deploy-docker.md](docs/deploy-docker.md).

1. Start the container with the compose file in `docker/`. The image
   contains no vendor CLI.

   ```
   cd docker
   cp .env.example .env
   docker compose up -d
   ```

   This pulls `ghcr.io/onlyfly34/answerwall`. Until a release has published
   it, run `docker compose build` in a clone of the repository first.

2. Install the CLIs you want into the CLI volume with each vendor's official
   installer, and log in to each with `docker exec -it`, as the guide shows.
3. Read the one-time pairing code with `docker compose logs` (it is printed
   when no device is paired; `answerwall pair` inside the container prints a
   new one).
4. Open the server's address in a browser, enter the code, add cells, send.

As shipped, the compose file publishes the port on the Docker host's
`127.0.0.1` only. Reaching the server from other devices needs HTTPS with a
name those devices use: see the guide and
[docs/security.md](docs/security.md).

### 2. The Windows app, local

Everything runs on your PC; nothing listens on the network. How the app
works inside: [docs/desktop.md](docs/desktop.md) (developer notes).

1. Install the CLIs you want on Windows and log in to each in a terminal
   ([docs/providers.md](docs/providers.md)).
2. Download the installer from the Releases page and run it. It is not
   signed; see [Unsigned Windows build](#unsigned-windows-build).
3. Start AnswerWall, choose **This computer** on the connection page and
   press **Continue**. Open **Providers**, press **Refresh all**, add cells
   on the **Wall**, send. **File > Connection…** brings the connection page
   back later.

### 3. The Windows app, connected to a server

The app window shows the server's own UI; the CLIs and the history are on
the server.

1. Set up a server as in 1, reachable over HTTPS.
2. On the app's connection page choose **A server**, enter the server's
   address (for example `https://wall.example.com`) and press **Continue**.
   A server with a private CA works once its CA certificate is installed in
   Windows; certificate errors are never bypassed.
3. Pair the app like any other device: press **Create pairing code** in
   **Settings > Devices** on a device that is already signed in (or run
   `answerwall pair` on the server) and enter the code on the sign-in page
   the app shows.

### From source

Needs Node 24.15 or newer in the 24 line and pnpm 12.

```
pnpm install
pnpm build
node apps/server/dist/main.js
```

The server listens on `http://localhost:7717` and prints a pairing code.
Options are listed in [apps/server/README.md](apps/server/README.md).

## Supported providers

AnswerWall runs every CLI in its most restricted question-answering setup.
Not every CLI can switch its tools off, so read the third column.

| Provider                    | Output                         | What the model can still do when AnswerWall runs it                                                                                                                                                                                                                                                                                                                     | Web search switch   | Checked against the real CLI                                     |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------- |
| Claude (`claude`)           | Streams token by token         | Nothing but answer: tools, MCP servers, skills and slash commands are switched off. Not removable: the CLI attaches your account's e-mail address and the working directory to every question.                                                                                                                                                                          | Yes, off by default | Yes: claude 2.1.330 on Linux                                     |
| Codex (`codex`)             | Whole messages (no streaming)  | No shell, no file reading, no skills, no sub-agents; read-only sandbox in an empty directory. Not removable: the CLI's own instructions, your global `AGENTS.md`, and a script tool that can read the clock and attempt a file edit, which the sandbox refuses.                                                                                                         | Yes, off by default | Yes: codex-cli 0.167.0 on Linux                                  |
| Gemini (`agy`)              | Streams token by token         | Everything the CLI lets it do. No documented way to switch off or restrict its tools; it only gets an empty working directory. Off until you accept a notice.                                                                                                                                                                                                           | No                  | No: written from the documentation                               |
| Grok (`grok`)               | Streams token by token         | Asked for an empty tool list, one turn, no planning and no sub-agents, but none of that has been checked, so treat its tools as available. Linux and macOS add a read-only sandbox, which the CLI skips if it cannot apply it. On Windows there is no sandbox: unrestricted.                                                                                            | No                  | No: written from the documentation                               |
| OpenCode (`opencode`)       | Whole messages (no streaming)  | Nothing but answer: an agent AnswerWall defines for each question denies every tool, MCP server, skill and web search. Not removable: opencode attaches the working directory, the date and any `AGENTS.md` it finds, and keeps every question and answer in its own session database. Which model answers is what you configured in opencode. Off until you enable it. | No                  | Yes: opencode 2.3.2 on Linux, against a local test endpoint only |
| OpenAI-compatible endpoints | Streams when the endpoint does | Nothing: AnswerWall sends one chat request with your prompt and nothing else.                                                                                                                                                                                                                                                                                           | None (no tools)     | Not a CLI; tested against a local stub                           |

Nothing has been run on Windows with a real CLI yet;
[docs/verify-on-windows.md](docs/verify-on-windows.md) is the checklist for
that. Details per provider, including install and login commands, billing
and limits: [docs/providers.md](docs/providers.md).

**Web search.** With every tool off, answers about recent events are worse
than in the vendors' own apps. `claude` and `codex` therefore each have an
**Allow web search** switch on the Providers page, off by default. Switched
on, the model may use that CLI's built-in web search, which runs on the
vendor's servers; everything else in the table stays as it is.

## Web cells: the vendors' web apps in a browser extension

Everything above goes through a command-line tool or an API. A web cell is
different: it is the vendor's own web page, in a frame, in your own browser.
It keeps what the web apps have and the CLIs lack (memory, projects, their
own search), and it exists only on the wall page of the AnswerWall browser
extension. The server's own page, the Windows app and phones show the
answers a web cell stored, not the cell itself.

- **It is off until you switch it on**, in three steps on the server
  (**Settings > Web cells**): the master switch, the sites, and the ID of
  the extension that may connect. The extension is a zip in the release,
  loaded unpacked; it is in no store.
- **Two more switches decide what it does for you**, both off by default:
  **Fill in the prompt** (the extension types your prompt into each page and
  submits it) and **Read the answer** (it reads the finished answer from the
  page and stores it in the history). With both off a web cell is just the
  page, used by hand.
- **The terms of these sites restrict automated access to their web apps.**
  Two of the passages quoted in the next section are about exactly this:
  Anthropic's Consumer Terms on access "through automated or non-human
  means, whether through a bot, script, or otherwise", and OpenAI's Terms of
  Use on "Automatically or programmatically extract data or Output". We did
  not collect the wording of Google, xAI and Z.ai for their web apps; read
  their terms yourself. **AnswerWall does not tell you that either switch is
  permitted by any of them. Whether to switch them on is your decision, and
  the risk to your account is the one described below.**
- **What the extension does and does not do.** It frames the listed sites
  inside its own page, and for that removes two response headers
  (`X-Frame-Options`, `Content-Security-Policy`) from those frames only. It
  has no access to cookies, changes no request, never sets a user agent, and
  does nothing on a site you open in a normal tab. It talks to one server:
  yours.
- **The rules for the real sites are unverified.** Where the message box and
  the answer are on each site is written down in a data file per site, from
  the publicly visible structure of the pages. No rule has been run against
  a real site yet, and a site can change at any time. The cell says
  "Unverified rule", and when a rule fails the cell still works by hand and
  nothing is stored.
  [docs/verify-web-cells.md](docs/verify-web-cells.md) is the checklist for
  checking a site by hand.

Installing, the exact permissions and why, and what is known not to work:
[docs/providers.md](docs/providers.md#web-cells).

## Using your subscriptions: read this first

AnswerWall starts each vendor's own, unmodified command-line tool in its
documented non-interactive mode, signed in with your own account. It never
reads, copies or stores a CLI's login. **It does not tell you that this use
is permitted by any vendor, and nothing in this project should be read that
way.** What the vendors say, in their own words:

- **Anthropic (Claude)**,
  [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  "Anthropic does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, Max,
  or Ultra plan credentials on behalf of their users." The same page says
  this does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription", and that "Advertised usage
  limits for Pro, Max, and Ultra plans assume ordinary, individual usage of
  Claude Code and the Agent SDK." The
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) prohibit,
  "Except when you are accessing our Services via an Anthropic API Key or
  where we otherwise explicitly permit it, to access the Services through
  automated or non-human means, whether through a bot, script, or otherwise".
- **OpenAI (Codex)**, [Terms of Use](https://openai.com/policies/terms-of-use/):
  you may not "Automatically or programmatically extract data or Output".
- **Google (Gemini, `agy`)**, [Antigravity FAQ](https://antigravity.google/docs/faq):
  "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting
  and CI workflows. Wrapping `agy` inside third-party coding agents or
  applications, or automating account rotation, is not supported under
  consumer plans." The [Antigravity terms](https://antigravity.google/terms)
  call "Using third party software, tools, or services to access the
  Service" "a breach of this Agreement" and say "Such actions may be grounds
  for suspension or termination of your Antigravity and/or Gemini CLI
  accounts." AnswerWall keeps `agy` off until you have read and accepted
  this wording on the Providers page.
- **xAI (Grok)**: we found no statement from xAI about third-party
  applications driving the `grok` CLI; see its
  [documentation](https://docs.x.ai/build/overview) and xAI's terms.
- **OpenCode**: `opencode` is a client for many model providers, and it
  can sign in to plans of the vendors above. AnswerWall does not configure
  it. The terms that count are those of the provider you set up in
  opencode, including what they say about third-party clients, next to
  opencode's own [terms](https://opencode.ai/legal/terms-of-service). We
  quote none of them here, because which ones apply is your choice.

These pages were read in November 2026. Read them again yourself: they
change.

**Residual risk.** Each vendor decides for itself how it reads its terms, and
it can change them at any time. Using a subscription through this tool may
lead a vendor to limit, suspend or close your account. Nobody but the vendor
can tell you otherwise.

**What you can do about it.**

- Use AnswerWall for yourself only. One deployment per person. Do not share
  a server, a pairing code or a signed-in device with anyone else, and never
  put another person's questions through your subscription.
- Keep it to questions you type and send by hand. AnswerWall has no
  schedules, no automatic retries and no account rotation, and it will not
  get them.
- If the risk matters to you, do not use a subscription login for that
  provider: turn on **Use the API key from the server environment** for it,
  use an OpenAI-compatible endpoint with a key, or leave the provider
  disabled.

## Privacy

- **No telemetry.** AnswerWall has no analytics, no crash reporting and no
  account of its own.
- **Stored on your machine**, in the data directory of the server (or of the
  Windows app in local mode): your prompts, the answers, presets, settings,
  the names of paired devices, and API keys you entered for OpenAI-compatible
  endpoints (in a separate file, never in the database). No CLI login is
  ever read or stored.
- **What leaves the machine.** Your prompt goes to the vendor of each
  provider you put on the wall, sent by that vendor's own CLI under your
  account, or by AnswerWall directly to an OpenAI-compatible endpoint you
  configured. The CLIs add things of their own. Confirmed for `claude`: the
  CLI attaches the signed-in account's e-mail address and the working
  directory path to every question it sends to Anthropic, and no option
  removes that. Confirmed for `codex`: it sends its own instructions and your
  global `AGENTS.md`, if you have one. Confirmed for `opencode`: it sends the
  working directory path, the date and any `AGENTS.md` it finds, to whichever
  provider you configured in it, and keeps the question and the answer in
  its own database.
- **Web cells.** A site in a web cell is loaded by your browser as that
  site, with your sign-in to it: the site sees your visit like any other,
  and can see that its page is inside a frame. The extension sends nothing
  to the site itself; it types into the page when you allowed that. With
  **Read the answer** on, the text of the answer goes from the page to your
  AnswerWall server and is stored there. The extension stores your server's
  address and its device token in the browser, and nothing else.
- **Third parties.** The only request AnswerWall itself can make to anyone
  else is the Windows app's check for a new release on GitHub, which you can
  switch off in Settings. The server makes no such request.

The full list, per file and per provider: [docs/privacy.md](docs/privacy.md).

## Security model

- **One user.** There are no accounts. Whoever holds a paired device can do
  everything, including reading the whole history.
- **Signing in cannot be switched off**, also not for requests from the same
  machine. A device pairs once with an 8-digit one-time code (5 minutes, one
  use, void after 5 wrong attempts) and can be revoked in Settings. At most
  8 devices.
- **Local by default.** The server binds `127.0.0.1`. Plain HTTP from other
  machines is refused unless you explicitly allow it; use the built-in TLS
  (`auto` or `cert`) or an HTTPS reverse proxy.
- **The Windows app in local mode** listens on `127.0.0.1` on a random port
  with a token that is new at every start and never reaches the page.
- **The CLIs are the larger risk.** A CLI that cannot switch its tools off
  (`agy`; `grok` on Windows) can act on the machine it runs on with your
  user's rights. In Docker the container is the boundary: only the data
  volume and the CLI home volume are mounted.
- **Answers are untrusted.** Markdown is sanitised, remote images are never
  loaded, and the page's content security policy allows no connection to
  another origin.
- **The browser extension is one more device**, accepted only while web
  cells are on and only when its ID is listed. It pairs with a code like any
  device and is revoked the same way. Inside a web cell the site runs
  without its own content security policy, because the header that carries
  it is the one that refuses framing; that is a real cost of web cells.

Details, the reverse-proxy setup and how to report a vulnerability:
[docs/security.md](docs/security.md).

## Unsigned Windows build

The Windows installer is not code-signed. Windows will say so:

- **SmartScreen** shows "Windows protected your PC". Choose **More info**,
  then **Run anyway**. Compare the file with `SHA256SUMS` from the same
  release first (`Get-FileHash .\<installer>.exe -Algorithm SHA256` in
  PowerShell).
- **Smart App Control**, where it is switched on, blocks unsigned apps and
  has no exception for a single app. The installer then cannot run on that
  PC unless you turn Smart App Control off, which affects the whole system;
  read
  [Microsoft's FAQ](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)
  before you do. The alternative is a server (Docker or from source) used
  from a browser.

The app checks only this repository's releases for updates, asks before it
installs one, and the check can be switched off.

## Documentation

| Document                                               | Content                                                |
| ------------------------------------------------------ | ------------------------------------------------------ |
| [docs/providers.md](docs/providers.md)                 | Each CLI and the OpenAI-compatible endpoints in detail |
| [docs/deploy-docker.md](docs/deploy-docker.md)         | The server in Docker                                   |
| [docs/desktop.md](docs/desktop.md)                     | How the Windows app is built and works (developers)    |
| [docs/privacy.md](docs/privacy.md)                     | What is stored, what is sent and to whom               |
| [docs/security.md](docs/security.md)                   | Sign-in, TLS, network exposure, the CLIs' tools        |
| [docs/verify-on-windows.md](docs/verify-on-windows.md) | A checklist for trying a release on a real Windows PC  |
| [docs/verify-web-cells.md](docs/verify-web-cells.md)   | A checklist for checking web cells on the real sites   |
| [docs/web-cells.md](docs/web-cells.md)                 | How web cells work (developers)                        |
| [apps/server/README.md](apps/server/README.md)         | Every server option                                    |
| [docs/DECISIONS.md](docs/DECISIONS.md)                 | The engineering decisions                              |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)           | The module map                                         |
| [docs/RELEASING.md](docs/RELEASING.md)                 | How a release is made                                  |

## Contributing

Read [docs/DECISIONS.md](docs/DECISIONS.md) first: its hard rules (official
CLIs only, no credential access, no automation, one user, no telemetry) are
not open to negotiation in a pull request.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) says where things go. Commits
are signed off (`git commit -s`). Code, comments and commit messages are in
English.

```
pnpm install
pnpm dev         # core server and web dev server
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke:mock  # build, then drive the compiled server against the mock CLIs
pnpm e2e         # the Playwright suite (once: pnpm --filter ./e2e browsers)
```

None of these starts a real CLI. `pnpm smoke:real` is the manual exception:
it sends one tiny prompt through each CLI you are logged in to, using your
own subscription, and never runs in CI. It lists what it will call and asks
before it sends anything (`--yes` skips the question, `--only <cli>` limits
it to one, `--search` uses the web search variant).

## Licence

[MIT](LICENSE)
