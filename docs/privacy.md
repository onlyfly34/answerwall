# Privacy

[繁體中文](privacy.zh-TW.md)

What AnswerWall stores, where, and what leaves your machine and to whom.
Short version: AnswerWall collects nothing for anyone. Your prompts go to the
vendors of the providers you put on the wall, and to nobody else.

## No telemetry

AnswerWall has no analytics, no usage statistics, no crash reporting, no
advertising, no account of its own and no server run by the project. The web
page loads nothing from another site: its content security policy allows
scripts, styles, images and connections only from the server that served it.

## What is stored, and where

Everything is in the **data directory** of the machine that runs the server:

| Deployment               | Data directory                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Server on a host         | `~/.answerwall`, or what `ANSWERWALL_DATA_DIR` says                                     |
| Server in Docker         | `/data` in the container, a volume on the host                                          |
| Windows app, local mode  | the app's own user-data folder in your Windows profile                                  |
| Windows app, remote mode | only the connection settings and the sign-in for that server; the data is on the server |

| File                | Content                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `answerwall.sqlite` | Every prompt and every answer (with reasoning text, token usage, model, timing), presets, settings, and for each paired device its name, the SHA-256 of its token and when it was last used. Not encrypted. |
| `secrets.json`      | API keys you entered for OpenAI-compatible endpoints, and the private keys of the generated certificates in TLS `auto` mode. Readable only by the account that runs the server.                             |
| `tls/`              | The generated certificates (TLS `auto` mode only).                                                                                                                                                          |
| `work/`             | One empty directory per running cell, deleted when the cell finishes. For `grok` it briefly holds the prompt in a file.                                                                                     |
| `work.lock`         | An empty lock file.                                                                                                                                                                                         |

History is kept until you delete it (**History**, **Delete**) or until it
passes the limits in **Settings > Limits** (1000 asks or 500 MiB by default),
when the oldest asks are removed. Deleting the data directory removes
everything.

**Never stored, never read:** a CLI's login. AnswerWall does not open, copy
or look at any credential or token file of any CLI. It asks the CLI's own
status command whether it is logged in, and keeps only "yes", "no" or
"unknown" and the kind of login. The e-mail address and organisation that
`claude auth status` prints are dropped before anything reaches the page,
the log or the database.

**The log** (standard output of the server) holds identifiers, counts and
states. It never holds a prompt, an answer, a token, a cookie or an API key.
The one-time pairing code for the first device is written to it.

**In your browser:** a session cookie that script cannot read, the language,
the arrangement of your wall and your default preset, and a cached copy of
the page itself (never of an answer or any other API response).

## What leaves the machine

### Through a CLI

When you press Send, AnswerWall starts the CLI of each provider on the wall
and hands it your prompt. From there on the CLI talks to its vendor, under
the account you logged in with, and the vendor's own privacy terms apply.
AnswerWall does not see or alter that traffic.

A CLI sends more than your prompt. What is known:

| CLI      | Sent in addition to your prompt                                                                                                                                                                                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | **The e-mail address of the signed-in account and the path of the working directory**, attached by the CLI to every question. Confirmed in real runs; no option removes it. The path is `<data directory>/work/<id>`, so it usually contains your operating-system user name. Also AnswerWall's short system prompt. |
| `codex`  | The CLI's own instructions and **your global `AGENTS.md`**, if you have one. Confirmed. The working directory, shell, date and time zone are not sent (that block is switched off).                                                                                                                                  |
| `agy`    | Not examined. Its tools are unrestricted, so the model can read files your user can read and may send their content to the vendor.                                                                                                                                                                                   |
| `grok`   | Not examined. Treat it like `agy`, on Windows in particular.                                                                                                                                                                                                                                                         |

On top of that, each CLI may contact its vendor for its own purposes
(sign-in, updates, diagnostics). AnswerWall switches off the self-update of
`agy` and `grok` for the runs it starts and changes nothing else about that
traffic. Look at each vendor's documentation for its own switches.

With **Allow web search** on (`claude`, `codex`), the model may send search
queries, which it words itself from your prompt, to the vendor's search.

A check on the Providers page (at server start, and when you press
**Refresh**) runs each enabled CLI's version command and, for `claude` and
`codex`, its login status command. No prompt is sent. Whether those commands
contact the vendor is up to the CLI.

### To an OpenAI-compatible endpoint

For each cell: the model name, your prompt and, if you stored one, the API
key, to the base URL you entered. For a check: a request for the model list,
with the key. Nothing goes to any other address.

### To anyone else

- **Release check.** The Windows app can ask this project's releases on
  GitHub whether a newer version exists; GitHub then sees your IP address
  and the app's version. Switch it off under **Settings > Updates > Check
  for new releases**. The server (Docker or from source) makes no such
  request.
- **Nothing else.** No fonts, no scripts, no images from elsewhere. An image
  in an answer is not loaded; it is shown as a link, and a link is opened
  only when you click it.

## Between your devices and the server

Prompts and answers travel between your browser or the Windows app and your
own server. Over plain HTTP anyone on the network path can read them, which
is why the server refuses plain HTTP from other machines unless you
explicitly allow it; see [security.md](security.md).

## Other people

AnswerWall is built for one person. Everyone who holds a paired device sees
the whole history and can send prompts under your accounts. Do not pair a
device for someone else.
