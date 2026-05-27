# Upwork Job Finder

自動爬取 Upwork 案子 → 用 4 個訊號評分 → 篩出「值得投」的案子 → 存進 SQLite。
讓你不用再亂花 Connects,只投有機會被錄取的案子。

## 它怎麼運作

1. **記住登入指紋** — 用獨立的瀏覽器 profile,你登入一次,之後永久保持登入。
2. **爬取** — 跑你設定的搜尋關鍵字,抓每個案子的客戶數據。
3. **評分(0–100)** — 四個訊號:
   - **客戶品質 (40)**:付款驗證、累積花費、雇用率、評分
   - **競爭程度 (20)**:提案數越少越高分(也最省 Connects)
   - **技能 match (25)**:案子內容命中多少你的技能關鍵字
   - **預算合理 (15)**:時薪/固定價是否落在你可接受範圍
4. **硬性排除** — 付款未驗證、雇用率 0%、時薪低於底價 → 直接判 SKIP。
5. **存 SQLite** — `jobs.db`,記錄判斷(APPLY / MAYBE / SKIP)、分數、客戶數據、你投了沒。

## 安裝(已完成)

```bash
npm install          # 已裝好 playwright
npx playwright install chromium   # 已下載
```

## 用法

```bash
# 1) 登入一次(開瀏覽器,在視窗裡登入 Upwork)
npm run login

# 2) 爬取 + 評分 + 入庫(可重複跑,會更新)
npm run scrape

# 3) 看值得投的案子(依分數高到低)
npm run report

# 其他報表
npm run report -- maybe       # 看「可考慮」
npm run report -- all         # 看全部
npm run report -- skip        # 看被排除的(確認沒誤殺)
npm run report -- applied     # 看你已投的

# 投完一個案子後,標記起來(避免重複投)
npm run report -- mark <id>
```

`<id>` 是報表每筆最後一行印出的 `id`。

## 自訂(改 `config.json`)

- `searchQueries` — 搜尋關鍵字(每行一組,用 OR 串多個詞)
- `mySkills` — 你的技能清單(影響 skill match 評分)
- `rate.hourlyFloor / hourlyTarget / fixedFloor` — 你的出價底線與目標
- `scoring.weights` — 四個訊號的權重(預設 40/20/25/15)
- `scoring.verdictThresholds` — 幾分算 APPLY(60)、幾分算 MAYBE(42)
- `hardExcludes` — 硬性排除規則(0% 雇用率、未驗證付款等)
- `scrape.headless` — `false` 看得到瀏覽器(較不易被反爬蟲擋),`true` 背景跑
- `scrape.enrichTopN` — 抓幾個候選案的客戶詳情(越多越慢)

## 檔案結構

```
config.json        你的設定
jobs.db            SQLite 資料庫(自動產生)
session/           登入指紋(自動產生,勿外流)
src/
  browser.js       啟動瀏覽器 + 沿用登入 profile
  login.js         npm run login
  scrape.js        npm run scrape
  score.js         評分引擎(四訊號 + 硬排除)
  report.js        npm run report
  db.js            SQLite 資料層
  taxonomy.js      功能地圖資料層(feature-taxonomy.json)
  scan-features.js npm run features
```

## ⚠️ 關於 Cloudflare(務必看)

Upwork 用 **Cloudflare 互動式 human 檢測**(Turnstile / Managed Challenge)。
實測結果:

- **全自動爬取不可靠** — 被程式控制的瀏覽器在互動檢測前,常常點了也過不去
  (CF 偵測到 CDP 自動化)。`npm run scrape` 會在偵測到 CF 時暫停等你在視窗點過,
  但**不保證能通過**。
- **評分 / SQLite / 報表 100% 可用**。

### 務實用法:`npm run seed`

當 CF 擋住自動爬取時,改用這個流程:

1. 用「能過 CF 的瀏覽器」(例如 gstack、或你平常的 Chrome)瀏覽 Upwork 搜尋結果。
2. 把案子資料填進 `src/seed.js` 的 `raw` 陣列(title / id / 付款 / 提案數 / 客戶花費 / 預算)。
3. `npm run seed` → 寫入 DB + 評分。
4. `npm run report` 看篩選結果。

`src/seed.js` 已內含 17 筆 2026-05-26 掃到的真實案子當範例。

## 注意

- `session/` 含你的登入資訊,**別上傳到 GitHub**(已寫進 .gitignore)。
- 反爬蟲風險:**低頻、低量、headed、自己點 CF** 最安全。別整天掛著、別調快延遲。
- 評分是「輔助篩選」,不是保證。APPLY 的案子仍要你寫好提案才會被錄取。

## 🌐 產生接案評估網站(按鈕 / CLI)

每張案件卡片有「🌐 產生評估網站」按鈕。點下去會:
1. 用 gstack 指紋瀏覽器抓該 Upwork 職缺(過 Cloudflare)
2. 呼叫 **ProxyCLI(hdw-proxycli)** 的 AI(gRPC,串流)做分析,回傳精簡 JSON
3. Node 本地把 JSON 渲染成完整評估網站(7 項加權評分、英文提案草稿、客戶評估…)
4. 自動在瀏覽器開啟,檔案存成 `upwork-<id>-analysis.html`

也可用 CLI:`npm run analyze -- <jobId>`

**前置需求:**
- `.env` 填好 `AI_PROXY_TOKEN` 與 `AI_PROXY_PROJECT`(需是 ProxyCLI 儀表板已建立的專案名)。
- **gstack 瀏覽器要先連線並登入 Upwork**(headed),否則抓到的職缺資料會不完整。
  先在主視窗跑 `/open-gstack-browser` 並登入。
- ProxyCLI 伺服器對單次請求有 **60 秒上限**,所以採「AI 只回 JSON、HTML 本地渲染」的兩段式設計,
  並用 gRPC 串流;`AI_PROXY_TIER` 建議 `mid`(快又夠好)。
- Python 依賴:`pip3 install grpcio grpcio-tools`(gRPC 呼叫用)。

## 📥 Webhook 接收端點(/api/ingest)— 接瀏覽器擴充套件

最安全的資料來源:用瀏覽器擴充套件在你**真實登入的瀏覽器**抓職缺(CF 不會擋),
透過 webhook 推進來自動評分入庫。不用等 API、不用跟 Cloudflare 搏鬥。

**推薦擴充套件:** [Upwork Job Scraper](https://chromewebstore.google.com/detail/mojpfejnpifdgjjknalhghclnaifnjkg)
(richardadonnell,Chrome/Firefox 商店現成)。

**設定:**
1. `npm run web` 讓伺服器跑著(端點:`http://localhost:8787/api/ingest`)
2. 在擴充套件設定:
   - 你的 Upwork **saved search 網址**
   - Webhook URL 填:`http://localhost:8787/api/ingest`
3. 擴充套件抓到新職缺 → POST 進來 → 自動評分 → 出現在網頁列表

**端點行為:**
- `GET /api/ingest` → 健康檢查
- `POST /api/ingest` → 接受單筆物件、陣列、或 `{"jobs":[...]}`;欄位名寬容
  (title/jobTitle、url/jobUrl/link、description、budget、paymentVerified、proposals、totalSpent、hireRate、rating…)
- 回傳 `{ok, ingested, results:[{id,title,verdict,score}]}`
- 選用金鑰:`.env` 設 `INGEST_KEY=xxx`,則需帶 `?key=xxx` 或標頭 `X-Ingest-Key`

> 重點:餵進**完整資料**時評分才準(seed 的薄資料會讓清晰度/報酬維度偏低)。擴充套件抓的是完整職缺,評分最有鑑別度。

## 🧩 功能地圖(feature taxonomy)

把同類型案子彙整成「**大功能類別 → 小功能**」的需求地圖,**只記錄功能、不開發**。
例如搜「chatbot」會歸納出:對話記憶(難度中,Redis/向量DB)、存到 Google Sheet
(難度低,Sheets API)、下訂單卡片(難度中,Stripe)…並標出每個功能在多少案子出現過。

每個小功能屬性:`難度`(低/中/高)、`常用工具/API`、`出現案數`(頻率)、`相依功能`、`一句話說明`。

```bash
# CLI:一次可給多個工作類型
npm run features -- "chatbot" "voice assistant" "web scraping"
npm run features -- "chatbot" --no-gstack   # 只用 jobs.db,完全不爬

# 或網頁:npm run web → 開 /features → 輸入關鍵字按「掃描功能」
```

**資料來源(和本專案「能過 Cloudflare」策略一致,不直爬):**
1. **主來源 = `jobs.db`** — 擴充套件 ingest / seed 累積的完整描述,CF-safe、零爬取。
2. **補抓 = gstack 指紋瀏覽器** — 只在 DB 同類案子不足(`featureScan.minDbJobs`)時,
   低頻、低量抓幾筆(`gstackFetchLimit`),能過 CF。需先在主視窗 `/open-gstack-browser` 並登入。
3. ❌ **不用 raw Playwright 直爬** — 那條路被 Cloudflare 互動檢測擋、量大會被封。

> 想要功能地圖更準,先讓擴充套件多 feed 幾個同類案子進 `jobs.db`(描述越完整越好)。
> 設定在 `config.json` 的 `featureScan` 區塊;結果存 `feature-taxonomy.json`(可 git 版控)。

## 指令總表

```bash
npm run login    # 登入一次(記住指紋)
npm run scrape   # 嘗試自動爬取(CF 可能擋,會暫停等你點)
npm run seed     # 用已收集的真實案子寫入 DB(CF 擋住時的務實做法)
npm run report   # 看值得投的案子
npm run report -- maybe | all | skip | applied
npm run report -- mark <id>   # 標記已投
npm run web      # 開網頁(含評分設定頁 + 「產生評估網站」按鈕 + 🧩 功能地圖)
npm run analyze -- <id>   # 對某案產生接案評估網站
npm run features -- "chatbot" "voice assistant"   # 功能地圖:歸納同類案子需要哪些功能
```
