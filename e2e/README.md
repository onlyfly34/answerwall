# End-to-end tests

Not built yet. This package will hold the Playwright tests. They start the
real server with the mock CLIs from `tools/mock-clis` on its `PATH` and drive
the built web UI in desktop, tablet and phone viewports. No real account is
ever used.

Intended coverage:

- an ask with 12 mock slots, with queueing visible;
- cancelling one slot and cancelling all;
- reconnecting in the middle of a stream;
- presets and history;
- pairing a device and signing in;
- hostile Markdown in an answer (`<img src=http://…>`, `<script>`,
  `javascript:` links) causing no outbound request.
