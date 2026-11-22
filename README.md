# AnswerWall

AnswerWall sends one prompt to several AI models at once and shows their
answers side by side as they stream in. It is a question-and-answer comparison
tool for a single user, driving the official command-line tools you have
installed yourself and any OpenAI-compatible endpoints you configure.

**Under construction.** Nothing here is usable yet. See
[docs/DECISIONS.md](docs/DECISIONS.md) for the engineering decisions and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map.

## Your subscriptions and the vendors' terms

AnswerWall starts each vendor's own, unmodified command-line tool in its
documented non-interactive mode, signed in with your own account. It never
reads, copies or stores a CLI's login, and it does not tell you that this use
is permitted. What the vendors say, in their own words:

- **Anthropic (Claude)**, [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  "Anthropic does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, Max,
  or Ultra plan credentials on behalf of their users." The same page says
  this does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription". The
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
  accounts." AnswerWall keeps `agy` off until you acknowledge this.
- **xAI (Grok)**: we found no statement from xAI about third-party
  applications driving the `grok` CLI; see its
  [documentation](https://docs.x.ai/build/overview) and xAI's terms.

**Residual risk.** Each vendor decides for itself how it reads its terms, and
it can change them at any time. Using a subscription through this tool may
lead a vendor to limit, suspend or close your account. If that risk matters
to you, use an API key (a per-provider switch keeps API-key variables, and
OpenAI-compatible endpoints take a key directly) or do not enable that
provider.

### What each CLI can still do

AnswerWall runs every CLI in its most restricted question-answering setup.
Not every CLI can switch its tools off:

| CLI               | Tools                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude`          | Switched off (`--tools ""`, no MCP servers, no skills, no slash commands). Not removable: the CLI attaches your account's e-mail address and the working directory to every question; AnswerWall tells the model never to repeat them.                                                                                   |
| `codex`           | Shell, file reading, web search, skills and sub-agents are switched off, and it runs in a read-only sandbox inside an empty directory. Not removable: the CLI's own instructions and your global `AGENTS.md` still reach the model, and it keeps a script tool whose only real action, a file edit, the sandbox refuses. |
| `agy`             | No documented way to restrict them: unrestricted.                                                                                                                                                                                                                                                                        |
| `grok`            | A read-only sandbox on Linux and macOS, applied on a best-effort basis (the CLI continues without it if it cannot be applied); unrestricted on Windows.                                                                                                                                                                  |
| OpenAI-compatible | None: AnswerWall sends a chat request and nothing else.                                                                                                                                                                                                                                                                  |

The `claude` and `codex` rows were checked against the real CLIs (claude
2.1.330, codex-cli 0.167.0, on Linux); the `agy` and `grok` rows come from
their documentation.

**Web search.** `claude` and `codex` each have an "allow web search" switch
on the providers page, off by default. Switched on, the model may use that
CLI's built-in web search, which runs on the vendor's servers; everything
else in the table stays as it is. `agy` and `grok` have no such switch: it
has not been confirmed that their search can be enabled on its own.

The providers page shows the same information for each provider.

## Development

Requires Node 24.15 or newer within the 24 line (see `engines` in
`package.json`; `.nvmrc` selects the newest 24) and pnpm 12.

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

`pnpm smoke:real` is a manual check against the real CLIs installed on your
machine: it sends one tiny prompt through each CLI you are logged in to,
using your own subscription, and never runs in CI. It lists what it will call
and asks before it sends anything (`--yes` skips the question, `--only <cli>`
limits it to one, `--search` uses the web search variant).

Releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
