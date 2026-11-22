# Mock CLIs

Not built yet. This package will hold one fake executable per CLI provider
kind (`claude`, `codex`, `agy`, `grok`). Each replays recorded fixtures in the
real CLI's output format so adapters and end-to-end tests never need a real
account.

Intended contents:

- `src/` — the fake executables and a shared fixture player.
- `fixtures/` — recorded output streams, one directory per kind.
- Selectable behaviours: normal answer, slow streaming, hang with stdin open,
  init-then-hang, logged out, quota exhausted, non-zero exit, garbage output,
  block (non-token) streaming.
- Launchers for both platforms; on Windows each mock exists in an
  `.exe`-style form and as a `.cmd` shim, to exercise executable resolution.

The mocks implement the status and model-listing subcommands as well, so
detection can be tested.
