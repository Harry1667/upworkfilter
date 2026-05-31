# 系統文檔:識別與分析(現況 2026-05-31，commit 29c47f0)

> 這份記錄 upworkfilter 目前「怎麼識別一個案 + 怎麼分析」的完整邏輯。有問題下次照這份改。
> 北極星:幫**0 評價新 Upwork 帳號**最快接到**第一筆案**(不是技術上炫)。

---

## 0. 一句話

抓案進來 → **規則評分(免費,即時)** 篩出 APPLY/MAYBE/SKIP → **AI 快篩(便宜)** 補勝率、抓掛羊頭 → 列表以 AI 為準排序 → 想投的才花 AI 大分析 + 生提案。核心是「**擋掉燒 Connects 的案**」。

---

## 1. 資料流(漏斗)

```
來源(三種)
 ① 瀏覽器擴充 Upwork Job Scraper(排程每10分) → POST /api/ingest
 ② Quick Analyze 貼上 / bookmarklet → POST /api/quick-analyze(不寫DB)
 ③ npm run scrape(playwright)← 已知被 CF 擋,實務不用
        ↓
normalizeIngest(src/ingest.js):stripChrome 去頁面雜訊 → 統一 job 物件
        ↓
scoreJob(src/score.js):規則評分 → verdict + 7維 + reason + blocked
        ↓ (入庫 upsertJob)
autoTriageIngested → triageJobs(src/triage.js):便宜 AI 補 ai_score/ai_win/ai_verdict
        ↓
列表/評估頁:effectiveVerdict(有 AI 以 AI 為準) 排序顯示
        ↓ (使用者挑想投的)
大分析(analyze.js) + 提案生成(assist.js) + 信任度檢核(verify.js)
```

- **為什麼不靠伺服器直接抓 Upwork**:Cloudflare 硬擋自動化(scrape/profile 都試過)。資料一律來自「真人瀏覽器」(擴充 / 貼上 / bookmarklet)。
- CF 限制細節見對應 session note;搜尋詞見 `config.json` searchQueries(自動化/爬蟲/AI API 小案 niche)。

---

## 2. 識別 / 評分 — `src/score.js`(規則層,免費即時)

`scoreJob(job, config)` 回 `{ scores(7維), total_score, verdict, reason, blocked, matched_skills }`。

### 2.1 七維評分(各 0-100,加權成 total 0-100)
| 維 | 看什麼 |
|----|--------|
| reward 報酬 | 預算/時薪 vs 你的底價(hourlyFloor 12 / target 25 / fixedFloor 80);大範圍卻低預算→降。toNum 過濾 Infinity/NaN、倒置時薪正規化 |
| skill 能力 | 案文字 vs `profile.capability.skills`(分級)+ GitHub provenTechs 加成;紅線/能力圈外封頂 |
| client 客戶 | 付款驗證 + 花費 + 聘用率 + 評分(0% hire 扣分) |
| competition 競爭 | proposals_bucket 越少越高(<5=100 … 50+=0) |
| longterm 長期 | 轉長期/回頭客訊號 |
| clarity 清晰 | 描述長度 + deliverable/scope 字眼(已去 chrome,長度才真實) |
| risk 風險 | 從100扣:未付款/0花費/0%hire/預算矛盾/壓榨/跳平台詐騙 |

權重在 `config.scoring.criteria.*.weight`。total = 加權正規化。

### 2.2 判定順序(verdict cascade,由高到低優先)
`scoreJob` 依序判,**先命中先決定**:
1. **🚨 詐騙/違規硬擋(scamFlags)** → SKIP:跳出平台付款 / 加密貨幣**付款**(只在付款語境,不誤殺 crypto 題材)/ 股權分潤替代報酬 / 無償試做。
2. **🙅 非開發角色(isNonDevRole)** → SKIP + blocked:標題是招募/小編/行政/客服/業務/VA…(內文有 AI buzzword 也擋);標題有開發職稱(developer/engineer)則不算。
3. **💀 死亡訊號(deathSignals)** ≥2(新手)/≥3(標準) → SKIP:未付款驗證(明確=0才算,null不計)/ 0%hire / 提案50+ / 客戶0花費。
4. **雇用率0%(發≥3案)** → SKIP。
5. **🥊 新帳號硬擋(hardWinBlocks)** → SKIP:Expert/資深 ×(提案20-50/50+ ｜ 客戶0%hire ｜ connects≥connectsHot)；提案50+ 且(未驗證/花費<$100/高connects)。
6. **競爭可行性 competeSignals ≥2** → SKIP:Expert/資深、connects≥connectsHot、提案20-50、大型/長期無第一里程碑、貼出>24h、上限<底價。
7. lowPay+crowded → SKIP；lowPay+其他OK → MAYBE。
8. total≥threshold(60) → APPLY；≥maybeThreshold(45) → MAYBE；否則 SKIP。
- 之後再疊:第二道門(紅線硬擋/能力圈外→blocked)、competeSignals==1 → APPLY 降 MAYBE。
- **🎯 第一單目標(isFirstReviewTarget)**:小而明確好客戶的案(非Expert/大型/全職、付款驗證、提案<5或5-10、fixed $50-400或合理時薪、客戶有花費或聘用、描述≥200字、connects<connectsHot)→ verdict MAYBE 直接拉 **APPLY**(不偽造維度分,只調 verdict)+ reason 標 🎯。
- **🚫 不要 boost(connectsDiscipline)**:Expert/資深、提案20-50/50+、connects≥connectsHot、0%hire、未付款 → reason 標「不要 boost / 別投」。

### 2.3 關鍵防護(這次踩過的雷,別退回去)
- **stripChrome**:scraper 會把 Upwork footer「Enterprise Solutions」等抓進描述 → 污染 isLargeScope/clarity。已在 ingest 剝除。
- **isSeniorExpertJob**:信 Upwork 官方 `experience_level`;Entry/Intermediate 不被標題「Expert」(技能形容詞,如 "Flutter Expert Needed")誤判;但描述硬門檻(no beginners / previous Upwork history)仍擋。
- **isLargeScope**:enterprise 要「職缺語境」(enterprise client/grade/platform)才算,別命中 footer。
- **toNum**:connects/hire/budget 等可能是髒字串("13 Connects"/"$200 USD"/"0")→ 一律 toNum;`.toLowerCase()` 前一律 String() 包(防數字型欄位崩潰)。

---

## 3. AI 快篩 — `src/triage.js`(便宜模型,補規則層看不到的)

- 對 ai_score 為 null 且未 blocked 的案批次跑;回 `{id,score,win,verdict(強力接|可接|觀望|略過),reason,parent,tags}`。
- **新手勝率硬上限(prompt 內)**:未付款≤8% / 0%hire≤10% / 提案50+≤12% / 20-50≤25% / 花費<$100≤15% / Expert(或標題Senior)≤15%(但乾淨小Expert案放寬≤30%) / connects≥16再-10、≥18再-15 / 多條取最低再-5 / 完美組合才給50%+。
- **第一單友善訊號**:小而明確、1-3天可做、可小額試做 → score 偏高(win 仍受上限)。
- **🔒 winCapFor 事後夾**:程式端用規則硬上限再夾一次 win,**防 prompt injection** 把 win 灌成 99(職缺描述是不可信輸入)。
- `npm run` 無此指令;由 ingest 自動觸發,或 `node src/run-triage.js`(CLI 版,等同網頁「🤖 AI 快篩」鈕)。

---

## 4. 有效判定 — `effectiveVerdict(job)`(web.js)

- 有 `ai_score` + `ai_verdict` 且**非死亡訊號** → 以 AI 為準;否則用規則。
- 規則 SKIP 且 reason 含 💀/死亡/0%/紅線 → **死亡訊號蓋過 AI 樂觀**(AI 不能救)。
- 回 `{ verdict(顯示用:強力接/可接/觀望/略過 或 APPLY/MAYBE/SKIP), cls(正規化 APPLY/MAYBE/SKIP), score, isAi }`。
- **注意**:對外/程式比對一律用 `cls`(正規化);`verdict` 只是顯示標籤。(agent API 曾誤用 verdict 導致中英混、已修)

---

## 5. 提案生成 + 護欄 — `src/assist.js` / `src/verify.js`

- **3-writer + 總編合成**:Hook 派 / 誠實派 / JD鏡像派 各寫一版 → synth 挑各家最強段落合成。
- **最終結構(降風險式,鎖死)**:① hook **依案變化**(直接給解法/點JD漏掉細節/精準作品命中/結果導向,**禁每封都 "The core problem is"** 像AIbot) ② "I can help by:" 3個交付 ③ **一個**最相關作品+真實URL ④ 降風險:**fixed>$200** 提小額付費試做、**小案≤$200或時薪** 用「24-48h交付」(別對小案硬塞試做=沒讀預算) ⑤ 一個具體問題。預設 **120-180 字**(JD有To Apply清單/Required長答才放長)。
- **preflightCheck(verify.js)確定性檢核(不靠AI也攔得住)**:banned 詞(vibe coder/10x/perfect fit/passionate/cutting-edge/game-changer/I'm confident/top-rated/world-class/fortune 500,含 unicode×/零寬字元正規化)、長度、降風險(試做或快速交付,依預算)、結尾問題(剝URL再找?)。Style B(外部Gemini爛文)會被攔。

---

## 6. Quick Analyze(即時分析)— `/analyze` + `/api/quick-analyze`

- **用途**:不等擴充排程、不必先入庫,看到一個案馬上判 🟢衝/🟡考慮/🔴別浪費 + 風險旗標 + 勝率。
- **A 貼上**:`/analyze` 頁貼職缺 → POST `/api/quick-analyze`(規則,不寫DB)→ 紅綠燈+7維+connects。
- **B bookmarklet**:Upwork 職缺頁一鍵抓DOM → base64 塞 URL fragment → 開同源 `/analyze`(用登入session,避CF、免key)。
- **存列表**:`/api/quick-analyze/save`(登入)→ 回 id → 跳 `/job?id=` 看完整AI+提案(重用既有流程)。
- **安全**:fragment JSON.parse+白名單欄位+長度上限+textContent渲染(禁innerHTML)+讀完history.replaceState清掉;readBody 512KB上限;壞JSON→400;cookie SameSite=Lax防CSRF。
- 非開發/詐騙案在 quick-analyze 也一樣擋。

---

## 7. CLI AI 唯讀通道 — `/api/agent/read/*`(需 AGENT_KEY)

- 讓終端機 AI(Claude/Codex/Gemini CLI)curl 讀線上案+評分,不用 SSH 進DB。
- `GET /api/agent/read/{summary,jobs,job}`;`x-agent-key` header 或 `?key=`;唯讀。
- key 在伺服器 `.env` 的 `AGENT_KEY`(`cat .env|grep AGENT_KEY`);無key→401。
- verdict 用正規化 cls(APPLY/MAYBE/SKIP)+ 附 ai_label 原始判斷。文件:`1-dev/AGENT-API.md`。

---

## 8. 可調設定 — `config.json`

- `searchQueries`:抓案搜尋詞(現為自動化/爬蟲/AI API 小案 niche;同步到瀏覽器擴充)。
- `scoring.mode = "newbie"`、`threshold 60`、`maybeThreshold 45`。
- `scoring.connectsHot = 16`:投案需這麼多 Connects 才算「超熱門」而懲罰(2026 漲價,實測 9-24,可調)。
- `rate.hourlyFloor 12 / hourlyTarget 25 / fixedFloor 80`。
- `profile.json` title/skills 餵提案生成器(現定位:AI Automation & Web Scraping Developer)。

---

## 9. 已知限制 / 待辦

- 伺服器不能直接抓 Upwork(CF)→ 全靠瀏覽器來源。
- 擴充抓搜尋頁,**預算/客戶資料常缺**(顯示「?」)→ 規則分偏保守,AI 快篩 + 入庫後較準。
- `config.scoring.newbieWeights` 有定義但 `scoreJob` 實際用 `criteria.weight`(未接上,留評估)。
- web.js 既有 XSS(`${j.id}` 等)已用 jid() 安全化主要注入點;完整 security pass 可另跑 `/cso`。
- profile 公開頁無法自動抓(CF)→ 體檢走貼文字。
- 大分析(analyze.js)+ 提案生成需 AI proxy,只在部署伺服器運作(本機 proxy_call.py 不通)。

---

## 部署

`git push origin main` → SSH 伺服器 `git fetch origin main && git reset --hard origin/main && pm2 restart upworkfilter-web`(改評分要先 `npm run rescore`)。線上:https://upworkfilter.looptw.com 。詳見 `CLAUDE.md`。
