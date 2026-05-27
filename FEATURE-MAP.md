# 🧩 功能地圖（Feature Taxonomy）— 開發文檔

> 把同類型 Upwork 案子彙整成「**大功能類別 → 小功能**」的需求地圖。
> **只記錄需要哪些功能，不開發功能本身。**
> 例：搜「chatbot」→ 歸納出「對話記憶」「存到 Google Sheet」「下訂單卡片」… 並為每個功能標註難度／工具／出現頻率／相依關係。

建立日期：2026-05-27

---

## 1. 這功能在做什麼

| | 說明 |
|---|---|
| **輸入** | 一個或多個「工作類型」關鍵字（如 `chatbot`、`voice assistant`、`web scraping`） |
| **過程** | 收集同類案子的工作描述 → AI 歸納出這類案子通常需要哪些小功能 → 賦予屬性 → 累積合併 |
| **輸出** | `feature-taxonomy.json`（資料）+ `/features` 網頁（檢視） |
| **定位** | 不是評估單一案子（那是 `② 評估`／`analyze.js`），而是**橫向彙整一整類案子的功能需求地圖** |

### 每個「小功能」記錄的屬性

| 屬性 | 範例 | 說明 |
|---|---|---|
| `name` | 對話記憶 | 小功能名稱 |
| `difficulty` | 低 / 中 / 高 | 實作難度（合併時取較高者，保守看待） |
| `tools` | Redis、pgvector、Stripe | 常用工具 / API / 技術（跨批次聯集） |
| `frequency` | 3 | 在掃描過的案子裡出現幾次（頻率，跨批次累加） |
| `depends` | LLM 整合 | 相依的其他小功能 |
| `note` | 記住上下文 | 一句話說明 |

---

## 2. 檔案結構（寫在哪裡）

全在 `upwork-job-finder/`：

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/taxonomy.js` | 🆕 新增 | 資料層：讀寫 `feature-taxonomy.json`、AI 萃取 prompt、跨批次合併邏輯、排序檢視 |
| `src/scan-features.js` | 🆕 新增 | 掃描主程式：收集案子描述 → 呼叫 AI → 合併入庫（CLI + 可程式呼叫） |
| `src/web.js` | ✏️ 修改 | 加 `/features` 檢視頁、`/api/scan-features` API、導航列「🧩 功能地圖」 |
| `config.json` | ✏️ 修改 | 加 `featureScan` 設定區塊 |
| `package.json` | ✏️ 修改 | 加 `npm run features` |
| `README.md` | ✏️ 修改 | 加「🧩 功能地圖」章節 |
| `feature-taxonomy.json` | 執行後產生 | 掃描結果（可 git 版控、人類可讀） |

### 模組相依

```
scan-features.js
  ├─ taxonomy.js      (資料層 + prompt + 合併)
  ├─ analyze.js       (askAI → ProxyCLI gRPC AI)
  ├─ assist.js        (extractJson 容錯解析)
  ├─ db.js            (讀 jobs.db 既有描述)
  └─ gstack browse    (補抓，外部 CLI)

web.js
  ├─ taxonomy.js      (loadTaxonomy / toView 渲染 /features)
  └─ scan-features.js (動態 import，/api/scan-features 觸發)
```

---

## 3. 資料結構（feature-taxonomy.json）

```jsonc
{
  "updatedAt": "2026-05-27T...",
  "categories": {
    "聊天機器人-chatbot": {            // key = 名稱 slug（跨批次去重用）
      "id": "聊天機器人-chatbot",
      "name": "聊天機器人 Chatbot",
      "query": "chatbot",             // 來源關鍵字
      "jobCount": 12,                 // 此大類累積掃描過的不重複案子數
      "features": {
        "對話記憶": {
          "id": "對話記憶",
          "name": "對話記憶",
          "difficulty": "中",
          "tools": ["Redis", "pgvector"],
          "frequency": 8,
          "depends": ["LLM 整合"],
          "note": "記住上下文"
        }
      }
    }
  },
  "sources": [                        // 追溯：哪些案子貢獻了資料
    { "jobId": "...", "title": "...", "url": "...", "category": "聊天機器人-chatbot", "scannedAt": "..." }
  ]
}
```

用「物件 keyed by slug」而非陣列，是為了**跨批次／跨關鍵字合併時 O(1) 去重**。
渲染時 `toView()` 才轉成陣列：大類依案子數、功能依頻率降序排。

### 合併邏輯（mergeBatch）

同一功能在不同批次重複出現時：

- `frequency` → **累加**（反映真實出現次數）
- `tools` / `depends` → **聯集去重**
- `difficulty` → **取較高**（低 < 中 < 高，保守看待風險）
- `note` → 保留既有，空才補新
- `sources` → 依 jobId 去重，`jobCount` = 該大類不重複來源數

---

## 4. 使用方式

### 網頁（推薦）

```bash
cd upwork-job-finder
npm run web
# 開 http://127.0.0.1:8787/features
# 輸入工作類型（逗號分隔多個）→ 按「🔍 掃描功能」
```

### CLI

```bash
npm run features -- "chatbot" "voice assistant" "web scraping"
npm run features -- "chatbot" --no-gstack   # 只用 jobs.db，完全不爬
```

### 設定（config.json → featureScan）

```jsonc
"featureScan": {
  "maxJobsPerQuery": 12,      // 每個關鍵字最多用幾個案子餵 AI
  "batchSize": 5,             // 每幾個案子餵一次 AI（決定 frequency 上限）
  "minDbJobs": 5,             // DB 命中少於此數，才啟動 gstack 補抓
  "gstackSupplement": true,   // 是否允許 gstack 補抓
  "gstackFetchLimit": 8,      // 補抓上限（低量，降反爬風險）
  "gstackDelaySeconds": 3     // 每筆補抓間隔秒數（放慢）
}
```

---

## 5. ⚠️ 遇到的問題與解法

### 問題一：Cloudflare 互動式人機檢測（核心坑）

**現象**：Upwork 用 Cloudflare 互動式 human 檢測（Turnstile / Managed Challenge）。
被程式控制的瀏覽器（Playwright + CDP）在檢測前**常常點了也過不去**，CF 偵測得到自動化。

**第一版的錯誤**：我最初寫的 `scan-features.js` 主路徑用 **raw Playwright 直爬**
（`browser.js` 的 `launch()` + 逐頁進詳情頁），而且多關鍵字 × 每個進 12 頁 = **狂爬**。
這正是專案文件（`AGENTS-PLAN.md`：「agent 不要狂爬 Upwork」、`README.md`：「全自動爬取不可靠」）
早就踩過、明令避免的路 — 既不可靠、量大還會被封。

**解法：反轉資料來源策略，與專案既有「能過 CF」做法一致**

| | 第一版（錯） | 修正後 |
|---|---|---|
| 主來源 | ❌ raw Playwright 直爬 | ✅ `jobs.db` 既有描述（擴充套件 ingest／seed 累積，CF-safe、零爬取） |
| 補抓 | — | ✅ gstack 指紋瀏覽器（能過 CF），只在 DB 不足時低頻低量取用 |
| raw Playwright | 主路徑 | **完全移除** |

修正後流程（`scanFeatures`）：

1. 每個關鍵字先從 `jobs.db` 撈同類案子描述（**主來源**）
2. 命中數 < `minDbJobs`（預設 5）才啟動 **gstack 補抓**：上限 8 筆、每筆隔 3 秒、撞 CF 自動等待重試
3. `--no-gstack` 可強制只用 DB，完全不碰網路

> gstack 補抓沿用 `enrich-gstack.js` / `analyze.js` 已驗證的 `connect / goto / snapshot` 模式，
> 用 `js` 抽連結（JSON 容錯解析）+ snapshot regex 退路。

### 問題二：jobs.db 描述薄

**現象**：目前 `jobs.db` 有 32 案，但**只有 2 個有完整描述**（其餘來自 `seed.js` 的薄資料，沒 description）。
功能萃取需要完整工作描述，薄資料萃取不出東西。

**解法 / 建議**：主力進案管道是**瀏覽器擴充套件 → `/api/ingest`**（在真實登入瀏覽器抓、CF 不擋、帶完整描述）。
描述累積越多，功能地圖就長出越多大類。詳見 README「📥 Webhook 接收端點」。

### 問題三：ESM 環境誤用 require

開發中一度在 `gstackReady()` 用了 `require('node:fs')`，但專案是 `"type": "module"`（ESM），`require` 未定義。
**解法**：改用 `import { existsSync } from 'node:fs'`。

### 問題四：背景伺服器被工作階段回收

用背景工具起的 `npm run web` 會隨工作階段被中止（exit 144）。
**解法**：改用 `nohup node src/web.js >/tmp/upwork-web.log 2>&1 &` 常駐；關閉用 `lsof -ti:8787 | xargs kill`。

---

## 6. 進案數據的 4 個管道（全繞開 CF 直爬）

| 管道 | 程式 | 過 CF | 量 | 適用 |
|---|---|---|---|---|
| ① **瀏覽器擴充套件** → `/api/ingest` | `web.js` | ✅ 不擋 | 大、持續 | **主力**，自動 feed 完整描述 |
| ② **gstack 指紋瀏覽器** | `scan-features.js`、`enrich-gstack.js` | ✅ 可過 | 低頻低量 | 功能地圖即時補抓 |
| ③ **官方 GraphQL API** | `api-fetch.js` | ✅ 無 CF | 中、全自動 | 有金鑰時無人值守 |
| ④ **手動 seed** | `seed.js` | — | 小 | 應急（薄資料） |

---

## 7. 驗證紀錄（2026-05-27）

- `node --check` 三個檔案語法通過
- 合併邏輯 smoke test：frequency 累加、tools 聯集、難度取高、jobCount 去重 ✓
- 實跑 `npm run features -- "full stack" --no-gstack`：2 案 → **AI 萃取出 1 大類、12 個小功能**
  （含難度／工具／頻率／相依），整條 `jobs.db → AI → JSON → 功能地圖` 鏈路打通 ✓
- `/features` 網頁 HTTP 200，正確渲染萃取結果 ✓

---

## 8. 已知限制與下一步

- **資料量**：功能地圖品質正比於 `jobs.db` 裡同類案子的描述數量。先把擴充套件接上累積資料。
- **gstack 依賴**：補抓需先在主視窗 `/open-gstack-browser` 並登入 Upwork。
- **AI 依賴**：萃取走 ProxyCLI（`.env` 的 `AI_PROXY_TOKEN` / `AI_PROXY_PROJECT`），單請求 60 秒上限 → 採分批設計。
- 後續可考慮：跨大類的「共用功能」彙整、功能 → 我的作品集對照（哪些功能我已有現成方案）、匯出成接案能力清單。
