/**
 * The wall page of the extension: a top-level extension page that hosts the
 * web UI (packages/web, not a copy of it) connected to the paired server,
 * and frames the vendors' sites as web cells. Until a server is paired it
 * shows the first-run page.
 */
import { render } from 'solid-js/web';
import { API_PATHS, BRAND } from '@answerwall/core/protocol';
import type { WebSiteId } from '@answerwall/core/protocol';
import { mountEmbedded } from '@answerwall/web/embed';
import type { WebCellSite } from '@answerwall/web/embed';
import { ruleForSite, SITE_HOSTS, TEST_SITE_ID, TEST_SITE_RULE } from '../rules/index.ts';
import { installFrameRule, removeFrameRule } from '../shared/frame-rule.ts';
import { createWebCellHost } from './host.ts';
import { LANGUAGE_KEY, pickLanguage, translator } from './messages.ts';
import {
  ensurePermission,
  forgetConnection,
  parseServerAddress,
  readConnection,
  saveConnection,
  tokenStore,
} from './pairing.ts';
import { Setup } from './Setup.tsx';
import './page.css';

const storage = chrome.storage.local;

function storedLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

const language = pickLanguage(storedLanguage(), navigator.languages);
const t = translator(() => language);

/**
 * Where each site's cell opens. In the test build, one site id is taken
 * over by the stand-in site of the automated tests, at the address the test
 * wrote into the extension's storage.
 */
async function siteTable(): Promise<(site: WebSiteId) => WebCellSite | undefined> {
  let standIn: WebCellSite | undefined;
  if (__TEST_SITE__ && TEST_SITE_RULE) {
    const stored = await storage.get(['testSiteOrigin', 'testSitePath']);
    const origin = stored['testSiteOrigin'];
    const path = stored['testSitePath'];
    if (typeof origin === 'string') {
      standIn = {
        url: `${origin}${typeof path === 'string' ? path : TEST_SITE_RULE.start}`,
        verified: TEST_SITE_RULE.verified,
      };
    }
  }
  return (site) => {
    if (standIn && site === TEST_SITE_ID) return standIn;
    const rule = ruleForSite(site);
    return rule && { url: `https://${rule.host}${rule.start}`, verified: rule.verified };
  };
}

function showSetup(root: HTMLElement, notice?: string, server?: string): void {
  render(
    () => (
      <Setup
        t={t}
        extensionId={chrome.runtime.id}
        environment={{
          fetch: (input, init) => fetch(input, init),
          permissions: chrome.permissions,
        }}
        notice={notice}
        initialServer={server}
        copy={(text) => navigator.clipboard.writeText(text)}
        onPaired={(origin, token) => {
          void saveConnection(storage, origin, token).then(() => window.location.reload());
        }}
      />
    ),
    root,
  );
}

/** Signs this device out on the server (best effort), forgets the server and starts over. */
async function changeServer(origin: string): Promise<void> {
  if (!window.confirm(t('strip.confirm', { origin }))) return;
  const token = await tokenStore(storage).get();
  if (token !== undefined) {
    await fetch(`${origin}${API_PATHS.authLogout}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  await forgetConnection(storage);
  window.location.reload();
}

async function main(): Promise<void> {
  document.title = BRAND.name;
  document.documentElement.lang = language;
  const root = document.getElementById('root');
  const strip = document.getElementById('strip');
  if (!root || !strip) return;

  const { server } = await readConnection(storage);
  if (server === undefined) {
    showSetup(root);
    return;
  }
  const address = parseServerAddress(server);
  // The permission can be taken back on the browser's extensions page at any time.
  if (!address || !(await ensurePermission(chrome.permissions, address.pattern, false))) {
    showSetup(root, t('setup.error.permission'), server);
    return;
  }
  const tabId = (await chrome.tabs.getCurrent())?.id;
  if (tabId === undefined) {
    showSetup(root, t('setup.error.tab'), server);
    return;
  }

  // The header rule exists exactly while this page is shown in this tab.
  const hosts = [...SITE_HOSTS, ...(TEST_SITE_RULE ? [TEST_SITE_RULE.host] : [])];
  const install = (): Promise<void> =>
    installFrameRule(chrome.declarativeNetRequest, tabId, chrome.runtime.id, hosts);
  await install();
  window.addEventListener('pagehide', () => {
    void removeFrameRule(chrome.declarativeNetRequest, tabId).catch(() => undefined);
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void install();
  });

  const webCells = createWebCellHost({
    tabId,
    sites: await siteTable(),
    onConnect: chrome.runtime.onConnect,
    window,
  });
  mountEmbedded({ root, server: address.origin, tokens: tokenStore(storage), webCells });

  render(
    () => (
      <>
        <span>{t('strip.server', { origin: address.origin })}</span>
        <button type="button" class="app-button" onClick={() => void changeServer(address.origin)}>
          {t('strip.change')}
        </button>
        <span>{t('strip.version', { version: __APP_VERSION__ })}</span>
      </>
    ),
    strip,
  );
}

void main();
