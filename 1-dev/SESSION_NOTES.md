# SESSION NOTES

## 2026-05-28(能力模型 + 三道門 + agent 優化 + 即時重抓)

### 完成事項
- **🎯 我的能力頁(/me)+ 三道門漏斗**:🚪一·來源(分級技能→Upwork 搜尋關鍵字/網址,貼擴充功能,同步 config.searchQueries)→ 🎯二·能力(硬篩)→ 📊三·評分+AI。
- **能力模型 = 可交付項目 + 邊界**(不是框架名+等級):每項 `{name, level 1-5, canDo, cantDo, keywords}`;另有 redlines(紅線)、scaleCeiling、searchKeywords。存 profile.json `capability`;線上無資料時 /me 自動帶入 profile.example.json 預設。
- **第二道門硬攔截(score.js)**:能力匹配改分級權重;**紅線/能力圈外 → SKIP + blocked=1**(不進 AI,省成本);**核心強命中(深度≥4)只標 ⚠️ 軟降 MAYBE 不硬擋**(修「順帶提一句 php/shopify 就誤殺」)。比對改 `wordHit` 整字(修 community→unity、javascript→java 子字串誤判)。
- **🤖 Agents 中控台(/agents)**:列出所有 agent 設定(Profile Agent 已證明能力、能力邊界、第一道門關鍵字、評分設定)+ 學到的東西(投標實績校正表)+ 內嵌聊天機器人。
- **4 個 agent 優化**:① triage/analyze/求職信都讀能力邊界(capabilityBrief,勝率反映深度)② **學習迴路**:outcome 統計「預測勝率 vs 真實」,≥5 案自動把校正餵回 triage ③ 求職信兩段式自我批改 ④ 投標策略結合勝率(低勝率建議略過/差異化)。
- **🎯 篩選問題作戰區**(/api/screening):提案頁貼完整 JD → 抽 Upwork screening questions → 逐題英文答案 + 對能力邊界判斷符不符合(硬門檻如「會不會 coding/24h 支援」)。
- **列表**:加「勝率排序」+ 🎯 中標率徽章配色(<40 紅/<60 黃/≥60 綠)。導覽列改膠囊按鈕。/profile 改名 🪪 Upwork Profile。
- **發布時間修正**:擴充功能其實有送 `postedAtIso`,改存絕對時間戳 `posted_at`,顯示依「現在」重算「X 前(台北 M/D HH:mm)」,不再凍結在「1 分鐘前」。
- **資料新鮮度**:評估頁標「提案數(抓取時)」+「資料抓取 X 前」,>3h 跳紅色警告(提案/面試是快照、會暴增,投標前去 Upwork 確認)。
- **即時重抓**:`/api/refresh-job` + `npm run refresh -- <id>`(本機 gstack 開即時頁→解析→推回雲端→重算→**自動補跑該案 AI 快篩**)+ 評估頁 🔄 按鈕 + `~/.claude/skills/upwork-refresh`。實測:提案 <5→50+、競爭分 100→0、AI 勝率 22%→6%。
- **DB 新欄位**:`blocked`、`posted_at`(自動遷移)。新增 `npm run rescore`(套能力邊界+回填 blocked)、`npm run refresh`。
- **INGEST_KEY 補上**(本機+伺服器,= 擴充功能那把);原本沒設 → ingest 全開放,現已保護。
- **官方 API 路徑備好等審核**:api-fetch 套用能力邊界+模式權重(API 案也走三道門)、posted_at 對齊 createdDateTime、加 `--detail` 探針;`UPWORK-API申請.md`(重審回信全文)。

### 未完成 / 下次起點
- **Upwork API**:申請被拒(profile 其實已符合),已寄重審回信,等 24h;過了把 Client ID/Secret 給 Claude → 接 API + `--detail` 探測篩選問題欄位。
- **screening questions 自動抓**:擴充功能(第三方)抓不到,只能手動貼完整 JD;API 過了再測能不能拿到。
- 學習迴路要**累積 ≥5 個投標 outcome** 才會啟用校正(記得每次投完去 ② 評估頁標結果)。
- 可做:一鍵批次刷新所有 APPLY 案的即時數據。

## 2026-05-27(大改版 session)

### 完成事項
- **Profile Agent**:抓 GitHub `Harry1667` → 歸納 proven capabilities(22 項)→ 寫回 profile.json + DB,評分作品契合加成,每週一 cron 刷新。
- **介面重構成 6 個獨立頁**:① 列表 → ② 評估 → ③ 提案 → ④ 溝通 ｜ 🧩 功能地圖 · 👤 檔案 · ⚖️ 評分。
- **三層 AI 漏斗**:規則粗篩 → **AI 快篩(OpenAI low,批次,自動於 ingest 後跑)** → 大分析(Claude,評估頁 iframe)。
- **AI 覆蓋**:案經 AI 後,卡片以 AI 分數/verdict/中標機率為準(ai_score/ai_verdict/ai_win)。
- **評分新手模式**(預設)+ **低 CP 雷案降級**(低預算+高競爭→略過)。
- **屬性標籤(母/子,連動功能地圖)**:母類別=功能地圖大類、子功能=功能地圖小功能;卡片顯示 + 列表三層篩選(大類/功能/適配)。
- **浮動 context-aware 聊天 agent**(右下角 💬,全頁面,知道在哪頁/看哪案;提案工作台:貼 apply→列欄位+草稿)。
- **提案頁**:求職信/近期經驗/profile highlights/報價(新手打折)/特殊要求偵測/貼上完整職缺 override。
- **投標結果記錄**(outcome 欄,學習迴路資料層,校正待數據)。
- **功能地圖工具分兩類**:📋 案子點名(忠於描述)vs 💡 AI 建議(典型技術棧)。
- **登入改 hdw-auth**(auth.twloop.com JWT cookie),取代 Basic Auth。
- **修的 bug**:callProxy 改非同步(修 AI 產生時凍結整站)、SQLite WAL+busy_timeout(修 database locked)、聊天泡泡安全渲染 markdown、功能掃描改背景(修 nginx 超時)、Upwork 連結改登入 app 格式。
- **Token 優化**:快篩批次 6→10、描述 1200→700、聊天上下文 25→15+近10則;proxy max_tokens 6000。

### 未完成 / 下次起點
- **要有 auth.twloop.com 帳號才能登入**(到 auth 後台建)。
- 功能地圖**母類別目前 3 個**(AI業務自動化/AI聊天機器人/電商);掃更多關鍵字可擴充。
- **學習迴路**:校正邏輯待投案累積結果後再做。
- aaPanel SSL 待申請(上 https 後 cookie 會自動加 Secure)。
- 官方 Upwork API key 被拒(需補 profile + 重審,非必要,擴充套件 feed 為主力)。

### 關鍵事實
- 部署:本機 git push → server `git reset --hard origin/main` + `pm2 restart upworkfilter-web`(port 3012)。
- 線上:http://upworkfilter.looptw.com(登入走 /login)。
- AI:ProxyCLI(cli.twloop.com gRPC);快篩 openai/low、其餘 claude。
