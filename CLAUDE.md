# CLAUDE.md — Upwork 接案助手(專案指引)

> 一套上線的 Upwork 接案輔助系統。瀏覽器擴充套件抓真實職缺 → webhook 餵雲端 → 評分 + AI 漏斗 → dashboard。
> 文檔都在 `1-dev/`:詳細交接 `1-dev/AGENTS-PLAN.md`、最新進度 `1-dev/SESSION_NOTES.md`、部署 `1-dev/DEPLOY.md`、API 申請 `1-dev/UPWORK-API申請.md`。

## 部署
```bash
# 本機
git add -A && git commit -m "..." && git push
# 伺服器(Oracle 137.131.7.230,key 在 ~/Documents/important file/ssh-key-2026-04-08.key)
ssh -i "~/Documents/important file/ssh-key-2026-04-08.key" ubuntu@137.131.7.230
sudo bash -c 'export PATH=/www/server/nodejs/v22.22.2/bin:$PATH
  cd /www/wwwroot/upworkfilter.looptw.com
  git fetch origin main && git reset --hard origin/main && pm2 restart upworkfilter-web'
```
- 線上:http://upworkfilter.looptw.com(port 3012)。改完一律 push + 部署。
- 登入帳號在 auth.twloop.com(hdw-auth 共用驗證)。`/api/ingest` 用 INGEST_KEY。

## 三道門漏斗(核心心智模型)
🚪① 來源:`/me` 分級技能 → Upwork 搜尋關鍵字/網址(貼擴充功能,同步 config.searchQueries)
🎯② 能力:`score.js` 紅線/能力圈外 → SKIP+`blocked`(不進 AI);核心強命中只標 ⚠️ 軟降
📊③ 評分+AI:7 維 → AI 快篩 → 大分析

## 架構(全在 src/)
- `web.js` — HTTP 伺服器 + 所有頁面/API + 浮動聊天 widget 注入(serveHtml)。頁面:① 列表 ② 評估 ③ 提案 ④ 溝通 ｜ 🧩 功能地圖 · 🎯 能力(/me) · 🪪 Upwork(/profile) · ⚖️ 評分 · 🤖 Agents(/agents)。
- `score.js` — 規則 7 維評分 + 新手模式 + 低 CP 降級 + **第二道門**(分級能力權重、紅線/能力圈外硬攔截 `blocked`、`wordHit` 整字比對、紅線軟硬分)。
- `triage.js` — AI 快篩(便宜模型批次,產分數/中標率/母子標籤;讀 capabilityBrief + outcome 校正)。
- `analyze.js` — 大分析 + 評估網站 HTML;`askAI` 共用。**callProxy 必須非同步**。
- `assist.js` — profile + `capabilityBrief()`(共用能力邊界)+ 求職信(含自我批改)/投標策略(含勝率)/篩選問題(screeningPrompt)/回覆/聊天 prompt。
- `agents/profile-agent.js` — GitHub → proven capabilities。
- `refresh-live.js` — 本機 gstack 開即時頁重抓單案(提案/面試/客戶)→ POST /api/refresh-job。`rescore.js` — 套能力邊界重算+回填 blocked。
- `api-fetch.js` — 官方 GraphQL API 抓案(已套能力邊界/模式權重/posted_at;`--detail` 探針)。等 key 審核。
- `db.js` — node:sqlite,**WAL + busy_timeout**。欄位含 `blocked`(第二道門擋下)、`posted_at`(發布絕對時間戳,顯示依現在重算,別用會過期的 posted_text)。

## 能力資料(profile.json `capability`)
- `skills[]`={name 可交付項目, level 1-5, canDo, cantDo, keywords};redlines 紅線;scaleCeiling;searchKeywords(第一道門)。
- **描述能力一律用「可交付項目+邊界」,不用框架名+等級**。profile.json 個人資料**不進版控**,預設放 profile.example.json。

## 重要約定
- 註解用繁體中文;async/await;錯誤處理明確。
- AI 漏斗:規則(免費)→ 快篩(openai/low,自動)→ 大分析(claude,手動)。貴的只對好案跑。
- 卡片分數「以 AI 為準」:有 ai_score 就覆蓋規則分。
- 改 CHAT_WIDGET / 任何含內嵌 JS 的模板字串:**勿在裡面放未跳脫的反引號**(會提前結束模板 → 語法錯)。
- echo 含中文括號 `()` 在 zsh 會出錯,寫 server 端 node 指令時避免。
- 改 schema/評分/能力後重算:`npm run rescore`(本機或 server,套能力邊界+回填 blocked)。
- 提案數/面試數是抓取當下快照、會過期;即時校正用 `npm run refresh -- <id>` 或 /upwork-refresh skill(本機 gstack)。

## 常用指令
- 重算:`npm run rescore`　· 即時重抓單案:`npm run refresh -- <id|url>`
- 官方 API(待審核):`npm run api:auth` → `npm run api:fetch`（`-- --raw` / `-- --detail <id>` 探針）

## Skill routing
- 刷新案子即時數據/提案數對不上 → **upwork-refresh**(本機 gstack)。
- Upwork 職缺評估網站 → harry-upworkweb;QA → /qa;Bug → /investigate;登入/auth → 03-Skills/hdw-auth;AI 代理 → proxycli。
