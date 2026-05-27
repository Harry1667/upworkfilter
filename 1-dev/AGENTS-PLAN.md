# Upwork Job Finder — Agents 規劃 + 專案交接文件

> 用途:讓新對話能無縫接續開發 agents。涵蓋現況、決策、agent 設計、技術限制、下一步。
> 最後更新:2026-05-27(✅ Profile Agent 已完成並驗證)

---

## ✅ 已完成:Profile Agent(2026-05-27)

- `src/agents/profile-agent.js`:抓 GitHub `Harry1667`(已確認,27 public repos)→ 排除 fork/archived,取最近更新前 24 個 → 抓 README(截斷 800 字)→ 分批(每批 6 個)餵 ProxyCLI 歸納「這證明我會什麼」+ 技術關鍵字 → 寫回 `profile.json`(`provenCapabilities` / `provenTechs` / `provenUpdatedAt` / `githubUser`)+ 存 DB 新表 `profile_capabilities`。
- 實測:產出 **22 項 proven capability、63 個技術關鍵字**。
- 評分作品契合:`score.js` 的 `scoreSkill` 新增 `provenTechs` 參數,案子文字命中「有 GitHub 證據」技術 → 每項 +10(上限 +30);`reason` 顯示 `✓作品:...`。實測 58→78。無 provenTechs 時行為不變(無回歸)。
- `web.js`:`loadConfig` 自動帶入 `profile.provenTechs`;新增 `POST /api/agent/profile`(跑 agent + `rescoreAll`);`/profile` 頁加「🤖 執行 Profile Agent」按鈕。
- `assist.js`:`profileBrief` 納入「已證明能力」;`advicePrompt` 新增 `screenshot`(建議附哪張作品截圖);求職信優先引用真實 repo。
- 觸發方式:`npm run agent:profile [-- <user>]` 或 dashboard 按鈕。可選 `GITHUB_TOKEN` env 提高 rate limit。
- **未做(下一步)**:server cron 每週自動跑(crontab call `curl -X POST .../api/agent/profile` 或 `npm run agent:profile`);部署到線上驗證。

---

## 0. 一句話現況

一套已上線的 Upwork 接案輔助系統:瀏覽器擴充套件抓真實職缺 → webhook 餵進雲端 → 7 維評分 → dashboard 顯示 + AI 求職信/建議/客戶回覆。**下一步:把「靜態評分」升級成「會用你 GitHub/作品集推理的 agent」。**

---

## 1. 專案位置與部署

| 項目 | 值 |
|------|-----|
| 本機 | `~/Documents/0-Dev/2-Project/upworkfilter/upwork-job-finder/` |
| GitHub | `https://github.com/Harry1667/upworkfilter`(public) |
| 線上網址 | `http://upworkfilter.looptw.com`(SSL 待 aaPanel 申請) |
| 伺服器 | Oracle `ubuntu@137.131.7.230`,SSH key `~/Documents/important file/ssh-key-2026-04-08.key`,進去 `sudo su` |
| 部署路徑 | `/www/wwwroot/upworkfilter.looptw.com` |
| Node | v22.22.2(`/www/server/nodejs/v22.22.2/bin/{node,npm,pm2}`) |
| 進程 | PM2 `upworkfilter-web`,**port 3012** |
| nginx | 反向代理在 extension 目錄 `proxy.conf` |
| 憑證 | 本機 `deploy-credentials.txt`(dashboard admin 密碼、INGEST_KEY)— 已 gitignore |

**更新部署流程:**
```bash
# 本機
git add -A && git commit -m "..." && git push
# 伺服器
ssh -i "~/Documents/important file/ssh-key-2026-04-08.key" ubuntu@137.131.7.230
sudo bash -c 'export PATH=/www/server/nodejs/v22.22.2/bin:$PATH
  cd /www/wwwroot/upworkfilter.looptw.com
  git fetch origin main && git reset --hard origin/main
  pm2 restart upworkfilter-web'
```

---

## 2. 現在的程式架構(已完成,可用)

```
src/
  web.js        HTTP 伺服器(無框架,Node 內建 http)+ 所有頁面與 API
  db.js         SQLite(node:sqlite)— jobs 表 + upsert + markApplied + allJobs
  score.js      7 維評分引擎(規則式,非 AI)
  analyze.js    產評估網站 + askAI()(proxycli 包裝,給其他 AI 功能重用)
  assist.js     讀 profile + 求職信/建議/回覆的 prompt
  proxy_sdk/    proxycli gRPC(proxy_call.py + aiproxy_pb2*.py + .proto)
  api-auth.js, api-fetch.js   Upwork 官方 API(OAuth2;API key 還在審核)
  scrape.js, browser.js, login.js, enrich-gstack.js, seed.js, report.js  本機抓取/工具
config.json     搜尋關鍵字、技能清單、7 維權重門檻、出價門檻
profile.json    你的檔案(gitignore;部署時 fallback 到 profile.example.json)
.env            proxycli token/project + dashboard 密碼 + INGEST_KEY(gitignore)
```

**現有頁面/API(都在 web.js):**
- `/` 案子列表(7 維評分卡 + 篩選)、`/settings` 評分權重、`/profile` 編輯檔案、`/reply` 客戶回覆助手
- `/analysis?id=` 檢視產出的評估網站
- `POST /api/ingest`(webhook,擴充套件餵案,CORS + INGEST_KEY)
- `POST /api/cover-letter | /api/advice | /api/reply | /api/analyze | /api/config | /api/profile | /api/mark`
- dashboard 用 Basic Auth;`/api/ingest` 用 INGEST_KEY

**資料來源(已驗證可行):**
- 主力:瀏覽器擴充套件 `richardadonnell/Upwork-Job-Scraper`(Chrome 商店)→ 在你真實 session 抓 → POST `/api/ingest`(CF 不擋)。payload:`{status,targetName,jobs:[{title,url,description,jobType,paymentVerified,proposals,clientTotalSpent,clientRating,skills[],uid...}],timestamp}`
- 擴充套件每 15 分自動跑(需 Chrome 開著)
- Upwork 官方 API:審核中,通過後 `npm run api:fetch`

---

## 3. 關鍵技術限制(影響 agent 設計,務必記住)

1. **ProxyCLI(hdw-proxycli)是 gRPC**(`cli.twloop.com:443`,不是 REST),且**單次請求 60 秒硬上限**(連串流都算)。
   → agent 多步推理要拆成「多個短呼叫」,每次輸出要小。產長 HTML 用「AI 回精簡 JSON → 本地渲染」。
   → 雲端已裝 `grpcio`+`protobuf`;`tier=fast` 最快。
2. **Upwork 反爬(Cloudflare)**:批量爬會被擋。只能靠擴充套件 feed 或一次性 gstack。**agent 不要狂爬 Upwork。**
3. **GitHub 有公開 API,免登入、不撞 CF** → 最適合給 agent 自動抓。
4. **成本**:每次 AI 呼叫都花 token → 深度 agent 只對「規則粗篩過關」的少數案跑。
5. 擴充套件只在 Chrome 開著時跑;dashboard/DB 在雲端 24h。

---

## 4. 已確認的需求(這次對話釐清的)

- **GitHub + 作品集要成為「適配度」的影響因子** —— 案子跟「你真正做過的東西」越吻合,適配度越高。
- 作品集也用於**求職信**:引用真實作品當證據 + 建議附哪張截圖。
- **不需要**「判斷你能不能交付」這種深度交付判斷(使用者明確說那不是重點)。
- 要做成**真正的 agent**(自主蒐集 + 推理 + 記憶 + 進化),不是只把資料塞進評分函式。

---

## 5. Agent 設計(完整藍圖)

### 🥇 優先做:Profile Agent(檔案代理)— 真 agent
- **目標**:自動建立並維護「你真正證明過的能力」
- **自動抓**:GitHub(public API:repo 語言/topics/README)→ 歸納「proven capabilities」(例:`已交付:FastAPI 爬蟲+排程、Next.js SaaS、Flutter OCR`);+ 使用者上傳的作品集
- **記憶**:存進 DB(新表 `profile_capabilities` 或寫回 profile.json)
- **進化**:每週自動刷新(GitHub 有新 code 就納入)→ 這是「agent」而非「一次性腳本」的關鍵
- **GitHub 帳號**:`Harry1667`(待確認)

### 🥈 配套:適配度評分加「作品契合」因子
- 在 `score.js` 加一個維度或加權:案子需求 ↔ proven capabilities 重疊度
- 有真實 repo 證據 → 適配度 ↑;只有口頭技能無實作 → 不灌水
- **設計選擇**:用規則(關鍵字比對 proven capabilities)便宜即時;或用 AI 推理(Scout)更準但花 token。建議「規則粗篩 + AI 深評過關者」混合。

### 後續可加(本次不做)
- **Proposal Agent**:研究客戶 → 選作品 → 草稿 → 自我批改 → 出 1-2 版 + 建議附件
- **Conversation Agent**:有記憶地陪跟客戶來回、抓風險(壓價/scope creep/詐騙/跳平台)
- **Coach Agent**:每週看投案/回應/贏率 → 給改進建議

### 技術做法
- proxycli 支援 **Function Calling**(`ai_tools`)→ agent 可「呼叫工具→看結果→再決定」
- 工具:讀/寫 DB、讀 profile、**GitHub API**、(有限)Upwork
- 自主型(Profile/Coach)掛 server cron;互動型(Proposal/Conversation)按需觸發
- 學習迴路:dashboard 標「已投/已回/已錄取」→ 餵回評分修正

---

## 6. 建議的下一步(新對話從這開始)

1. **做 Profile Agent**:
   - 寫 `src/agents/profile-agent.js`:抓 `Harry1667` 的 GitHub public repos(GitHub REST API,無需 token,或用使用者的 gh token 提高 rate limit)→ 對每個 repo 用 proxycli 歸納一句「這證明我會什麼」→ 匯總成 proven capabilities 存 DB/profile
   - 加 cron(server)每週跑;或先做手動 `npm run agent:profile`
2. **適配度加「作品契合」因子**:改 `score.js`,讀 proven capabilities,評分時加分
3. **求職信用 proven capabilities + 作品集**:`assist.js` 的 coverLetterPrompt 已用 portfolio,補上「建議附哪張截圖」
4. 部署(見第 1 節流程),在 `upworkfilter.looptw.com` 驗證
5. 測試:用真實 ingested 案子看適配度有沒有變準、求職信有沒有引用真實 repo

### 開新對話時可以說
> 「接續 upwork-job-finder 的 agents 開發,先做 Profile Agent 抓我的 GitHub(Harry1667)建立 proven capabilities,再把它加進適配度評分。專案在 ~/Desktop/未命名檔案夾/upwork-job-finder,已部署在 upworkfilter.looptw.com,細節看 AGENTS-PLAN.md」

---

## 7. 待辦雜項
- [ ] aaPanel 申請 SSL → 改用 https,webhook 也改 https
- [ ] /profile 補上作品集真實連結(目前 link 空)
- [x] 確認 GitHub 帳號 `Harry1667`(27 public repos)
- [x] 決定「作品契合」用規則 or AI → **採規則加成**(provenTechs 比對,便宜即時;capability 文字由 AI 一次性歸納)
- [x] 部署 Profile Agent 到線上(commit `ab84f44`,server 已跑出 22 項能力)
- [x] 設 server cron 每週自動刷新(root crontab `0 1 * * 1` UTC = 週一 09:00 台北;log 在 `profile-agent-cron.log`)
- [ ] 線上用真實 ingested 案子驗證適配度(看 `reason` 出現 `✓作品:`)與求職信引用真實 repo
