/**
 * The service worker. It opens the wall page when the toolbar button is
 * pressed, and removes the header rule of a tab that stopped showing a wall
 * page, and closes the extension's storage to content scripts. It holds no
 * state, makes no request and never talks to a site or to the AnswerWall
 * server.
 */
import { removeFrameRule, sweepFrameRules } from '../shared/frame-rule.ts';
import { restrictStorage } from '../shared/storage-access.ts';

// The worker starts at installation, at an update and at every start of the
// browser, and before any event reaches it: the storage is never left open
// to the content script.
void restrictStorage(chrome.storage.local);

const WALL_PAGE = 'wall.html';
const wallUrl = chrome.runtime.getURL(WALL_PAGE);

/** The tabs that show a page of this extension right now. */
async function wallTabs(tabId?: number): Promise<number[]> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    ...(tabId === undefined ? {} : { tabIds: [tabId] }),
  });
  return contexts
    .filter((context) => context.documentUrl?.startsWith(wallUrl) === true)
    .map((context) => context.tabId);
}

const showsWall = async (tabId: number): Promise<boolean> => (await wallTabs(tabId)).length > 0;

const sweep = (only?: number): void => {
  void sweepFrameRules(chrome.declarativeNetRequest, showsWall, only).catch(() => undefined);
};

chrome.action.onClicked.addListener(() => {
  void (async () => {
    const [open] = await wallTabs();
    if (open === undefined) await chrome.tabs.create({ url: wallUrl });
    else await chrome.tabs.update(open, { active: true });
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeFrameRule(chrome.declarativeNetRequest, tabId).catch(() => undefined);
});

// A wall tab that went to another address: once that page has loaded, the
// tab no longer shows a wall page and its rule goes. (The wall page also
// removes its rule itself when it is left; this is the second line.)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') sweep(tabId);
});

chrome.runtime.onStartup.addListener(() => sweep());
chrome.runtime.onInstalled.addListener(() => sweep());
