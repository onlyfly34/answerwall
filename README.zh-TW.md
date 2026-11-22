# AnswerWall

AnswerWall 會把同一個提問同時送給多個 AI 模型，並把它們的回答並排顯示，邊產生邊呈現。它是給單一使用者用的問答比較工具：驅動的是你自己安裝、自己登入的官方命令列工具，以及你自行設定的 OpenAI 相容端點。

[English](README.md)

它不是程式開發代理，也不是聊天用戶端：一個提問、每格一個回答，沒有後續對話，也不能附加檔案。

## 功能

- **回答牆。** 由格子組成的網格。每一格有自己的供應商、模型，以及（供應商有提供時）推理強度。可以新增、複製、移除格子，拖曳重新排序，或把單一格子放大。欄數可以自動（依最小格寬能排幾欄就排幾欄）或固定。手機一次顯示一格，以分頁、左右滑動與一排狀態圓點切換。
- **回答。** 回答會邊產生邊以 Markdown 呈現，每個回答與每個程式碼區塊都有複製按鈕，並顯示耗時與供應商回報的 token 用量。回答裡的圖片一律不會載入，只會顯示成連結。
- **排隊、取消、時間上限。** 每個供應商同時執行固定數量的請求（CLI 預設 2 個），其餘格子排隊並顯示順位。可以取消單一格子或全部取消。回答超過時間上限（預設 5 分鐘）就會被停止。
- **提問在伺服器上執行。** 關掉頁面不會中止提問。在同一台或另一台裝置上重新開啟回答牆，就會接上目前的進度。
- **預設組合。** 把一組格子連同版面存成一個名稱，一鍵切換；每台裝置可以各自選擇預設的組合。
- **歷史紀錄。** 每次提問與所有回答都會保留：可以搜尋、以唯讀方式開啟、再問一次、刪除。超過 1000 次提問或 500 MiB（兩者都可調整）時，會從最舊的開始清除。
- **供應商頁面。** 每個命令列工具都會列出：是否已安裝、版本、登入狀態、計費來源、官方登入指令、它的工具還能做什麼，以及下文說明的開關。
- **多台裝置。** 最多 8 台裝置以一次性配對碼與伺服器配對，可以逐一撤銷。網頁介面在 HTTPS 下可以安裝成應用程式（PWA）。
- **語言。** 英文與繁體中文。

## 三種執行方式

Windows 應用程式與容器映像檔發布在 [Releases 頁面](https://github.com/onlyfly34/answerwall/releases)。如果那裡還沒有任何版本，請用下面的「從原始碼執行」。

### 1. 用 Docker 執行伺服器

適合一台長時間開機、從瀏覽器、手機或 Windows 應用程式連進來使用的機器。完整說明：[docs/deploy-docker.md](docs/deploy-docker.md)。

1. 用 `docker/` 裡的 compose 檔啟動容器。映像檔不含任何廠商的 CLI。

   ```
   cd docker
   cp .env.example .env
   docker compose up -d
   ```

   這會下載 `ghcr.io/onlyfly34/answerwall`。在第一個版本發布這個映像檔之前，請先在儲存庫的複本中執行 `docker compose build`。

2. 依照說明，用各廠商的官方安裝程式把你要用的 CLI 裝進 CLI 專用的 volume，再用 `docker exec -it` 逐一登入。
3. 用 `docker compose logs` 讀取一次性配對碼（尚未配對任何裝置時會印出；在容器內執行 `answerwall pair` 可以取得新的）。
4. 用瀏覽器開啟伺服器的位址，輸入配對碼，新增格子，送出。

compose 檔原本的設定只把連接埠發布在 Docker 主機的 `127.0.0.1`。要從其他裝置連線，需要 HTTPS，以及那些裝置所使用的名稱：見上述說明與 [docs/security.zh-TW.md](docs/security.zh-TW.md)。

### 2. Windows 應用程式，本機模式

所有東西都在你的電腦上執行，不對網路開放任何連接埠。應用程式內部如何運作：[docs/desktop.md](docs/desktop.md)（開發者說明，英文）。

1. 在 Windows 上安裝你要用的 CLI，並在終端機裡逐一登入（[docs/providers.zh-TW.md](docs/providers.zh-TW.md)）。
2. 從 Releases 頁面下載安裝程式並執行。安裝程式沒有簽章，見[未簽章的 Windows 版本](#未簽章的-windows-版本)。
3. 啟動 AnswerWall，在連線頁面選擇**這台電腦**，按**繼續**。開啟**供應商**頁面，按**全部重新檢查**，在**回答牆**新增格子，送出。之後可以用**檔案 > 連線…**回到連線頁面。

### 3. Windows 應用程式，連線到伺服器

應用程式的視窗顯示的是伺服器自己的介面；CLI 與歷史紀錄都在伺服器上。

1. 依照方式 1 架好伺服器，並讓它可以用 HTTPS 連線。
2. 在應用程式的連線頁面選擇**伺服器**，輸入伺服器的位址（例如 `https://wall.example.com`），按**繼續**。使用私有 CA 的伺服器，要先把它的 CA 憑證安裝到 Windows 才能連線；憑證錯誤一律不會被略過。
3. 像其他裝置一樣配對：在已登入的裝置上，於**設定 > 裝置**按**建立配對碼**（或在伺服器上執行 `answerwall pair`），然後在應用程式顯示的登入頁面輸入配對碼。

### 從原始碼執行

需要 Node 24.15 以上的 24 版，以及 pnpm 12。

```
pnpm install
pnpm build
node apps/server/dist/main.js
```

伺服器會在 `http://localhost:7717` 上聆聽，並印出配對碼。所有選項列在 [apps/server/README.md](apps/server/README.md)（英文）。

## 支援的供應商

AnswerWall 會以每個 CLI 所能做到的最嚴格問答設定來執行它。並不是每個 CLI 都能關閉自己的工具，所以請看第三欄。

| 供應商             | 輸出方式           | 由 AnswerWall 執行時，模型還能做什麼                                                                                                                                                            | 網路搜尋開關   | 是否以真實 CLI 驗證過            |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------- |
| Claude（`claude`） | 逐字串流           | 只能回答：工具、MCP 伺服器、skills 與斜線指令全部關閉。無法移除的是：CLI 會在每個提問上附加你帳號的電子郵件地址與工作目錄。                                                                     | 有，預設關閉   | 是：Linux 上的 claude 2.1.330    |
| Codex（`codex`）   | 整段輸出（不串流） | 沒有 shell、不能讀檔、沒有 skills、沒有子代理；在空目錄內的唯讀沙箱中執行。無法移除的是：CLI 自己的指示、你的全域 `AGENTS.md`，以及一個能讀取時鐘並嘗試修改檔案的腳本工具（修改會被沙箱拒絕）。 | 有，預設關閉   | 是：Linux 上的 codex-cli 0.167.0 |
| Gemini（`agy`）    | 逐字串流           | CLI 允許的一切。沒有文件記載的方式可以關閉或限制它的工具；它只是在空的工作目錄中執行。必須先接受一則說明才會啟用。                                                                              | 無             | 否：依官方文件撰寫               |
| Grok（`grok`）     | 逐字串流           | 啟動時要求空的工具清單、單一回合、不規劃、不用子代理，但這些都沒有驗證過，請當作它的工具可用。Linux 與 macOS 會加上唯讀沙箱，CLI 無法套用時會略過。Windows 沒有沙箱：不受限制。                 | 無             | 否：依官方文件撰寫               |
| OpenAI 相容端點    | 端點有串流時就串流 | 什麼都不能：AnswerWall 只送出一個帶有你提問的 chat 請求。                                                                                                                                       | 無（沒有工具） | 不是 CLI；以本機的模擬端點測試過 |

目前還沒有在 Windows 上以真實 CLI 執行過任何東西；[docs/verify-on-windows.zh-TW.md](docs/verify-on-windows.zh-TW.md) 就是為此準備的檢查清單。各供應商的細節（安裝與登入指令、計費、限制）見 [docs/providers.zh-TW.md](docs/providers.zh-TW.md)。

**網路搜尋。** 所有工具都關閉時，模型對近期事件的回答會比廠商自己的應用程式差。因此 `claude` 與 `codex` 在供應商頁面上各有一個**允許網路搜尋**開關，預設關閉。開啟後，模型可以使用該 CLI 內建的網路搜尋（在廠商的伺服器上執行）；表中的其他限制維持不變。

## 使用你的訂閱：請先讀這一段

AnswerWall 會啟動各廠商自己的、未經修改的命令列工具，以它文件記載的非互動模式執行，並使用你自己登入的帳號。它絕不讀取、複製或儲存任何 CLI 的登入資訊。**它並沒有告訴你這種用法是任何廠商所允許的，本專案的任何內容也不應被這樣解讀。** 以下是各廠商自己的說法（原文引用；中文僅為大意，一律以原文為準）：

- **Anthropic（Claude）**，[Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)：
  "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."
  同一頁也說，這並不 "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription"，並說 "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) 禁止："Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise"。
  （大意：不允許第三方開發者在自己的應用程式中提供 Claude.ai 登入，或代使用者以訂閱方案的憑證轉送請求；但不妨礙終端使用者以自己的訂閱登入未經修改的 Claude Code；方案的用量上限以一般的個人使用為前提；除使用 API 金鑰或另有明示許可外，禁止以自動化或非人工方式存取服務。）
- **OpenAI（Codex）**，[Terms of Use](https://openai.com/policies/terms-of-use/)：你不得 "Automatically or programmatically extract data or Output"。
  （大意：不得以自動化或程式化的方式擷取資料或輸出。）
- **Google（Gemini，`agy`）**，[Antigravity FAQ](https://antigravity.google/docs/faq)：
  "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
  [Antigravity terms](https://antigravity.google/terms) 把 "Using third party software, tools, or services to access the Service" 稱為 "a breach of this Agreement"，並說 "Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts."
  （大意：`agy -p` 是給直接撰寫腳本與 CI 流程用的；消費者方案不支援把 `agy` 包在第三方程式裡，也不支援自動輪替帳號。以第三方軟體存取服務屬於違約，帳號可能因此被停用或終止。）
  在你於供應商頁面讀過並接受這段文字之前，AnswerWall 不會啟用 `agy`。
- **xAI（Grok）**：我們沒有找到 xAI 針對第三方應用程式驅動 `grok` CLI 的說明；請參閱它的[文件](https://docs.x.ai/build/overview)與 xAI 的條款。

以上頁面是在 2026 年 11 月閱讀的。內容會變動，請你自己再讀一次。

**仍然存在的風險。** 每家廠商自行決定如何解讀自己的條款，而且隨時可以修改。透過本工具使用訂閱，可能導致廠商限制、停用或關閉你的帳號。除了廠商自己，沒有人能向你保證不會。

**你可以怎麼做。**

- 只給自己用。一個人一套部署。不要把伺服器、配對碼或已登入的裝置分享給別人，更不要用你的訂閱替別人送出提問。
- 只用來送出你親手輸入、親手按下送出的提問。AnswerWall 沒有排程、沒有自動重試、沒有帳號輪替，以後也不會有。
- 如果你在意這個風險，就不要對該供應商使用訂閱登入：開啟它的**使用伺服器環境變數中的 API 金鑰**、改用帶金鑰的 OpenAI 相容端點，或讓該供應商保持停用。

## 隱私

- **沒有遙測。** AnswerWall 沒有分析、沒有當機回報，也沒有自己的帳號系統。
- **儲存在你的機器上**，位於伺服器（或本機模式下 Windows 應用程式）的資料目錄：你的提問、回答、預設組合、設定、已配對裝置的名稱，以及你為 OpenAI 相容端點輸入的 API 金鑰（放在獨立的檔案，不在資料庫裡）。任何 CLI 的登入資訊都不會被讀取或儲存。
- **會離開這台機器的資料。** 你的提問會送到回答牆上每個供應商的廠商：由該廠商自己的 CLI 以你的帳號送出，或由 AnswerWall 直接送到你設定的 OpenAI 相容端點。CLI 還會自己加上一些東西。`claude` 已確認：CLI 會把已登入帳號的電子郵件地址與工作目錄的路徑，附加在它送給 Anthropic 的每個提問上，沒有任何選項可以移除。`codex` 已確認：它會送出自己的指示，以及你的全域 `AGENTS.md`（如果有的話）。
- **第三方。** AnswerWall 本身唯一可能對其他對象發出的請求，是 Windows 應用程式向 GitHub 檢查是否有新版本，可以在設定中關閉。伺服器不會發出這種請求。

逐一列出每個檔案與每個供應商的完整說明：[docs/privacy.zh-TW.md](docs/privacy.zh-TW.md)。

## 安全模型

- **單一使用者。** 沒有帳號系統。持有已配對裝置的人可以做任何事，包括讀取全部的歷史紀錄。
- **登入無法關閉**，來自同一台機器的請求也不例外。裝置以 8 位數的一次性配對碼配對一次（5 分鐘內有效、只能用一次、輸入錯誤 5 次即作廢），可以在設定中撤銷。最多 8 台裝置。
- **預設只在本機。** 伺服器綁定 `127.0.0.1`。除非你明確允許，否則會拒絕來自其他機器的純 HTTP 連線；請使用內建的 TLS（`auto` 或 `cert`）或 HTTPS 反向代理。
- **本機模式的 Windows 應用程式**在 `127.0.0.1` 的隨機連接埠上聆聽，使用每次啟動都重新產生、頁面本身拿不到的權杖。
- **CLI 才是比較大的風險。** 無法關閉工具的 CLI（`agy`；Windows 上的 `grok`）可以用你的使用者權限，在它執行的機器上採取行動。在 Docker 中，容器就是邊界：只掛載資料 volume 與 CLI 的家目錄 volume。
- **回答是不可信的內容。** Markdown 會經過清理，遠端圖片一律不載入，頁面的內容安全政策不允許連線到其他來源。

細節、反向代理的設定，以及如何回報安全漏洞：[docs/security.zh-TW.md](docs/security.zh-TW.md)。

## 未簽章的 Windows 版本

Windows 安裝程式沒有程式碼簽章，Windows 會提醒你：

- **SmartScreen** 會顯示「Windows 已保護您的電腦」。選擇**其他資訊**，再選**仍要執行**。執行前請先與同一版本的 `SHA256SUMS` 比對檔案（在 PowerShell 中執行 `Get-FileHash .\<安裝程式>.exe -Algorithm SHA256`）。
- **智慧型應用程式控制（Smart App Control）** 開啟時會封鎖未簽章的應用程式，而且無法只對單一應用程式放行。這時除非關閉智慧型應用程式控制（會影響整個系統），否則安裝程式無法在那台電腦上執行；關閉之前請先讀 [Microsoft 的常見問題](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions)。替代做法是架一台伺服器（Docker 或從原始碼執行），用瀏覽器使用。

應用程式只會檢查這個儲存庫的 Releases 是否有更新，安裝前會先詢問，而且這項檢查可以關閉。

## 文件

| 文件                                                               | 內容                                         |
| ------------------------------------------------------------------ | -------------------------------------------- |
| [docs/providers.zh-TW.md](docs/providers.zh-TW.md)                 | 各個 CLI 與 OpenAI 相容端點的詳細說明        |
| [docs/deploy-docker.md](docs/deploy-docker.md)                     | 用 Docker 執行伺服器                         |
| [docs/desktop.md](docs/desktop.md)                                 | Windows 應用程式的建置與運作（開發者，英文） |
| [docs/privacy.zh-TW.md](docs/privacy.zh-TW.md)                     | 儲存了什麼、送出了什麼、送給誰               |
| [docs/security.zh-TW.md](docs/security.zh-TW.md)                   | 登入、TLS、網路暴露範圍、CLI 的工具          |
| [docs/verify-on-windows.zh-TW.md](docs/verify-on-windows.zh-TW.md) | 在真實 Windows 電腦上試用新版本的檢查清單    |
| [apps/server/README.md](apps/server/README.md)                     | 伺服器的所有選項（英文）                     |
| [docs/DECISIONS.md](docs/DECISIONS.md)                             | 工程決策（英文）                             |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                       | 模組配置（英文）                             |
| [docs/RELEASING.md](docs/RELEASING.md)                             | 發布流程（英文）                             |

## 參與貢獻

請先讀 [docs/DECISIONS.md](docs/DECISIONS.md)：其中的硬性規則（只用官方 CLI、不碰憑證、不做自動化、單一使用者、沒有遙測）不會在 pull request 裡討價還價。[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 說明各部分該放在哪裡。提交需要簽署（`git commit -s`）。程式碼、註解與提交訊息使用英文。

```
pnpm install
pnpm dev         # 核心伺服器與網頁開發伺服器
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke:mock  # 建置後，以模擬 CLI 驅動編譯好的伺服器
pnpm e2e         # Playwright 測試（第一次先執行：pnpm --filter ./e2e browsers）
```

以上指令都不會啟動真實的 CLI。`pnpm smoke:real` 是唯一的例外，而且只能手動執行：它會透過你已登入的每個 CLI 送出一個極短的提問，使用的是你自己的訂閱，絕不會在 CI 中執行。它會先列出將要呼叫的對象，並在送出任何東西之前詢問（`--yes` 略過詢問，`--only <cli>` 只呼叫一個，`--search` 使用網路搜尋的變體）。

## 授權

[MIT](LICENSE)
