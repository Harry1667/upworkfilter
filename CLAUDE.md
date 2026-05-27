# CLAUDE.md — Upwork 接案助手(專案指引)

> 一套上線的 Upwork 接案輔助系統。瀏覽器擴充套件抓真實職缺 → webhook 餵雲端 → 評分 + AI 漏斗 → dashboard。
> 詳細交接看 `AGENTS-PLAN.md`,最新進度看 `SESSION_NOTES.md`。

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

## 架構(全在 src/)
- `web.js` — HTTP 伺服器 + 所有頁面/API + 浮動聊天 widget 注入(serveHtml)。
- `score.js` — 規則 7 維評分 + 新手模式 + 低 CP 降級。
- `triage.js` — AI 快篩(便宜模型批次,產分數/中標率/母子標籤,詞彙取自功能地圖)。
- `analyze.js` — 大分析(askAI / ProxyCLI gRPC)+ 評估網站 HTML。**callProxy 必須非同步**(同步會凍結整站)。
- `assist.js` — profile + 求職信/建議/回覆/聊天 prompt。
- `taxonomy.js` + `scan-features.js` — 功能地圖(大類→小功能);標籤詞彙來源。
- `agents/profile-agent.js` — GitHub → proven capabilities。
- `db.js` — node:sqlite,**WAL + busy_timeout**(避免 database locked)。

## 重要約定
- 註解用繁體中文;async/await;錯誤處理明確。
- AI 漏斗:規則(免費)→ 快篩(openai/low,自動)→ 大分析(claude,手動)。貴的只對好案跑。
- 卡片分數「以 AI 為準」:有 ai_score 就覆蓋規則分。
- 改 CHAT_WIDGET / 任何含內嵌 JS 的模板字串:**勿在裡面放未跳脫的反引號**(會提前結束模板 → 語法錯)。
- echo 含中文括號 `()` 在 zsh 會出錯,寫 server 端 node 指令時避免。
- 改 schema/評分後常需重跑快篩補欄位(server 端 node 背景跑)。

## Skill routing
- QA/測試站台 → /qa;Bug/錯誤 → /investigate;登入/auth → 03-Skills/hdw-auth;AI 代理服務 → proxycli。
