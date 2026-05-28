# Upwork Job Filter

> 一套上線的 Upwork 接案輔助系統。瀏覽器擴充套件抓真實職缺 → webhook 餵雲端 → 規則評分 + AI 漏斗 → dashboard 排序與評估。

## 三道門漏斗（核心心智模型）
- 🚪 **第一道門・來源**：依個人能力分級產出 Upwork 搜尋關鍵字/網址，貼進擴充功能同步 `searchQueries`
- 🎯 **第二道門・能力**：`score.js` 紅線 / 能力圈外硬攔截，產出 `blocked` 標記不進 AI；核心強命中只標 ⚠️ 軟降
- 📊 **第三道門・評分 + AI**：7 維規則評分 → 便宜 AI 快篩 → 高分案才丟大模型深度分析

## 主要功能
- **列表頁**：依 verdict / 適配 / 競爭 / 報酬 / 客戶花費等排序，含 🦴 撿漏模式（低提案小預算）
- **評估頁**：單案 7 維評分 + AI 評估 + 客戶資料 + 即時刷新（提案數會過期，用 gstack 重抓）
- **提案頁**：AI 生成求職信（含自我批改）、投標策略、勝率
- **溝通頁**：客戶回覆草稿、聊天 prompt
- **能力管理**：可交付項目 + 邊界（不用框架名+等級）；GitHub Profile Agent 自動掃 repo 推導 proven capabilities
- **浮動聊天助手**：每頁右下角，自動帶入當前頁面 / 案件上下文，支援多對話歷史

## 架構
- `src/web.js` — HTTP 伺服器、所有頁面 / API、浮動聊天 widget
- `src/score.js` — 7 維規則評分 + 第二道門（紅線、能力圈外攔截）
- `src/triage.js` — 便宜 AI 批次快篩（產分數、勝率、母子標籤）
- `src/analyze.js` — Claude 深度分析 + 評估網站 HTML
- `src/assist.js` — Profile + 求職信 / 投標策略 / 篩選問題 / 回覆 prompt
- `src/agents/profile-agent.js` — GitHub → proven capabilities
- `src/refresh-live.js` — 本機 gstack 即時刷新單案
- `src/db.js` — node:sqlite（WAL + busy_timeout）

## AI 漏斗成本控制
規則（免費）→ 快篩（openai/low，自動）→ 大分析（claude，手動）。貴的只對好案跑。

## 部署
- 線上：upworkfilter.looptw.com（port 3012）
- 登入用 hdw-auth 共用驗證（auth.twloop.com）
- `/api/ingest` 用 `INGEST_KEY` 驗證（擴充功能 webhook）

---

## English

A live Upwork job-hunting assistant. A browser extension scrapes real listings → webhook to cloud → rule-based scoring + AI funnel → dashboard for sorting and evaluation.

### Three-gate funnel (core mental model)
- 🚪 **Gate 1 — Source**: search keywords/URLs derived from your skill tiers, pasted into the extension to sync `searchQueries`
- 🎯 **Gate 2 — Capability**: `score.js` hard-blocks redline / out-of-scope jobs (`blocked` flag, never reaches AI); core-skill matches only get a soft ⚠️ downgrade
- 📊 **Gate 3 — Score + AI**: 7-dimension rule scoring → cheap AI triage → only high-scoring jobs go to the full Claude analysis

### Features
- **List page**: sort by verdict / fit / competition / payout / client spend, with 🦴 *junk-job mode* (low proposals + low budget for newbies hunting 5★ reviews)
- **Job page**: 7-dimension score + AI evaluation + client info + live refresh (proposal counts go stale — re-scrape via gstack)
- **Proposal page**: AI-generated cover letter (with self-review), bid strategy, win-rate estimate
- **Reply page**: client-message draft + chat prompt
- **Capability profile**: described as "deliverables + boundaries" (not framework + level); a GitHub Profile Agent crawls repos to derive proven capabilities
- **Floating chat assistant**: bottom-right on every page, auto-passes current page / job as context, with multi-thread history

### Architecture
- `src/web.js` — HTTP server, all pages / APIs, floating chat widget
- `src/score.js` — 7-dim rule scoring + Gate 2 (redline / out-of-scope blocking)
- `src/triage.js` — cheap AI batch triage (score, win-rate, parent/child tags)
- `src/analyze.js` — deep Claude analysis + evaluation HTML
- `src/assist.js` — profile + cover letter / bid strategy / screening / reply prompts
- `src/agents/profile-agent.js` — GitHub → proven capabilities
- `src/refresh-live.js` — local gstack live re-scrape for a single job
- `src/db.js` — node:sqlite (WAL + busy_timeout)

### Cost-aware AI funnel
Rules (free) → triage (openai/low, auto) → analysis (claude, manual). The expensive model only runs on jobs worth it.

### Deployment
- Live at upworkfilter.looptw.com (port 3012)
- Auth via shared hdw-auth (auth.twloop.com)
- `/api/ingest` protected by `INGEST_KEY` (extension webhook)
