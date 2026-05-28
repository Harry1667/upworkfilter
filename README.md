# Upwork Job Filter

> 一套上線的 Upwork 接案輔助系統。瀏覽器擴充功能抓真實職缺 → webhook 餵雲端 → **三道門漏斗評分** + **死亡訊號攔截** + **AI 多階段協作** + **6 重信任度驗證** → 投案追蹤 + 持續學習 + Tool-use chat agent。

**線上**：https://upworkfilter.looptw.com
**架構**：Node.js (no framework) + node:sqlite + Anthropic Claude / OpenAI / Gemini via 統一 proxy
**Layout**：CSS Grid 左側 sidebar + IDE 風格右側 chat panel

---

## 三道門漏斗（核心心智模型）

- 🚪 **第一道門・來源**：依個人能力分級產出 Upwork 搜尋關鍵字/網址，貼進擴充功能同步 `searchQueries`
- 🎯 **第二道門・能力**：`score.js` 紅線 / 能力圈外硬攔截，產出 `blocked` 不進 AI
- 📊 **第三道門・評分 + AI**：7 維規則評分 → 便宜 AI 快篩 → 高分案才丟 Claude 深度分析

## 💀 死亡訊號攔截（新手必開）

針對新手特化的硬規則 — 命中 ≥ 2 個自動 SKIP：
- ❌ 付款未驗證
- ❌ 客戶 hire rate 0%
- ❌ Proposals 50+（紅海）
- ❌ 客戶從沒花過錢

---

## 📑 頁面導覽

```
左 Sidebar (固定 200px Grid column):
─── 投案流程 ───
① 列表 / ② 評估 / ③ 提案 / ④ 溝通 / ⑤ 邀請

─── 每日 ───
🌅 今日 / 📊 投案追蹤

─── 設定 ───
🎯 能力 / 🪪 Upwork / ⚖️ 評分 / 🧩 功能地圖 / 🤖 Agents

─── 學習工具 ───
📌 Lessons / ⭐ 範本 / 💾 備份
```

### 主要頁面

| 路徑 | 用途 |
|---|---|
| `/` | ① 列表：含 🦴 撿漏模式（提案 < 10 + 預算 $20-200） |
| `/job?id=` | ② 評估：7 維分 + AI 分 + 即時 refresh + 🔒 標私案 |
| `/proposal?id=` | ③ 提案：核心頁 — cover letter + 6 重信任度驗證 |
| `/reply` | ④ 客戶訊息回覆草稿 |
| `/invites` | ⑤ 客戶主動邀請評估 |
| `/today` | 🌅 每日 briefing：真實成功率 + 今天該做的 |
| `/applications` | 📊 投案追蹤：狀態 + 統計 + 從 notes 萃取 lesson |
| `/lessons` | 📌 學習日誌 |
| `/anchors` | ⭐ Cover letter 範本（few-shot 注入） |
| `/backup` | 💾 匯出/還原 JSON |

---

## 🛡️ 信任度機制（讓你能放心用 AI 產出的東西）

| 編號 | 機制 | 做什麼 | 在哪看到 |
|---|---|---|---|
| - | **3 writer + 1 總編** | Hook 派 / 誠實派 / JD 鏡像派三派平行寫，總編合成 | ③ 提案頁 cover letter |
| ② | **✅ Preflight Checklist** | 對照 Lessons + SOP 守則逐條核對是否遵守，違反列原文 + 建議改 | 求職信下方綠框 |
| ③ | **🔍 幻覺偵測** | 對照 profile.json，每個 claim 標 ✅verified / ⚠️unverified / 🚨contradicted | 求職信下方 |
| ⑥ | **📚 Citation 標來源** | 每句話旁插 `[1][2][?][!]` superscript，列出對應 profile 段 | 求職信下方 |
| ⑦ | **🤝 多模型共識** | 點「🤝 共識模式」→ Claude/OpenAI/Gemini 各跑一版，差異比對 | 求職信上方紫框 |
| ⑧ | **⭐ Anchors（Few-shot）** | 你親自審過 OK 的 cover letter → 自動注入未來 prompt 校準 voice | /anchors + 一鍵「⭐ 標為範本」 |
| ⑩ | **😈 Skeptic 自我打臉** | 魔鬼代言人挑刺：套版 / 浮誇 / 沒對應 JD，high/med/low 分級 | 求職信下方紅框 |
| - | **🚦 新手能見度評分** | 從 JD Activity 段抓 Proposals/Interviewing/Boost 排行 → 新手硬規則 | 投標策略最上方橘框 |
| ④ | **📌 Lessons 學習日誌** | 你抓到 AI 錯就存 → 自動注入所有未來 prompt | /lessons |
| - | **🧠 自動 Lesson 萃取** | 從投案 notes 自動歸納 lesson 候選 → 一鍵存 | /applications 🧠 按鈕 |

---

## 🤖 Chat Agent（IDE 風格右側 panel）

每頁右下角 💬 launcher → 開啟後變右側固定 panel（推開主內容並列顯示）

### 內化能力
- 自動帶入當前頁面 / 案件上下文
- 多對話歷史（localStorage 跨 session）
- 內化 9 步投案 SOP + Lessons / Anchors 注入

### Tool Use — 能執行 11 個動作

| 動作 | 例句 |
|---|---|
| 列投案 | 「我投過哪些案？」 |
| 匯入已投 | 「把列表頁勾過已投的匯進來」 |
| 加投案 | 「幫我加 SaaS MVP 進追蹤」 |
| 改狀態 | 「Cowork 那案改成已閱」 |
| 改 notes / 刪投案 | 「加備註說競爭太激烈」「刪除 #3」 |
| 加 lesson | 「記下：別假裝會 React Native」 |
| 列 lessons / 刪 | 「我有幾條 lessons」「刪 #2」 |
| 列 anchors / 加 | 「秀我的範本」「這封存為範本」 |
| 列案件 | 「給我看 5 個 APPLY 的案」 |
| 標已投 | 「Claude FullStack 標為已投」 |

協定：AI 在回覆夾 `<tool>{"name":"...","args":{...}}</tool>` → server 執行 → 結果回傳 → AI 用人話總結。

### 大塊文字處理
- 使用者訊息 > 300 字自動摺疊 + 「展開全文 ▾」
- 輸入框 textarea auto-grow（44 → 300px）
- 貼 JD / cover letter 不爆畫面

---

## 📊 投案追蹤 + 學習迴圈

```
投案 ─→ Skeptic 挑刺 ─→ 修改 ─→ Submit
  │                              │
  │                              ↓
  │                       📊 建追蹤紀錄
  │                       (✉️→👁→💬→🎤→🎉/❌/🕳)
  │                              │
  │                              ↓
  │                       失敗 → 寫 Notes
  │                              │
  │                              ↓
  │                       🧠 AI 萃取 Lesson
  │                              │
  │                              ↓
  └────── 📌 注入下次 prompt
```

### 統計卡（取代 AI 猜測）
- 總投案 / 回應率 / 面試率 / 中標率
- 燒掉 Connects 累計
- 本週投案數 + 反應數
- 領域別命中率（哪類案勝率高）

---

## 架構

```
src/
├─ web.js           HTTP 伺服器 + 所有頁面 + API + sidebar/chat widget
├─ score.js         7 維規則評分 + 死亡訊號攔截 + 第二道門
├─ triage.js        便宜 AI 批次快篩(內化新手勝率硬上限)
├─ analyze.js       Claude 深度分析 + askAI 共用(支援 opts.provider 切換)
├─ assist.js        Cover letter (3 writer + 總編) / 策略 / 篩選 / 回覆 prompt
│                   profileBrief 自動注入 lessons + anchors
├─ verify.js        信任度模組:
│                   - detectHallucinations() 幻覺偵測
│                   - annotateCitations()   句句標來源
│                   - skepticCritique()     魔鬼代言人
│                   - preflightCheck()      Lessons + SOP 守則核對
│                   - extractLessonCandidates() 從 notes 萃取 lesson
├─ tools.js         Chat agent 11 個 tool 註冊表 + ReAct loop
├─ db.js            node:sqlite (WAL),表:
│                   - jobs / invites (案件 / 邀請)
│                   - applications (投案追蹤)
│                   - lessons (學習日誌)
│                   - anchors (cover letter 範本)
└─ agents/profile-agent.js  GitHub → proven capabilities
```

---

## AI 漏斗成本控制

```
規則(免費) → 快篩(openai/low,自動) → 大分析(claude,手動) → 驗證(4 路平行)
```

提案頁 ✨ 產生提案時平行跑：
1. 3 writer + 總編合成（claude）
2. 🔍 幻覺偵測（cheap）
3. 📚 Citation（cheap）
4. 😈 Skeptic（cheap）
5. ✅ Preflight checklist（cheap）

`?mode=consensus` → 改跑 Claude + OpenAI + Gemini 三模型共識（多 30s）

---

## 部署

- 線上：upworkfilter.looptw.com（port 3012，Nginx proxy）
- 登入用 hdw-auth 共用驗證（auth.twloop.com）
- `/api/ingest` 用 `INGEST_KEY` 驗證（擴充功能 webhook，不用登入）

```bash
git add -A && git commit -m "..." && git push
ssh ubuntu@137.131.7.230
sudo bash -c 'export PATH=/www/server/nodejs/v22.22.2/bin:$PATH
  cd /www/wwwroot/upworkfilter.looptw.com
  git fetch origin main && git reset --hard origin/main && pm2 restart upworkfilter-web'
```

---

## 重要約定
- 註解用繁體中文；async/await；錯誤處理明確
- AI 漏斗：規則（免費）→ 快篩（openai/low，自動）→ 大分析（claude，手動）
- 改 schema/評分/能力後重算：`npm run rescore`
- 提案數會過期：`npm run refresh -- <id>`
- echo 含中文括號在 zsh 會出錯，寫 server 端 node 指令時避免

## 使用流程

詳見 [USER-FLOW.md](./USER-FLOW.md)

---

## English

A live Upwork job-hunting assistant. Browser extension scrapes real listings → webhook to cloud → **3-gate scoring funnel** + **death-signal blocker** + **multi-stage AI collaboration** + **6-layer trust verification** → application tracking + continuous learning loop + tool-using chat agent.

**Live**: https://upworkfilter.looptw.com
**Stack**: Node.js (no framework) + `node:sqlite` + Anthropic Claude / OpenAI / Gemini via unified proxy
**Layout**: CSS Grid left sidebar + IDE-style right chat panel

### Three-gate funnel
- 🚪 **Gate 1 — Source**: search keywords derived from skill tiers
- 🎯 **Gate 2 — Capability**: hard-blocks redline / out-of-scope
- 📊 **Gate 3 — Score + AI**: rule scoring → cheap triage → Claude deep analysis

### 💀 Death-signal blocker (newbie mode)
Hits ≥ 2 → forced SKIP:
- Payment not verified
- Client hire rate 0%
- 50+ proposals (red ocean)
- Client never spent

### Trust mechanisms

| # | Mechanism | What it does | Where |
|---|---|---|---|
| - | 3 writers + 1 synthesizer | Hook / Honest / JD-mirror in parallel | Proposal page |
| ② | ✅ Preflight checklist | Verifies each Lesson + SOP rule was followed | Below cover letter |
| ③ | 🔍 Hallucination check | Cross-checks every claim vs profile.json | Below cover letter |
| ⑥ | 📚 Citations | Inline `[N][?][!]` markers with sources | Below cover letter |
| ⑦ | 🤝 Multi-model consensus | Claude + OpenAI + Gemini run in parallel | Above cover letter |
| ⑧ | ⭐ Anchors (few-shot) | User-approved letters injected as voice anchors | /anchors |
| ⑩ | 😈 Skeptic | Adversarial reviewer flags weaknesses | Below cover letter |
| - | 🚦 Visibility score | Parses Activity section, hard rules for 0-review newbies | Top of advice |
| ④ | 📌 Lessons | User-captured AI errors auto-injected forever | /lessons |
| - | 🧠 Auto-lesson extraction | LLM derives lessons from "why I lost" notes | /applications |

### Application tracking
**📊 /applications**: status timeline (sent → viewed → replied → interview → hired/rejected/no_response), real stats (response/interview/hire rates), Connects burned. Notes → auto lesson candidates → never repeat mistakes.

### Chat agent with tool use
IDE-style right panel (pushes main content). 11 tools: list/add/update/delete applications, lessons, anchors, jobs. AI emits `<tool>{...}</tool>` → server executes → result fed back → AI summarizes in plain language.

See [USER-FLOW.md](./USER-FLOW.md) for end-to-end usage.
