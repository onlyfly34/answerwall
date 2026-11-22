# 供應商

[English](providers.md)

「供應商」是指能回答提問的對象：四個廠商命令列工具（CLI）之一，由你自己安裝、自己登入；或是你自行設定的 OpenAI 相容 HTTP 端點。本頁逐一說明：如何準備、AnswerWall 怎麼執行它、哪些東西不管你願不願意都關不掉，以及費用算在誰頭上。

在這裡使用訂閱登入之前，請先讀 README 的[使用你的訂閱](../README.zh-TW.md#使用你的訂閱請先讀這一段)。

## 所有 CLI 的共同點

- **由你安裝、由你登入。** AnswerWall 不內含任何廠商的 CLI，也不內含任何廠商的 SDK。它會在 `PATH` 上尋找指令（Docker：在 CLI 專用的 volume 裡；Windows 應用程式：在你的 Windows `PATH` 上）。登入是在終端機裡用廠商自己的指令完成的。AnswerWall 絕不讀取、複製或儲存登入資訊；它只透過 CLI 自己的狀態指令（如果有的話）得知是否已登入。
- **什麼時候會啟動 CLI。** 檢查（版本與登入狀態，不送出提問）：伺服器啟動時，以及你在供應商頁面按下**重新檢查**或**全部重新檢查**時。回答：你按下送出時。除此之外不會啟動。沒有背景輪詢，也沒有重試。
- **怎麼啟動。** 直接啟動，使用固定的參數清單，不經過 shell。你的提問絕不會出現在命令列上：它會寫入 CLI 的標準輸入；CLI 不讀標準輸入時，則寫進一個檔案。在 Windows 上，npm 的啟動檔（`.cmd` 或 `.ps1`）不會被執行；AnswerWall 會讀取它，然後直接啟動它所指向的程式（`node.exe <script>` 或某個 `.exe`）。
- **在哪裡執行。** 每次提問的每一格，都會在資料目錄的 `work/` 底下得到一個全新的空目錄，作為 CLI 的工作目錄，該格結束時就刪除。
- **環境變數。** 沿用你的環境，但會移除：所有 `ANSWERWALL_*` 變數；標示「巢狀代理工作階段」的變數（`CLAUDECODE`、`CLAUDE_EFFORT`、`CLAUDE_PID`、`AI_AGENT`，以及登入權杖 `CLAUDE_CODE_OAUTH_TOKEN` 以外的 `CLAUDE_CODE_*`）；以及（除非你開啟開關）[計費](#計費訂閱登入或-api-金鑰)一節列出的 API 金鑰變數。另外會加上 `NO_COLOR=1` 與 `TERM=dumb`。
- **停止。** 取消、時間上限（**設定 > 限制 > 每個回答的時間上限**，預設 5 分鐘）與結束程式，都會結束 CLI 以及它啟動的所有程序：Linux 與 macOS 上先對整個程序群組送出終止訊號，3 秒後強制結束；Windows 上使用 `taskkill /T /F`。
- **同時請求數。** 每個 CLI 為 1 到 5，預設 2（`agy` 固定為 1）。超過的格子會排隊。

供應商頁面會為每個 CLI 顯示：**已安裝**與版本、**登入狀態**、**計費來源**、**串流方式**、**工具權限**、檢查時產生的提示、附有複製按鈕的登入指令（本機模式的 Windows 應用程式還有**開啟終端機登入**，會開一個執行該指令的終端機視窗；應用程式看不到視窗裡發生的事），以及下面的開關。提示文字由伺服器產生，在兩種語言下都是英文。

### 計費：訂閱登入或 API 金鑰

有些環境變數會讓 CLI 不聲不響地改用 API 金鑰計費，而不是你在終端機裡完成的登入。AnswerWall 預設會在啟動 CLI 之前移除它們：

`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_PROFILE`、`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_IDENTITY_TOKEN`、`ANTHROPIC_IDENTITY_TOKEN_FILE`、所有 `CLAUDE_CODE_USE_*`（連同 `CLAUDE_CODE_SKIP_BEDROCK_AUTH`、`CLAUDE_CODE_SKIP_VERTEX_AUTH`、`CLAUDE_CODE_SKIP_FOUNDRY_AUTH`）、`CODEX_API_KEY`、`OPENAI_API_KEY`、`XAI_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`。

每個 CLI 都有一個**使用伺服器環境變數中的 API 金鑰**開關。關閉（預設）：移除這些變數，CLI 使用自己的登入。開啟：保留這些變數，對該 CLI 的執行與檢查都適用。「伺服器環境」是指 AnswerWall 程序本身的環境：容器的、服務的，或在本機模式下 Windows 交給應用程式的環境。

供應商頁面的**計費來源**會顯示實際生效的是哪一種：**訂閱登入**、**API 金鑰**或**未知**。下方的提示會列出找到了哪些變數，以及是否傳給了 CLI。AnswerWall 絕不讀取這些變數的值。

### 網路搜尋

所有工具都關閉時，模型無法查任何資料。對於經過真實執行、確認「內建網路搜尋可以在其他工具全部關閉的情況下單獨運作」的 CLI，供應商頁面提供**允許網路搜尋**開關，預設關閉：

| CLI      | 開關 | 開啟之後                                                 |
| -------- | ---- | -------------------------------------------------------- |
| `claude` | 有   | 只提供模型 `WebSearch` 這一個工具。絕不提供 `WebFetch`。 |
| `codex`  | 有   | CLI 的代管網路搜尋設為 `live`。其他限制全部維持。        |
| `agy`    | 無   | 頁面顯示「網路搜尋：無法使用」：尚未確認它能單獨運作。   |
| `grok`   | 無   | 同上。                                                   |

兩者的搜尋看起來都是在廠商的伺服器上執行，而不是在你的機器上。發生搜尋時，格子會顯示一則說明：`claude` 會附上查詢字串（"Searching the web: …"），`codex` 不會（"The model searched the web."）。這時你的提問，以及模型自己決定要搜尋的內容，也會送到廠商的搜尋服務。

## Claude（`claude`）

|              |                                                                              |
| ------------ | ---------------------------------------------------------------------------- |
| 安裝         | <https://code.claude.com/docs/en/setup>                                      |
| 登入         | `claude auth login`                                                          |
| 登入檢查     | `claude auth status --json`（只讀取是否登入、登入方式與 API 提供者三個欄位） |
| 輸出方式     | 逐字輸出                                                                     |
| 工具權限     | 關閉                                                                         |
| 網路搜尋開關 | 有                                                                           |
| 驗證情況     | Linux 上的 claude 2.1.330，使用訂閱登入。Windows 上完全沒有驗證過。          |

**AnswerWall 怎麼執行它。** 以列印模式（`claude -p`）執行，提問從標準輸入送入，回答以 JSON 事件串流傳回。它會把 CLI 原本給程式開發代理用的系統提示，換成一段簡短的提示，要求模型用提問的語言直接作答。它會傳入模型，以及格子帶有推理強度時的強度。

**關閉了什麼。** 所有工具（`--tools ""`）、MCP 伺服器（包含你 claude.ai 帳號的連接器）、skills、斜線指令、你的設定檔、外掛與 hooks（`--safe-mode` 與 `--restricted` 並用），以及工作階段檔案（`--no-session-persistence`）。在真實執行中，CLI 回報沒有工具、沒有 MCP 伺服器、沒有 skills、沒有指令。如果某個版本的 CLI 啟動時帶了其他東西，格子會顯示一則說明。

**關不掉的東西。**

- CLI 會把**已登入帳號的電子郵件地址與工作目錄的路徑**附加在它送給 Anthropic 的每個提問上，沒有任何參數可以移除。工作目錄就是資料目錄底下、每格專用的空目錄，所以路徑裡通常會有你的使用者名稱。AnswerWall 的系統提示會要求模型絕不複述這兩項。
- CLI 一律會列出它內建的外掛與內建的代理類型。沒有工具，它們就無法被啟動。
- 執行期間，CLI 會在它自己的狀態目錄裡放一個小小的工作階段標記，結束時移除；它也可能改寫自己的設定檔。
- AnswerWall 不會改變 CLI 自己的更新或診斷連線。

**計費。** 開關關閉時，`ANTHROPIC_*` 與 `CLAUDE_CODE_USE_*` 變數會被移除，CLI 使用 `claude auth login` 的登入。`CLAUDE_CODE_OAUTH_TOKEN`（來自 `claude setup-token`）不是 API 金鑰，而是 CLI 自己的無介面訂閱登入；它一律原樣傳入，設定了的話提示會說明。開關開啟時，由 CLI 決定用哪一組憑證：CLI 的狀態回報 API 金鑰或第三方方式時，頁面顯示 **API 金鑰**；否則顯示**訂閱登入**，並附上提示 "The CLI still reports its own login as the one in use"（例如只設定了 `ANTHROPIC_BASE_URL` 的情況）。

**模型與推理強度。** 這個 CLI 沒有列出模型的指令。清單一開始是 `fable`、`opus`、`sonnet`、`haiku`；可以在供應商頁面的**你的模型**新增或移除名稱，也可以填完整的模型 ID。回答牆只會對「附有推理強度清單」的模型顯示強度選單，而你手動輸入的模型沒有這份清單，所以 Claude 的格子沒有強度選單，使用的是 CLI 的預設強度。

**已知限制。**

- 沒有推理過程的文字：CLI 送出的思考片段是空的。只會顯示推理的 token 數。
- 尚未以真實 CLI 確認：未登入、被限流或額度用完時的實際輸出（AnswerWall 把文件記載的錯誤名稱對應到「未登入」「額度」「限流」）；使用者層級的 `CLAUDE.md` 是否確實被排除（這一點依據的是 `--safe-mode` 的說明文字）。

## Codex（`codex`）

|              |                                                                             |
| ------------ | --------------------------------------------------------------------------- |
| 安裝         | <https://developers.openai.com/codex/cli>（npm 套件 `@openai/codex`）       |
| 登入         | `codex login`                                                               |
| 登入檢查     | `codex login status`（只取「是否登入」與登入的種類）                        |
| 輸出方式     | 整段輸出：回答完成後一次出現                                                |
| 工具權限     | 無法完全關閉；在空目錄內的唯讀沙箱中執行                                    |
| 網路搜尋開關 | 有                                                                          |
| 驗證情況     | Linux 上的 codex-cli 0.167.0，使用 ChatGPT 登入。Windows 上完全沒有驗證過。 |

**AnswerWall 怎麼執行它。** `codex exec --json`，提問從標準輸入送入，在唯讀沙箱（`-s read-only`）中執行，以每格專用的空目錄為工作目錄，忽略你的 `config.toml` 與 execpolicy 規則，也不寫入工作階段檔案（`--ephemeral`）。

**關閉了什麼。** shell 與指令工具、讀取檔案、網路搜尋（除非開啟開關）、skills、apps 與連接器、外掛、hooks、子代理、圖片產生、瀏覽器與電腦操作、向使用者提問的工具，以及工作目錄內或其上層的任何 `AGENTS.md`。告訴模型工作目錄、shell、日期與時區的那一段也會移除，所以模型不知道今天的日期。

**關不掉的東西。**

- CLI 自己給模型的指示。
- **你的全域 `AGENTS.md`**（CLI 家目錄裡的 `AGENTS.md` 或 `AGENTS.override.md`）。它會隨每個提問送出。唯一能避免的方法是搬移 CLI 的家目錄，但登入資訊就存在那裡，所以 AnswerWall 不這麼做。
- 一個腳本工具（`exec`，以及 `wait`）。模型可以透過它讀取時鐘、取得空的 MCP 資源清單，以及嘗試修改檔案（會被唯讀沙箱拒絕）。在真實執行中，要求模型讀取並寫入檔案時，兩者它都做不到，工作目錄也維持是空的。
- CLI 仍會更新它家目錄裡自己的記錄、狀態與模型快取。

供應商頁面上 Codex 底下的提示會重述這些內容。

**計費。** 開關關閉時，`CODEX_API_KEY` 與 `OPENAI_API_KEY` 會被移除，CLI 使用 `codex login` 的登入。開關開啟時：

- 設定了 `CODEX_API_KEY`：不論儲存了哪種登入，CLI 都會用這把金鑰驗證，所以頁面顯示 **API 金鑰**，即使 `codex login status` 仍然回報 ChatGPT 登入。（以 `codex doctor` 觀察到；沒有用金鑰送出過提問。）
- 只設定了 `OPENAI_API_KEY`：它不會取代 ChatGPT 登入。頁面顯示**訂閱登入**，並說明 CLI 仍回報自己的登入。

兩種情況下都不會動到 `CODEX_ACCESS_TOKEN`；它的作用沒有檢驗過。

**模型與推理強度。** 模型與各自的推理強度來自 CLI（`codex debug models`）；也可以手動新增名稱。服務不接受的推理強度會讓該格以錯誤結束。

**已知限制。**

- 不會逐字輸出，也沒有推理過程的文字。回答到達之前，格子顯示「產生中 — 此供應商不會逐字串流」。
- 如果某個版本的 codex 不再認得 AnswerWall 傳入的某個開關，它會拒絕啟動；格子會說明這一點，而且不會送出任何東西。請更新 AnswerWall，或改用支援的 CLI 版本。
- 尚未以真實 CLI 確認：用量上限與限流時的失敗輸出、透過 `CODEX_API_KEY` 計費的提問，以及清單中有列出但沒有實際執行過的模型。

## Gemini（`agy`）

|              |                                                             |
| ------------ | ----------------------------------------------------------- |
| 安裝         | <https://antigravity.google/docs/getting-started>           |
| 登入         | 在終端機裡啟動 `agy` 並在其中登入；這個 CLI 沒有登入子指令  |
| 登入檢查     | 無：這個 CLI 沒有狀態指令，所以**登入狀態**一律顯示**未知** |
| 輸出方式     | 逐字輸出                                                    |
| 工具權限     | **不受限制**：沒有文件記載的方式可以關閉或限制它的工具      |
| 網路搜尋開關 | 無                                                          |
| 驗證情況     | 完全沒有。依廠商文件撰寫，只用模擬 CLI 測試過。             |

### 啟用前的說明

在全新安裝中，`agy` 是停用的。當你勾選**啟用**時，AnswerWall 會先顯示廠商在 [FAQ](https://antigravity.google/docs/faq) 中的原文：

> Antigravity CLI headless mode (`agy -p`) is intended for direct scripting
> and CI workflows. Wrapping `agy` inside third-party coding agents or
> applications, or automating account rotation, is not supported under
> consumer plans.

你必須勾選「我已閱讀並接受這項風險。」並按下**仍要啟用**。在那之前，這個 CLI 絕不會被啟動，連檢查也不會；使用它的格子會以 "This provider stays off until its notice has been acknowledged in the settings." 失敗。廠商的[條款](https://antigravity.google/terms)把 "Using third party software, tools, or services to access the Service" 稱為 "a breach of this Agreement"。AnswerWall 就是這樣的軟體。請把這一點考慮進去再決定。

**AnswerWall 怎麼執行它。** 以列印模式執行，輸入與輸出都是 JSON 事件；提問會以一行 JSON 寫入標準輸入。CLI 自己的時間上限會設成該格的時間上限；斜線指令會關閉，讓以 `/` 開頭的提問仍被當成提問；CLI 的背景自動更新也會關閉。同時請求數固定為 1。

**關閉了什麼。** 就工具而言，什麼都沒有。它只是得到一個空的工作目錄。請把這個供應商的回答，視為來自一個「能讀取、也能修改你的使用者所能碰到的一切」的代理程式。在意這一點的話，請只在 Docker 容器裡執行它。

**計費。** 開關關閉時，`GEMINI_API_KEY` 與 `GOOGLE_API_KEY` 會被移除。開啟時會保留，頁面顯示 **API 金鑰**；但廠商的[驗證說明頁](https://antigravity.google/docs/install)表示，只設定 `GEMINI_API_KEY` 而沒有在 CLI 自己的設定中選擇 Gemini 提供者，"has no effect"。AnswerWall 無從得知 CLI 實際用的是哪一種。

**已知限制。**

- 這個 CLI 把登入資訊放在作業系統的金鑰圈，而不是某個目錄裡。容器裡通常沒有金鑰圈，所以在容器中登入需要額外的工夫；見 [deploy-docker.md](deploy-docker.md)。
- AnswerWall 傳入的其中兩項（`--disable-slash-commands`，以及停止自動更新的環境變數）來自研究筆記，而不是 CLI 的說明輸出，對你的版本可能不正確。如果 CLI 拒絕某個參數，格子會以 CLI 的訊息失敗。
- 從 1.5.7 版起，這個 CLI 的列印模式在可用時可能以它的自動模式執行。AnswerWall 不會傳入模式。

## Grok（`grok`）

|              |                                                             |
| ------------ | ----------------------------------------------------------- |
| 安裝         | <https://docs.x.ai/build/overview>                          |
| 登入         | `grok login --device-auth`                                  |
| 登入檢查     | 沒有文件記載的狀態指令，所以**登入狀態**一律顯示**未知**    |
| 輸出方式     | 逐字輸出                                                    |
| 工具權限     | Linux 與 macOS：唯讀沙箱，盡力而為。Windows：**不受限制**。 |
| 網路搜尋開關 | 無                                                          |
| 驗證情況     | 完全沒有。依廠商文件撰寫，只用模擬 CLI 測試過。             |

**AnswerWall 怎麼執行它。** 這個 CLI 不讀標準輸入，所以提問會寫進每格專用目錄裡的 `prompt.txt`，再用 `--prompt-file` 傳入。回答以 JSON 事件串流傳回。不會傳入推理強度：CLI 的文件沒有這個選項。

**關閉了什麼。** AnswerWall 會要求空的工具清單（`--tools ""`）、單一回合（`--max-turns 1`）、不規劃、不用子代理、不自動更新，以及不使用跨工作階段的記憶（`GROK_MEMORY=0`）。在 Linux 與 macOS 上還會加上 `--sandbox read-only`。

**不能依賴的部分。** 以上各項都沒有以真實 CLI 確認過。沙箱是盡力而為：CLI 的文件說，無法套用沙箱時它會照常執行，供應商頁面上的提示也會這樣說明。在 Windows 上這個 CLI 完全沒有沙箱，頁面會把工具權限顯示為不受限制。模型真的嘗試使用工具時，格子會顯示一則說明。

**計費。** 開關關閉時，`XAI_API_KEY` 會被移除。開啟時會保留，但 CLI 只有在沒有登入工作階段時才會使用金鑰，所以頁面顯示**未知**並加以說明。

**已知限制。** 全部都是：這個介接程式還沒有碰過真實的 CLI。預期會發現差異，發現時請回報。

## OpenAI 相容端點

任何支援 OpenAI chat completions API 的伺服器：廠商的 API、閘道，或你自己機器上的模型伺服器。最多可以新增 60 個端點。

**新增端點。** 供應商頁面的 **OpenAI 相容端點**，按**新增端點**：

| 欄位       | 意義                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| 名稱       | 回答牆上顯示的名稱。                                                                            |
| 識別碼     | 小寫英文字母、數字與連字號，最多 32 個字元。之後無法更改。                                      |
| 基底網址   | `http://` 或 `https://` 開頭，結尾有沒有 `/v1` 都可以。不可帶使用者名稱、密碼、查詢字串或片段。 |
| API 金鑰   | 選填。儲存在伺服器上，之後不會再顯示。                                                          |
| 同時請求數 | 1 到 32，預設 4。                                                                               |

接著在新出現的卡片上按**重新檢查**。AnswerWall 會請求 `GET <base>/v1/models`；**可連線**與模型清單都來自這個回應。如果端點沒有模型清單，請在**你的模型**手動新增模型名稱。

**送出了什麼。** 每一格一個 `POST <base>/v1/chat/completions`，帶有 `stream: true`、你選的模型，以及作為單一 user 訊息的提問。沒有系統提示、沒有工具、沒有對話紀錄。格子帶有推理強度時，會以 `reasoning_effort` 送出。有 API 金鑰時，金鑰放在 `Authorization` 標頭。請求是從伺服器（或本機模式的 Windows 應用程式）發出的，不是從你的瀏覽器，而且只會送到你輸入的位址。

**金鑰。** 金鑰存放在機密檔案中，與資料庫分開；API 只會回報「有沒有金鑰」。金鑰屬於輸入當時的協定、主機與連接埠：如果把基底網址改到另一個來源而沒有重新輸入金鑰，已儲存的金鑰會被刪除。

### 範例：同一台機器上的模型伺服器或代理

只要提供 `/v1/chat/completions` 就可以用；兩個常見的例子：

| 軟體                        | 要輸入的基底網址         | API 金鑰               |
| --------------------------- | ------------------------ | ---------------------- |
| Ollama（預設連接埠）        | `http://127.0.0.1:11434` | 無                     |
| LiteLLM proxy（預設連接埠） | `http://127.0.0.1:4000`  | 代理的金鑰（如果有設） |

連接埠請以該軟體自己的文件為準。`127.0.0.1` 指的是執行 AnswerWall 的那台機器。對 Docker 裡的伺服器來說，那是容器自己，所以要改用容器連得到的位址（compose 檔提供 `host.docker.internal` 來指向 Docker 主機）；見 [deploy-docker.md](deploy-docker.md)。

像 LiteLLM 這樣的代理，也可以用來把不相容 OpenAI 格式的廠商 API、或多把金鑰，整合在一個端點後面。這種用法走的是 API 計費，不是訂閱。

### 從環境變數提供金鑰

在伺服器上，可以不透過頁面輸入就提供端點的金鑰。以識別碼為 `local-proxy` 的端點為例：

```
ANSWERWALL_SECRET_PROVIDER_LOCAL_PROXY_API_KEY=sk-...
ANSWERWALL_SECRET_PROVIDER_LOCAL_PROXY_API_KEY_ORIGIN=http://127.0.0.1:4000
```

名稱是識別碼轉成大寫，其他字元一律換成 `_`。第二個變數是必要的：來自環境變數的金鑰只會送到那個來源（協定、主機與連接埠）。沒有設定它，或端點指向別處時，金鑰不會送出，卡片上會說明原因。這是為了讓持有已登入裝置的人，無法把端點指向自己的伺服器，藉此取得一把他本來讀不到的金鑰。

**已知限制。** 只支援文字。端點以 `reasoning_content` 或 `reasoning` 送出推理文字時會顯示。有些伺服器會拒絕「在串流中回報 token 用量」的選項；這時 AnswerWall 會去掉該選項，把同一個請求再送一次。
