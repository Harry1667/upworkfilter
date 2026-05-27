# SESSION NOTES

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
