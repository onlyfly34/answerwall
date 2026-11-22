// The web UI as a page of the test extension: the server is on another
// origin (`?server=<origin>`), and the device token lives in the extension's
// own storage, which no web page can read.
import { mountEmbedded } from '@answerwall/web/embed';

const TOKEN_KEY = 'deviceToken';

const tokens = {
  async get() {
    const stored = await chrome.storage.local.get(TOKEN_KEY);
    return stored[TOKEN_KEY];
  },
  async set(token) {
    if (token === undefined) await chrome.storage.local.remove(TOKEN_KEY);
    else await chrome.storage.local.set({ [TOKEN_KEY]: token });
  },
};

mountEmbedded({
  root: document.getElementById('root'),
  server: new URLSearchParams(location.search).get('server'),
  tokens,
});
