# Upwork Job Filter

> 一套上線的 Upwork 接案輔助系統。瀏覽器擴充功能抓真實職缺 → webhook 餵雲端 → 三道門漏斗評分 + AI 多階段協作 + 信任度驗證 → 投案追蹤 + 持續學習。

線上：http://upworkfilter.looptw.com

## 三道門漏斗（核心心智模型）

- 🚪 **第一道門・來源**：依個人能力分級產出 Upwork 搜尋關鍵字/網址，貼進擴充功能同步 `searchQueries`
- 🎯 **第二道門・能力**：`score.js` 紅線 / 能力圈外硬攔截，產出 `blocked` 不進 AI
- 📊 **第三道門・評分 + AI**：7 維規則評分 → 便宜 AI 快篩 → 高分案才丟 Claude 深度分析

## 主要功能

### 案件管理
- **① 列表**：依 verdict / 適配 / 競爭 / 報酬 / 客戶花費排序，含 🦴 撿漏模式
- **② 評估**：單案 7 維評分 + AI 評估 + 即時 refresh
- **③ 提案**：AI 多 agent 寫信 + 多重驗證（見「信任度機制」）
- **④ 溝通**：客戶回覆草稿
- **⑤ 邀請**：客戶主動 invites 評估

### 我的檔案
- **🎯 能力（/me）** / **🪪 Upwork Profile（/profile）** / **⚖️ 評分（/scoring）** / **🤖 Agents（/agents）** / **🧩 功能地圖（/features）**

### 信任度機制（讓你能放心用 AI 產出的東西）

| 機制 | 做什麼 | 在哪看到 |
|---|---|---|
| **3 writer + 1 總編** | Hook / 誠實 / JD 鏡像三派平行寫，總編合成最終版 | ③ 提案頁求職信 |
| **🔍 幻覺偵測** | 對照 profile.json，每個 claim 標 ✅/⚠️/🚨 | 求職信下方 |
| **📚 Citation** | 每句話旁邊插 `[1][2][?][!]` 標來源 | 求職信下方 |
| **😈 Skeptic** | 魔鬼代言人挑刺：套版 / 浮誇 / 沒對應 JD | 求職信下方 |
| **🚦 能見度評分** | 從 Activity 段抓 Proposals / Interviewing / Boost 排行，給新手「投不投」硬規則 | 投標策略最上方 |
| **📌 Lessons** | 你抓到 AI 錯就存，自動注入未來所有 prompt | /lessons |
| **🧠 自動 Lesson 萃取** | 從投案 notes 自動歸納 lesson 候選 | /applications 🧠 按鈕 |

### 投案追蹤（持續學習迴圈）
- **📊 /applications**：投案後狀態追蹤（已投 → 已閱 → 有回 → 面試 → 中標/拒絕/沒回）
- 統計卡：回應率 / 面試率 / 中標率 / 燒了多少 Connects
- Notes 寫「為什麼這案沒中」→ 點 🧠 → AI 萃取成 Lessons → 自動避免再犯

### 浮動聊天助手（每頁右下角）
- 自動帶入當前頁面 / 案件上下文
- 多對話歷史（localStorage 跨 session）
- 內化 9 步投案 SOP

## 架構

```
src/
├─ web.js           HTTP 伺服器 + 所有頁面 + API + 浮動聊天 widget
├─ score.js         7 維規則評分 + 第二道門
├─ triage.js        便宜 AI 批次快篩
├─ analyze.js       Claude 深度分析 + askAI 共用
├─ assist.js        Cover letter (3 writer + 總編) / 策略 / 篩選 / 回覆 prompt
├─ verify.js        信任度:幻覺偵測 / Citation / Skeptic / 自動 Lesson 萃取
├─ db.js            node:sqlite (WAL),表:jobs/invites/lessons/applications
└─ agents/profile-agent.js
```

## AI 漏斗成本控制
規則（免費）→ 快篩（openai/low，自動）→ 大分析（claude，手動）→ 驗證（openai/low，平行）

## 部署
- 線上：upworkfilter.looptw.com（port 3012）
- 登入用 hdw-auth；`/api/ingest` 用 `INGEST_KEY` 驗證

```bash
git add -A && git commit -m "..." && git push
ssh ubuntu@137.131.7.230
sudo bash -c 'export PATH=/www/server/nodejs/v22.22.2/bin:$PATH
  cd /www/wwwroot/upworkfilter.looptw.com
  git fetch origin main && git reset --hard origin/main && pm2 restart upworkfilter-web'
```

## 使用流程
詳見 [USER-FLOW.md](./USER-FLOW.md)

---

## English

A live Upwork job-hunting assistant. Browser extension scrapes real listings → webhook to cloud → 3-gate scoring funnel + multi-agent AI collaboration + trust verification → application tracking + continuous learning loop.

Live: http://upworkfilter.looptw.com

### Three-gate funnel
- 🚪 **Gate 1 — Source**: search keywords derived from skill tiers
- 🎯 **Gate 2 — Capability**: hard-blocks redline / out-of-scope
- 📊 **Gate 3 — Score + AI**: rule scoring → cheap triage → Claude deep analysis

### Trust mechanisms

| Mechanism | What it does | Where |
|---|---|---|
| 3 writers + 1 synthesizer | Hook / Honest / JD-mirror styles in parallel | Proposal page |
| 🔍 Hallucination check | Every claim cross-checked vs profile.json | Below cover letter |
| 📚 Citations | Inline `[N][?][!]` markers with sources | Below cover letter |
| 😈 Skeptic | Adversarial reviewer flags weaknesses | Below cover letter |
| 🚦 Visibility score | Parses Activity (Proposals/Interviewing/Boost) — hard rules for newbies | Top of advice |
| 📌 Lessons | User-captured AI errors auto-injected | /lessons |
| 🧠 Auto-lesson extraction | LLM derives lessons from "why I lost" notes | /applications |

### Application tracking
**📊 /applications**: status timeline + stats (response/interview/hire rates, Connects burned). Notes field feeds the auto-lesson extractor → never repeat mistakes.

### Stack
- Node.js (no framework) with `node:sqlite` (WAL)
- Anthropic Claude + OpenAI via unified proxy
- hdw-auth shared JWT
- upworkfilter.looptw.com (port 3012)

See [USER-FLOW.md](./USER-FLOW.md) for end-to-end usage.
