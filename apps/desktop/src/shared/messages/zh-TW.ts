import type { en } from './en.ts';

export const zhTW: Record<keyof typeof en, string> = {
  'connection.title': '連線',
  'connection.intro': '選擇回答的來源。之後可以在選單中變更。',
  'connection.local.title': '這台電腦',
  'connection.local.help': '使用這台電腦上安裝的 AI 命令列工具。其他裝置無法連進來。',
  'connection.remote.title': '伺服器',
  'connection.remote.help':
    '顯示你在別處執行的 {name} 伺服器的網頁介面。在開啟的頁面上把這個應用程式配對成一台裝置。',
  'connection.remote.url': '伺服器位址',
  'connection.remote.check': '檢查',
  'connection.remote.checking': '檢查中…',
  'connection.remote.found': '找到 {name} {version}（協定版本 {apiVersion}）。',
  'connection.remote.apiMismatch':
    '伺服器使用協定版本 {server}，這個應用程式是為版本 {app} 建置的。視窗顯示的是伺服器自己的介面，所以仍可使用。請更新較舊的一方。',
  'connection.remote.versionMismatch':
    '伺服器是版本 {server}，這個應用程式是版本 {app}。視窗顯示的是伺服器自己的介面。',
  'connection.remote.insecure':
    '這個位址使用未加密的 HTTP：所有內容（包含登入）都以明文經過網路。只允許用於這台電腦和私人網路位址。',
  'connection.remote.certificateHelp':
    '憑證錯誤一律不會略過。使用私人憑證授權單位的伺服器，需先在 Windows 安裝其 CA 憑證（受信任的根憑證授權單位）。',
  'connection.continue': '繼續',
  'connection.working': '連線中…',
  'connection.problem.saved': '儲存的連線無法使用。',
  'connection.updateCheck': '應用程式啟動時檢查更新',
  'connection.updateCheck.help':
    '只讀取本專案在 GitHub 上的發行版本。未經詢問不會下載或安裝任何東西。',
  'connection.updateCheck.unsupported': '這個版本無法自行更新。',
  'connection.version': '版本 {version}',

  'problem.url.empty': '請輸入伺服器的位址。',
  'problem.url.invalid': '這不是有效的位址。範例：https://wall.example.com',
  'problem.url.scheme': '位址必須以 https:// 或 http:// 開頭。',
  'problem.url.credentials': '位址不可包含使用者名稱或密碼。',
  'problem.url.path':
    '只輸入伺服器的來源，不含路徑：https://wall.example.com 或 https://wall.example.com:7717',
  'problem.url.insecure_public':
    '未加密的 HTTP 只允許用於這台電腦和私人網路位址。這台伺服器請使用 https://。',
  'problem.url.insecure_proxy':
    '未加密的 HTTP 只允許直接連到這台電腦或私人網路位址，而這個位址會經由 Proxy 連線。這台伺服器請使用 https://，或將這個位址排除在 Proxy 之外。',
  'problem.url.unresolved':
    '無法解析這個名稱，因此無法判斷對它使用未加密的 HTTP 是否安全。請檢查名稱，或改用 https://。',
  'problem.unreachable': '伺服器沒有回應。請檢查位址，並確認伺服器正在執行。',
  'problem.certificate':
    '這台電腦不信任伺服器的憑證。憑證錯誤一律不會略過：請在 Windows 安裝伺服器的 CA 憑證（受信任的根憑證授權單位），然後再試一次。',
  'problem.timeout': '伺服器回應逾時。',
  'problem.not_a_server': '這個位址有回應，但不是執行 {name} 的伺服器。',
  'problem.desktop_instance':
    '這個位址屬於某個 {name} 桌面應用程式。它只服務自己的視窗，請改為連線到伺服器。',
  'problem.local_failed': '無法啟動本機伺服器。詳細資訊在記錄資料夾（說明選單）。',

  'menu.file': '檔案',
  'menu.connection': '連線…',
  'menu.checkUpdates': '檢查更新…',
  'menu.quit': '結束',
  'menu.edit': '編輯',
  'menu.undo': '復原',
  'menu.redo': '重做',
  'menu.cut': '剪下',
  'menu.copy': '複製',
  'menu.paste': '貼上',
  'menu.selectAll': '全選',
  'menu.view': '檢視',
  'menu.reload': '重新載入',
  'menu.zoomIn': '放大',
  'menu.zoomOut': '縮小',
  'menu.resetZoom': '實際大小',
  'menu.fullscreen': '切換全螢幕',
  'menu.devTools': '開發人員工具',
  'menu.help': '說明',
  'menu.about': '關於 {name}',
  'menu.licences': '授權條款',
  'menu.openLogs': '開啟記錄資料夾',

  'button.ok': '確定',
  'button.later': '稍後',
  'button.quit': '結束',

  'about.detail':
    '版本 {version}\nElectron {electron}、Chromium {chrome}、Node.js {node}\n\nMIT 授權。隨附軟體的授權條款在「說明 > 授權條款」。\n{repository}',

  'update.none': '目前已是最新版本。',
  'update.none.detail': '版本 {version}',
  'update.available': '有新版本 {version}。',
  'update.available.detail':
    '目前是版本 {current}。要現在下載嗎？安裝前會再詢問一次。\n\n安裝程式沒有程式碼簽章。下載的檔案會與 GitHub 發行頁面公布的檢查碼比對。',
  'update.download': '下載',
  'update.downloaded': '版本 {version} 已下載完成。',
  'update.downloaded.detail':
    '要現在安裝嗎？應用程式會關閉，仍在執行的回答會停止，然後啟動安裝程式。',
  'update.install': '安裝並重新啟動',
  'update.failed': '檢查更新失敗。',
  'update.installFailed': '無法安裝更新。',
  'update.installFailed.detail':
    '安裝程式沒有啟動，應用程式會繼續以目前的版本執行。先前執行中的回答已停止。可以從「檔案 > 檢查更新」再試一次。',
  'update.unsupported': '這個版本無法自行更新。',
  'update.unsupported.detail': '更新由發行版本的 Windows 安裝程式安裝。',
  'update.disabled.detail': '更新已由 {variable} 關閉。',

  'core.crashed': '本機伺服器意外停止。',
  'core.crashed.detail': '執行中的回答已遺失。詳細資訊在記錄資料夾（說明選單）。',
  'core.restart': '重新啟動',
  'window.crashed': '視窗已停止運作。',
  'window.reload': '重新載入',
  'fatal.title': '{name} 必須關閉',
  'fatal.detail': '發生未預期的錯誤。詳細資訊在記錄資料夾：\n{logs}',
  'title.insecure': '未加密',
  'terminal.title': '{name}：登入',
};
