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

---

## 2026-07-06(晚) 生成守門審計 + 語言案 refresh bug

**批量審計(10 案即時數據 → 19 份生成產物)抓到 5 個系統性錯誤:**
1. 身分門檻全盲(Female 案照樣教投+寫信) 2. 捏造資產(發明麥克風型號/已錄樣本) 3. 語言案人格錯亂(推銷 GitHub、寫「你找錯人」拒絕文) 4. 信與投標策略報價矛盾 5. 幻覺 repo(socialbot 不存在)。

**修正(2c8dc59):** coverLetterPrompt/SynthPrompt 加【身分門檻⛔/語言案人格/證據白名單/報價紀律】;advicePrompt/screeningPrompt 身分條件(性別/母語/居住地)一律 🔴 且不適用「profile 沒記全」保留;profile.json 新增 languageAssets(男性/華語母語/英文口說需備稿/台語有限),本機+伺服器都已加。驗收:Female Mandarin→⛔、男聲配音→正確語言身分信、台語配音→⛔(JD 標籤真有 Female)。

**refresh bug(31061d6):** /api/refresh-job 是唯一漏「語言案不進 AI 快篩」的路徑,會把語言案打 0 分+洗掉 category;setAiVerdict 空字串繞過 COALESCE 也修了。4 個受害案已還原。

**即時數據教訓:** 16 案刷新後 7 案現形為紅海(DB 快照「<5 提案」實際 50+)。投前必 refresh。

---

## 2026-07-06(深夜) Sia 提案 + 追蹤/刷新閉環

**✅ 完成**
- Sia rental app($300 trial)提案包:誠實攤牌版求職信+三題答案 → 桌面`提案-sia-rental-app.md`(用完刪);NearSafe 三屏 demo HTML(中/英雙版,桌面 nearsafe-demo*.html),英文版當 portfolio+附件;portfolio 文案已給。
- 生成守門審計閉環(見上節):5 錯誤模式修正已部署+驗收 3/3(Female案⛔/男聲配音正確人格/台語案⛔有據)。
- 一鍵投案追蹤(e774ebb):job 頁+收件匣卡片「✅ 我投了」直接建追蹤。
- 數據年齡警示+刷新佇列+本機看門狗(e774ebb):job 頁顯示「📡 數據更新於 X 小時前」(6h黃/12h紅),過期自動入佇列;`npm run refresh:watch` 本機消化(網站有📋複製指令按鈕);E2E 驗證佇列拉取/失敗不卡死 OK。
- advicePrompt:bid 禁嵌套 JSON;visibility 抓不到 Activity 段退回用結構化欄位(proposals/experience/connects,jobBrief 已補)。

**🔄 未完成 / 卡住**
- **GStack 瀏覽器 Upwork session 斷了**(今日 19 次自動載入後被 Cloudflare 盯上,403 challenge):需在 GStack 視窗手動過 Cloudflare+登入 Upwork,之後看門狗才能動。教訓:別批量刷,一天個位數分散刷。
- Sia 提案使用者填表中(付款方式 By project/時長 1 to 3 months/附件/highlights 清單已給);投出後要在 job 頁按「✅ 我投了」— 投案追蹤第一筆。

**💡 決策**
- Do not apply if 資格門檻:經驗類=標紅燈但使用者決定;**身分類(性別/母語/居住地)=直接判死**(languageAssets 是事實)。
- profile.json 新增 languageAssets,**本機+伺服器兩份都要改**(不進版控)。
- 提案數快照會過期騙人(16 案刷出 7 紅海)→ 投前必刷新。

**🚀 下次起點**
1. 確認 GStack 視窗已登入 Upwork(壞了跑 /connect-chrome),測 `npm run refresh:watch`。
2. 問 Sia 投了沒 → job 頁按「✅ 我投了」開始追蹤;等客戶回應。
3. 佇列在 job 頁自動累積,看門狗開著就會消化。

**📁 檔案**:src/web.js·db.js·assist.js·refresh-watch.js(新)·package.json;伺服器 HEAD=e774ebb;桌面三個交付檔(提案md/demo html×2)
