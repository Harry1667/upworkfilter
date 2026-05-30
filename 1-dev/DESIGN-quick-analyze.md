# 設計：Quick Analyze（貼上 / 一鍵分析任意 Upwork 職缺）

> 狀態：**✅ 三方審查通過（含修正）→ 可實作**
> 日期：2026-05-31

## 🔒 三方審查定案（取代下方草案的衝突處）

Codex(技術/安全) + Gemini(UX) 都說 **OK 可做**,依下列修正:
1. **不覆蓋現有 `/api/analyze`**(那是 DB-job AI 大分析)。新開:
   - `POST /api/quick-analyze` — 規則評分,不寫 DB(免費即時)
   - `POST /api/quick-analyze/ai` — 對臨時 job 跑 AI(勝率/大分析,按鈕觸發)
   - `POST /api/quick-analyze/save` — 登入後存列表(POST JSON + 登入驗證,不靠 INGEST_KEY)
2. **抽出 `normalizeIngest` → `src/ingest.js`**,web.js + 新端點共用,不複製解析。
3. **fragment 安全(全採納)**:`/analyze` 讀 fragment → `JSON.parse` + schema 驗證 → 一律 `textContent`/`esc()` 渲染(**禁 innerHTML**)→ 讀完立刻 `history.replaceState(null,'','/analyze')` 清掉 → payload 上限 ~24KB、description server 端 `slice(0,8000)`。
4. **bookmarklet = best-effort**:不靠單一 selector,優先抓 h1/描述容器/About client,再用 `body.innerText` label regex 補抓 Budget/Proposals/Payment/Spent/Hire/Connects;抓不到就送 raw text 讓規則解析降級。`/analyze` **一定保留可編輯 textarea** 讓使用者修正。
5. **UX(Gemini)**:紅綠燈 verdict(🟢衝/🟡考慮/🔴別浪費)放首屏 + 風險旗標,7 維細節往下捲;主打「**省 Connects / 投案准駁器**」;存列表一鍵完成;頁面教「拖到書籤列」裝 bookmarklet。
6. **A vs B**:**A(貼上)是主流程/穩;B(bookmarklet)是加速器**。兩個都做(共用端點),A 為 B 的降級備案。
7. 預設 **ephemeral 不寫 DB**;「存列表」才落庫。
8. 寫入端點(save)加 Origin 檢查(現全域 CORS `*` 不理想)。

— 以下為原始草案(細節以上面定案為準)——


## 目標
使用者看到一個 Upwork 職缺，**不必等擴充排程、不必先進 DB**，馬上得到：
7 維評分 + 勝率 + verdict + 🚩風險旗標（含非開發/詐騙/connects）+ 一鍵降風險提案。

兩個入口（方案 C = A+B 共用同一後端）：
- **A. `/analyze` 頁**：貼上「職缺網址 + 職缺內容（標題/描述/預算/提案數）」→ 即時分析。
- **B. Bookmarklet**：在任何 Upwork 職缺頁（使用者已登入、不被 CF 擋）點一下書籤 → 抓當前頁 DOM → 帶資料開 `/analyze` → 顯示分析。

## 為什麼不做「純貼網址→伺服器自動抓」
Upwork 對伺服器自動抓是 Cloudflare 硬擋（scrape/profile 都被擋過）。所以資料**一律來自使用者的瀏覽器**（貼上或 bookmarklet 抓 DOM），伺服器不主動抓 Upwork。

## 架構

### 1) 後端端點 `POST /api/analyze`
- 輸入：`{ url?, title?, text/description, budget?, proposals?, client?... }` 或一坨 raw text。
- 流程：`stripChrome` → `normalizeIngest`-style 解析 → `scoreJob`（規則，免費，即時）。
- 回傳：`{ ok, job:{id,verdict,scores,total_score,reason,flags}, ... }`。
- AI 為**選用**（成本控制）：預設只回規則分；前端有按鈕才另呼叫 `/api/analyze/ai`（triage 勝率 + 大分析）與 `/api/cover-letter`（提案）。
- **不自動寫 DB**；回傳附「💾 存進列表」選項（呼叫既有 ingest 落庫）。

### 2) `/analyze` 頁
- textarea 貼職缺；按「分析」→ POST /api/analyze → 渲染 verdict + 7 維 + 勝率 + 風險旗標。
- 「✨ 生提案」「🤖 AI 勝率」「💾 存列表」按鈕（各自觸發，AI 才花錢）。

### 3) Bookmarklet
- 一段 JS 書籤，在 Upwork 職缺頁執行：抓 DOM（title/description/budget/proposals/client）→ 把資料 **base64 塞進 URL fragment**，開新分頁 `https://upworkfilter.looptw.com/analyze#data=...`。
- `/analyze` 頁（使用者在此站已登入）讀 fragment → 同源呼叫 `/api/analyze`。
- **好處**：避開跨網域 POST + 不必在 bookmarklet 放金鑰（同源、靠登入 cookie）。

## 認證
- `/analyze` 頁 + `/api/analyze`：走既有 hdw-auth（要登入）。
- Bookmarklet 不直接打 API，只開 `/analyze#data=`（GET，資料在 fragment，不離開瀏覽器到第三方）→ 由已登入的 `/analyze` 頁同源呼叫 API。**不需要 key、不需要 CORS。**

## 重用既有
`stripChrome`/`scoreJob`（score.js）、`normalizeIngest`（web.js）、`triageJobs`（triage.js）、`analyzeJob`/`askAI`（analyze.js）、`coverLetterPrompt`/synth（assist.js）、`/api/ingest`（存列表）。新增主要是 1 個端點 + 1 個頁 + 1 段 bookmarklet。

## 成本控制
- 規則評分即時、免費（不打 AI）。
- AI（勝率/大分析/提案）一律「按鈕觸發」，不自動跑 → 使用者只對想投的案花 AI 錢。

## 開放問題（請審查者裁示）
1. Bookmarklet 抓 Upwork DOM 夠不夠穩？還是 A（貼上）就夠、B 之後再說？
2. analyze 預設要不要存 DB？（傾向不存，給「存列表」按鈕）
3. fragment 傳資料 vs sessionStorage vs 後端暫存 token——哪個最穩妥、不洩漏？
4. 對 0 評價新手，這功能是「真的幫他更快投對案」還是 nice-to-have / 過度設計？
5. 有沒有比 bookmarklet 更穩的一鍵法（不動現有擴充的前提下）？
