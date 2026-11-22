/**
 * The strings of the extension's own screens: the first-run page and the
 * strip under the wall. Everything else on the wall page is the web UI with
 * its own dictionary. English and Traditional Chinese carry the same keys.
 */
import { BRAND } from '@answerwall/core/protocol';

const en = {
  'setup.title': `Connect to your ${BRAND.name} server`,
  'setup.intro': `This page becomes your wall: the cells of your server, and web cells that show a site's own web app in a frame. The extension talks only to the server you enter here, and frames only the listed sites.`,
  'setup.allow.title': '1. Allow this extension on the server',
  'setup.allow.body':
    'On a device that is already signed in, open Settings > Web cells, switch web cells on, choose the sites, and add this extension ID:',
  'setup.allow.id': 'Extension ID',
  'setup.allow.copy': 'Copy',
  'setup.allow.copied': 'Copied',
  'setup.server.title': '2. Server address',
  'setup.server.label': 'Server address',
  'setup.server.help':
    'For example https://wall.example.com or http://127.0.0.1:7717. The browser asks you to let the extension reach this one address; nothing else is requested.',
  'setup.code.title': '3. Pairing code',
  'setup.code.label': 'Pairing code',
  'setup.code.help': `Create one under Settings > Devices on the server, or run "${BRAND.cliName} pair" on it.`,
  'setup.device.label': 'Device name',
  'setup.device.help': 'How this extension appears in the list of devices on the server.',
  'setup.device.default': 'Browser extension',
  'setup.submit': 'Connect',
  'setup.submitting': 'Connecting…',
  'setup.terms':
    'The terms of the sites restrict automated access to their web apps. Filling in the prompt and reading the answer are two separate switches on the server, both off by default; whether to switch them on is your decision. Nothing here is a statement about what those terms permit.',
  'setup.error.address': 'Enter an address that starts with http:// or https://.',
  'setup.error.fields': 'Enter the pairing code and a device name.',
  'setup.error.permission':
    'The browser did not give the extension access to this address. Press Connect again and allow it.',
  'setup.error.unreachable':
    'Nothing answered at this address. Check the address, the scheme (http or https) and, with a private certificate authority, that this browser trusts it.',
  'setup.error.not_a_server': `What answered at this address is not an ${BRAND.name} server.`,
  'setup.error.version': `The server speaks another protocol version than this extension. Use the extension from the same release as the server.`,
  'setup.error.not_allowed':
    'The server refuses this extension. Switch web cells on under Settings > Web cells and add the extension ID shown above.',
  'setup.error.code': 'The pairing code is wrong, already used or expired.',
  'setup.error.rate_limited': 'Too many attempts. Wait a minute and try again.',
  'setup.error.failed': 'Pairing failed.',
  'setup.error.tab': 'Open this page in a browser tab of its own.',
  'strip.server': 'Server: {origin}',
  'strip.change': 'Change server',
  'strip.confirm':
    'Disconnect from {origin}? The device token of this extension is deleted from this browser.',
  'strip.version': 'Extension {version}',
} as const;

export type ExtensionMessageKey = keyof typeof en;

const zhTW: Record<ExtensionMessageKey, string> = {
  'setup.title': `連線到你的 ${BRAND.name} 伺服器`,
  'setup.intro':
    '這個頁面會成為你的牆面：包含伺服器上的各個格子，以及在內嵌框架中顯示網站自己網頁版的網頁儲存格。擴充功能只會與你在此輸入的伺服器通訊，並且只會嵌入清單中的網站。',
  'setup.allow.title': '1. 在伺服器上允許此擴充功能',
  'setup.allow.body':
    '在已登入的裝置上開啟「設定 > 網頁儲存格」，開啟網頁儲存格、選擇網站，並加入這個擴充功能 ID：',
  'setup.allow.id': '擴充功能 ID',
  'setup.allow.copy': '複製',
  'setup.allow.copied': '已複製',
  'setup.server.title': '2. 伺服器位址',
  'setup.server.label': '伺服器位址',
  'setup.server.help':
    '例如 https://wall.example.com 或 http://127.0.0.1:7717。瀏覽器會詢問是否允許擴充功能存取這一個位址；不會要求其他權限。',
  'setup.code.title': '3. 配對碼',
  'setup.code.label': '配對碼',
  'setup.code.help': `在伺服器的「設定 > 裝置」建立，或在伺服器上執行「${BRAND.cliName} pair」。`,
  'setup.device.label': '裝置名稱',
  'setup.device.help': '此擴充功能在伺服器裝置清單中顯示的名稱。',
  'setup.device.default': '瀏覽器擴充功能',
  'setup.submit': '連線',
  'setup.submitting': '連線中…',
  'setup.terms':
    '這些網站的條款限制以自動化方式存取其網頁版。「填入提示」與「讀取回答」是伺服器上兩個獨立的開關，預設皆為關閉；是否開啟由你自行決定。此處的任何內容都不是對這些條款允許什麼的陳述。',
  'setup.error.address': '請輸入以 http:// 或 https:// 開頭的位址。',
  'setup.error.fields': '請輸入配對碼與裝置名稱。',
  'setup.error.permission': '瀏覽器沒有授予擴充功能存取此位址的權限。請再按一次「連線」並允許。',
  'setup.error.unreachable':
    '此位址沒有回應。請檢查位址、通訊協定（http 或 https），若使用私有憑證授權單位，請確認此瀏覽器信任它。',
  'setup.error.not_a_server': `在此位址回應的不是 ${BRAND.name} 伺服器。`,
  'setup.error.version':
    '伺服器使用的通訊協定版本與此擴充功能不同。請使用與伺服器相同發行版的擴充功能。',
  'setup.error.not_allowed':
    '伺服器拒絕此擴充功能。請在「設定 > 網頁儲存格」開啟網頁儲存格，並加入上方顯示的擴充功能 ID。',
  'setup.error.code': '配對碼錯誤、已使用或已過期。',
  'setup.error.rate_limited': '嘗試次數過多。請稍候一分鐘再試。',
  'setup.error.failed': '配對失敗。',
  'setup.error.tab': '請在獨立的瀏覽器分頁中開啟此頁面。',
  'strip.server': '伺服器：{origin}',
  'strip.change': '更換伺服器',
  'strip.confirm': '要中斷與 {origin} 的連線嗎？此擴充功能的裝置權杖會從這個瀏覽器刪除。',
  'strip.version': '擴充功能 {version}',
};

export const EXTENSION_MESSAGES = { en, 'zh-TW': zhTW } as const;
export type ExtensionLanguage = keyof typeof EXTENSION_MESSAGES;

/** Where the web UI remembers the language; the wall page shares its origin with it. */
export const LANGUAGE_KEY = `${BRAND.slug}.language`;

/** The language the web UI last used on this page, else the browser's, else English. */
export function pickLanguage(
  stored: string | null | undefined,
  preferred: readonly string[],
): ExtensionLanguage {
  if (stored === 'en' || stored === 'zh-TW') return stored;
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return 'zh-TW';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

export type ExtensionTranslate = (
  key: ExtensionMessageKey,
  params?: Record<string, string>,
) => string;

export function translator(language: () => ExtensionLanguage): ExtensionTranslate {
  return (key, params = {}) =>
    EXTENSION_MESSAGES[language()][key].replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? (params[name] ?? whole) : whole,
    );
}
