# SESSION NOTES

## 2026-05-29（本次 session — 大改版）

### ✅ 完成

**信任度機制 6 重驗證**（全部上線）
- ② Preflight Checklist — 對照 Lessons + SOP 守則逐條核對
- ③ 幻覺偵測 — 每 claim 標 ✅/⚠️/🚨
- ⑥ Citation — 句句標 `[N][?][!]` 來源
- ⑦ Multi-model 共識（Claude/OpenAI/Gemini 三路）
- ⑧ Anchors（few-shot 範本注入）
- ⑩ Skeptic（魔鬼代言人挑刺）

**評分強化**
- 💀 死亡訊號攔截器（payment_verified=0 / hire_rate=0 / 50+ proposals / spent=0 命中 ≥ 2 = SKIP）
- 🚦 新手能見度評分（從 JD Activity 段抓 Interviewing/Boost rankings）
- triage.js 加新手勝率硬上限（!pv→8% / hire 0%→10% / 50+ props→12%）
- score.js 紅線出現在 title = 強制硬擋

**🥊 新手競爭可行性閘 — can-win（晚間追加，已上線）**
- 核心洞察:**能力分高 ≠ 接得到**。原本只防爛客戶(死亡訊號)，沒防「②能力滿分但 0 評價搶不到」的案 → 第四道防線
- 觸發案例:Expert tag + 27 Connects + 超預算的全端 AI 案，能力 100 分卻幾乎中不了
- 新增 DB 欄位:`experience_level`(Entry/Intermediate/Expert)、`connects_required`
- score.js 競爭閘:`Expert+0評價` / `connects≥15` / `預算上限<底價$12` 為訊號 → 命中 ≥2 = SKIP「能力夠但搶不到」、==1 = APPLY 降 MAYBE(並標 🥊 原因)
- `parseExperienceLevel`/`parseConnectsRequired` 共用:先 strip gstack 無障礙樹 `@eNN [type]` 標記(否則欄位被隔開抓不到)+ 防誤判(等級詞需與 "Experience Level" 相鄰)
- triage.js:Expert+0評價→win≤15%、connects≥15 再-10%、**Required 覆蓋率**(逐項拆 Must-have,有沒做過的核心項如 live voice agent → win 下修,別被 4/5 命中騙高分)
- ✅ 真實 enrich 驗證:21 案全抓到等級(Expert7/Inter12/Entry2)，7 個 Expert 案正確觸發閘門
- ⚠️ 限制:`connects_required` 只在**投案頁**出現，詳情頁 enrich 抓不到 → 多為 null，閘門靠 Expert tag + 預算優雅降級

**Lessons + Anchors 系統**
- 📌 /lessons CRUD + auto-inject 進所有 AI prompt
- 🧠 從 application notes 自動萃取 lesson 候選
- ⭐ /anchors few-shot 範本管理 + 「⭐ 標為範本」按鈕
- 本次 session 加了 8 條 lesson:
  1. 0 評價別自爆（"I'll overdeliver" 是業務話術）
  2. 專案描述加情境/規模/結果
  3. "production X I use daily" 沒證據 = 模糊
  4. "Ready to start" 改成 A vs B 選擇題
  5. 開頭不要 "To answer your points"
  6. 特定 SaaS 平台沒實戰 = SKIP
  7. n8n + SaaS production = SKIP
  8. 前 5 個 5★ 前不接 Swift / SwiftUI

**投案追蹤**
- 📊 /applications 表 + 狀態流（sent→viewed→replied→interview→hired/rejected/no_response）
- 統計卡（真實回應/面試/中標率 + Connects 燒）
- 從列表頁 applied=1 一鍵匯入
- 🧠 萃取 Lesson 按鈕

**Chat agent 重做**
- IDE 風格右側 panel（CSS Grid 佈局，body.chat-open #pagecontent margin-right:420px）
- Tool use:11 個動作（list/add/update/delete applications, lessons, anchors, jobs）
- 長訊息(>300字)自動摺疊 + textarea auto-grow + 送出後重置高度
- ReAct loop:AI 夾 `<tool>{...}</tool>` → server 執行 → 結果回送

**Layout 重寫**
- CSS Grid: body grid-template-columns: 200px 1fr
- serveHtml 把 sidebar 從 page 內抽出 → body 第一個 grid item
- Sidebar 4 組:投案流程 / 每日 / 設定 / 學習工具
- ❤️ 收藏案件 (jobs.favorited)、🔒 標私案、🦴 撿漏 mode

**Profile 真實化**
- capability.skills 從 11 個吹噓清單 → 12 個誠實能力（含 canDo/cantDo）
- 紅線 51 個（含 Ashby/Workday/Salesforce/n8n/React Native/Laravel/WordPress 等）
- searchKeywords 對齊 sweet spot:API + AI + Dashboard + Workflow
- scaleCeiling 改成「獨立可承接小~中型」誠實版

**文件**
- README.md 大改 — 全功能對照表 + 中英文
- USER-FLOW.md — 9 步使用流程
- 1-dev/00-INDEX.md — 文件總索引
- 1-dev/01-SOP-投案流程.md — 投案 9 步 SOP
- **1-dev/能力地圖.md（本次新增）** — Flutter vs SwiftUI / 三類框架 / 紅線 / 接案 mantra
- 1-dev/03-Applications/ — 每案一資料夾

**Bug fixes**
- 提案頁 `const sc` / `var sc` 變數衝突
- Cover letter 留 [PLACEHOLDER] / placeholder 偵測
- Nginx proxy_read_timeout 60→300s（共識模式 + 4 verify 並發爆 timeout）
- 共識模式自動跳 verify（10 個 AI call → 5 個）
- `.applayout flex` 子元素只取 min-content → 改 display:block + padding-left

### 🚧 未完成 / 下次起點

**真正該做的（不是再做功能）**
- **去投 10 個爛單**累積真實數據
- 系統強到 over-engineered 了，applications 表還空的 → AI 沒實戰資料可學

**還沒做但討論過的**
- React Native 仍是 0 個 → 不接（已加紅線）
- 面試應對工具（雇主回信時怎麼接）— ④ 溝通頁有但弱
- ROI 分析 / Cover letter A/B test — 樣本不夠，先別做

**Layout 還有殘留問題?**
- 用 DevTools 驗證過 CSS Grid 沒問題了
- 如果使用者再回報，需要他貼 DevTools 截圖

### 📌 下次起點

1. **看 /today 真實數據**:現在 0 投案 → 沒資料
2. **去投 3 個撿漏單**:🦴 撿漏 mode + 提案 < 10 + 預算 $20-200 + payment_verified
3. **每投完一案立刻建追蹤**:提案頁「✅ 我投了」按鈕
4. **抓到 AI 寫錯立刻加 lesson**
5. **伺服器跑 enrich 填經驗等級**:can-win 閘要 `experience_level` 才生效，線上 DB 現有案多為 null → 在伺服器跑 `npm run enrich` 或本機 `npm run refresh -- <id>` 補；之後 Expert 案會自動降級
6. **觀察 can-win 閘誤殺率**:若把該投的 Expert 案也擋掉，調 score.js 競爭閘門檻(目前 ≥2 訊號才 SKIP)

### 🔑 重要連結
- 線上:https://upworkfilter.looptw.com
- 重要頁:`/today` / `/me` / `/lessons` / `/anchors` / `/applications`
- 本機能力地圖:`1-dev/能力地圖.md`
- 投案 SOP:`1-dev/01-SOP-投案流程.md`

---

## 2026-07-06 接案狀態 / Gemini key / 收件匣更新

**接案狀態模式**
- 網站側欄已加「🟢 空閒 / 🔴 忙碌」模式。
- 空閒:小額乾淨快單($30-150、單一明確範圍、幾小時可交付)可當買評價跳板;金額小不是死因,範圍陷阱才是死因。
- 忙碌:收回底線(時薪≥$20、fixed≥$200),Discord 推播門檻提高,小額案不推。

**n8n 原則**
- n8n 從紅線移除:可投 self-host Docker + Code node JS 類型,但提案必須帶針對性 demo/同構實績作證據。
- JD 要求 certified / 多年 n8n 經驗仍略過。信件禁止道歉、禁止瞎掰。

**Gemini key 分池**
- 免費額度是算「Google Cloud 專案」,不是算 key;一個專案多 key 仍共用同一桶額度。
- 目前伺服器 `ai-keys.json` 有 6 把免費 key + 1 把付費 key(尾碼 Yzsw),檔案 gitignored。
- 背景快篩固定 `keyMode: free`,永遠只用免費池,不會用付費。
- 聊天/單案分析採「免費池優先」:先跑 6 把免費 key;只有免費池全部失敗且 UI 開啟「允許付費備援」,才會碰付費 key。
- 「允許付費備援」在 `/agents` → `Gemini API Key(直連設定)`。目前預設關閉。

**快篩慢的根因與緩解**
- 慢不是資料庫問題,是 Gemini 免費 key 額度 429 後退到共用 proxy;proxy 高峰很慢。
- 已改:Gemini 429 不空等假 retry、快篩逾時放寬到 150s、殭屍清理 170s、batchSize 降到 2。
- 根治:免費 key 要分散到不同 Google Cloud 專案;付費 key只作互動備援,不是背景快篩預設。

**收件匣刷新**
- `/inbox` 上方加刷新列:顯示載入時間、目前候選案數、視窗大小,按「🔄 刷新」會保留目前 hours 參數重載。
- 用途:新案會持續進來,看收件匣時可手動刷新拿最新排序。
