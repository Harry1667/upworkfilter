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
🎯② 能力(can-do):`score.js` 紅線/能力圈外 → SKIP+`blocked`(不進 AI);核心強命中只標 ⚠️ 軟降
📊③ 評分+AI:7 維 → AI 快篩 → 大分析
🥊④ 競爭可行性(can-win):`score.js` 新手競爭閘 + `triage.js` 勝率硬上限。**核心原則:能力分高 ≠ 接得到** —— Expert tag/超高 Connects/超預算的案,能力滿分也要壓成 SKIP/MAYBE,別燒 Connects 投不可能的案。

## 架構(全在 src/)
- `web.js` — HTTP 伺服器 + 所有頁面/API + sidebar/chat panel。CSS Grid 佈局(body grid-template-columns:200px 1fr);serveHtml 把 sidebar 從 page 抽出移到 body 第一個 grid item。頁面:① 列表 ② 評估 ③ 提案 ④ 溝通 ⑤ 邀請 ｜ 🌅 今日 📊 投案追蹤 ❤️ 收藏 ｜ 🎯 能力 🪪 Upwork ⚖️ 評分 🧩 功能地圖 🤖 Agents ｜ 📌 Lessons ⭐ 範本 💾 備份。
- `score.js` — 規則 7 維評分 + 第二道門 + **💀 死亡訊號攔截**(payment_verified=0/hire_rate=0/50+ proposals/spent=0 命中 ≥ 2 → SKIP,防爛客戶)+ **紅線在 title = 強制硬擋**(不論其他多強)+ **🥊 新手競爭可行性閘(can-win,非客戶品質)**:`experience_level=Expert` / `connects_required≥15` / `預算上限<底價` 為訊號,新手模式命中 ≥2→SKIP「能力夠但搶不到」、==1→APPLY 降 MAYBE。專抓「②能力分高、客戶也 OK,但 0 評價搶不到」的案。資料抓不到的訊號不計(不誤殺未 enrich 的案)。`parseExperienceLevel`/`parseConnectsRequired` 共用解析(enrich/refresh 都用)。
- `triage.js` — AI 快篩 + **新手勝率硬上限**(!pv→8% / hire 0%→10% / 50+ props→12% / spent < \$100→15% / **Expert+0評價→15% / connects≥15 再-10%**)+ **Required 覆蓋率規則**(逐項拆 Must-have,有沒做過的核心 Required 項→win 下修,別被 4/5 命中騙高分)。
- `analyze.js` — 大分析 + 評估網站 HTML;`askAI` 共用,支援 `opts.provider` 切換(claude/openai/gemini)。
- `assist.js` — profile + capabilityBrief + 求職信(3 writer + 總編合成) + 投標策略 + 篩選問題 + 回覆 + chatPrompt(注入 9 步 SOP + Lessons + Anchors + tool docs)。
- `verify.js` — **信任度 5 函式**:detectHallucinations(幻覺偵測) / annotateCitations(句句標來源) / skepticCritique(魔鬼代言人) / preflightCheck(SOP 守則核對) / extractLessonCandidates(從 notes 萃取 lesson)。
- `tools.js` — chat agent **11 個 tool registry**(list/add/update/delete applications/lessons/anchors/jobs)+ ReAct loop。
- `agents/profile-agent.js` — GitHub → proven capabilities。
- `refresh-live.js` / `rescore.js` / `api-fetch.js` — 即時刷新 / 重算 / 官方 GraphQL(待 key)。
- `db.js` — node:sqlite,WAL + busy_timeout。表:`jobs`(含 `blocked`/`posted_at`/`favorited`)、`invites`、`applications`(投案追蹤)、`lessons`(學習日誌)、`anchors`(cover letter 範本)。

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
