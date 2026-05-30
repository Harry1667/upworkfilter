# First-Win Scoring — Validation Baseline (Step 0)

> 建立：2026-05-30 ｜ 對應 `TODO_FOR_CLAUDE.md` 的 Step 0。
> 目的：在改 `score.js`/`triage.js` 前，先用使用者 13 封真實提案中的代表案，
> 記錄「現況觀察訊號 → 期望 after 狀態 → 怎麼驗證」，當作 Step 1-5 的前後對比基準。
>
> ⚠️ 限制：這些案來自使用者**已投提案**（`session/recon/`），不一定在本機 `jobs.db` 裡。
> 欄位（experience_level / connects_required / posted_at）只在 enrich 後的案才有值；
> 未 enrich 的案這些是 null，依 CLAUDE.md 原則「抓不到的訊號不計」，不得誤殺。

## 系統現況（Step 1 前）

- `config.scoring.mode = "newbie"`，`threshold=60`、`maybeThreshold=45`，`rate={hourlyFloor:12, hourlyTarget:25, fixedFloor:80}`。
- 既有 can-win 邏輯（要強化、非重造）：
  - `deathSignals`：未付款驗證 / hire 0% / 提案50+ / 客戶未花過錢。newbie ≥2 → SKIP。
  - `competeSignals`：Expert 等級 / connects≥15 / 上限<底價。≥2 → SKIP，==1 → APPLY 降 MAYBE。
  - `blocked`：紅線/能力圈外硬擋。

## 四個代表案（reference cases）

| 案 | 標題 | 等級 | 預算 | 客戶 | 觀察訊號 | 期望 after |
|----|------|------|------|------|---------|-----------|
| proposal-04 | Claude Full-Stack (n8n,RN) | **Expert** | hourly $20 | $13K/44%hire/**125 jobs** | Expert + 超競爭 + 我 boost 13 connects | **🚫 不要 boost**；Expert→至少降 MAYBE |
| proposal-06 | Python Playwright | Inter | hourly | 印度 **0% hire**/0評價/新 | 客戶 0% hire（death）+ 我 boost 12 connects | **🚫 不要 boost**；客戶 death 訊號 |
| proposal-07 | Clinic Ops 平台 | **Expert** | $35-100/hr | 巴 **0% hire**/1案/**$0 spent** | Expert + hireZero + spentZero | **SKIP**（Expert + 死亡訊號） |
| proposal-09 | AI Agent 整合(onboarding email) | Inter | **$320 fixed** | $580/**100% hire**/2案 | 小而明確 + 好客戶 + 付款驗證 | **APPLY / 頂 MAYBE** + 🎯 第一單目標 |

## Step 1 期望規則（newbie 模式）

**強制 SKIP（hardWinBlocks）**：
- Expert/資深 + 提案 20-50 或 50+
- Expert/資深 + 客戶 hire 0%
- Expert/資深 + connects_required ≥ 12
- 提案 50+ 且（未付款驗證 / 花費 < $100 / connects ≥ 12）
- （hireZero + spentZero 已由既有 deathSignals ≥2 涵蓋，不重複）

**APPLY → MAYBE 軟降（單一中度訊號）**：
- Expert/資深 單獨
- 提案 20-50
- connects_required ≥ 12
- 大型 SaaS/平台 from scratch 無明確第一里程碑
- posted_at 可得且 > 24h

**第一單目標加分（isFirstReviewTarget）**：
- fixed $50-300（或時薪合理）+ 描述清楚 + 提案 <5/5-10 + 付款驗證 + (花費>0 或 hire>0) + 非 Expert/大型
- → total 小幅 +8 提升能見度 + reason 標 `🎯 第一單目標`；不得覆蓋紅線/能力圈外硬擋。

## 驗證結果（Step 5，2026-05-30 回填）

**✓ 全部通過**：
1. `node --check`：score.js / triage.js / web.js / assist.js / verify.js 全 OK。
2. `npm run rescore`（Node 26）：32 案跑通，12 案 blocked。verdict 分佈 **APPLY 3→0 / MAYBE 16→14 / SKIP 13→18**（閘門變嚴；APPLY 歸 0 因此 DB 幾乎全 Expert/Senior，全被正確降級 → 佐證搜尋詞要換到小自動化案）。
3. score.js 功能測試（4 recon 代表案，構造 job 物件）：p07→SKIP（死亡訊號）、p04 Expert+connects13→SKIP（hardWinBlock）、p04b Expert only→MAYBE+🚫不要boost、p09 $320 好客戶→APPLY+🎯第一單目標；回歸：正常全棧小案 $250→APPLY（未誤殺）、`isLargeScope("full-stack")`=false（修好誤判）。
4. web.js `NO_AUTH=1` smoke：`/` chip（17 不要boost/1 別投/2 第一單目標）、`/job`「賭一把」=0、`/proposal` 橫幅正確、HTTP 全 200。
5. 提案護欄（確定性 preflight，不靠 AI）：proposal-07（Style B）→ banned[vibe coder, perfect fit]+長度+無試做+無問題 **全攔**；proposal-01（Style A）→ banned 過關，仍抓出 >180字+缺試做（新標準更嚴，正確）。

**未跑（依計畫可略）**：live AI triage、live AI 生成 cover letter（需網路/API+花錢）。確定性層已保證 Style B 攔截。

**reference-only 限制**：p04/06/07/09 為構造案（recon 來自已投案，不一定在本機 jobs.db）。
