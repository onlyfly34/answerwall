// The wall page of the test extension: a top-level extension page that frames
// the stand-in vendor site. The test drives it through `window.wall`.
//
// URL parameters:
//   vendor  origin of the stand-in site (required)
//   rule    how the header rule is scoped: `tab` (default), `initiator` or `none`
//   path    path and query of the framed page (default `/`)

const params = new URLSearchParams(location.search);
const vendor = new URL(params.get('vendor'));
const ruleScope = params.get('rule') ?? 'tab';
const framePath = params.get('path') ?? '/';

const REMOVE_FRAME_REFUSAL = {
  type: 'modifyHeaders',
  responseHeaders: [
    { header: 'x-frame-options', operation: 'remove' },
    { header: 'content-security-policy', operation: 'remove' },
  ],
};

/** Ports of the content scripts in this tab's frames, by frame id. */
const ports = new Map();
const waiters = new Set();
let ownTabId;

chrome.runtime.onConnect.addListener((port) => {
  // Only a content script in a frame of this very tab is a cell of this wall.
  if (port.name !== 'web-cell' || port.sender?.tab?.id !== ownTabId) return;
  const frameId = port.sender.frameId;
  ports.set(frameId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(frameId) === port) ports.delete(frameId);
  });
  for (const waiter of [...waiters]) waiter();
});

function cellPort() {
  return new Promise((resolve) => {
    const check = () => {
      const [port] = ports.values();
      if (!port) return;
      waiters.delete(check);
      resolve(port);
    };
    waiters.add(check);
    check();
  });
}

function request(port, message) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const listener = (reply) => {
      if (reply.id !== id) return;
      port.onMessage.removeListener(listener);
      resolve(reply);
    };
    port.onMessage.addListener(listener);
    port.postMessage({ ...message, id });
  });
}

async function installRule(tabId) {
  if (ruleScope === 'none') return;
  const condition =
    ruleScope === 'initiator'
      ? { initiatorDomains: [chrome.runtime.id] }
      : // Session rules can name tabs: every sub-frame request of this tab,
        // whoever started it, and of no other tab.
        { tabIds: [tabId] };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: REMOVE_FRAME_REFUSAL,
        condition: {
          ...condition,
          requestDomains: [vendor.hostname],
          resourceTypes: ['sub_frame'],
        },
      },
    ],
  });
}

async function readEvents(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const events = [];
  let chunks = 0;
  let buffered = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    buffered += value;
    let end;
    while ((end = buffered.indexOf('\n\n')) !== -1) {
      const message = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = message
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (data !== '') events.push(JSON.parse(data));
    }
  }
  return { chunks, events };
}

window.wall = {
  ready: (async () => {
    const tab = await chrome.tabs.getCurrent();
    ownTabId = tab.id;
    await installRule(tab.id);
    const frame = document.createElement('iframe');
    frame.id = 'cell';
    frame.title = 'Vendor';
    frame.width = '600';
    frame.height = '400';
    frame.src = new URL(framePath, vendor).href;
    document.getElementById('cells').append(frame);
    document.getElementById('status').textContent = 'ready';
    return { tabId: tab.id, extensionId: chrome.runtime.id };
  })(),

  /** Fills in the prompt, submits it and resolves with the finished answer. */
  async ask(prompt) {
    return request(await cellPort(), { type: 'ask', prompt });
  },

  /** How many frames of this tab have an active content script. */
  activeFrames: () => ports.size,

  sessionRules: () => chrome.declarativeNetRequest.getSessionRules(),

  /** A JSON request from the extension page to a server on another origin, with a bearer token. */
  async api(base, token, method, path, body) {
    const response = await fetch(new URL(path, base), {
      method,
      credentials: 'omit',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const parse = () => {
      try {
        return text === '' ? null : JSON.parse(text);
      } catch {
        return null;
      }
    };
    const json = parse();
    return {
      status: response.status,
      json,
      allowOrigin: response.headers.get('access-control-allow-origin'),
    };
  },

  /**
   * Reads an event stream with `fetch` (an `EventSource` cannot send the
   * `Authorization` header) and resolves with its events once it has ended.
   */
  async stream(base, token, path) {
    const response = await fetch(new URL(path, base), {
      credentials: 'omit',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    if (!response.ok) return { status: response.status, chunks: 0, events: [] };
    return { status: response.status, ...(await readEvents(response)) };
  },
};
