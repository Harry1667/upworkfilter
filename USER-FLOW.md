# 🚀 使用流程（從零到接到第一單）

> 線上：http://upworkfilter.looptw.com
> 9 步完整流程 + 每步該按什麼、看什麼、改什麼。

---

## ⚡ 一句話總覽

```
擴充功能抓案 → 列表頁篩 → 評估頁看分 → 提案頁產信 +
驗證 + 反思 → Submit → 投案追蹤 → 學到的存 Lessons → 越用越準
```

---

## 📋 流程 9 步

### Step 1：建好 Profile（首次只做一次）

去 **🪪 Upwork**（/profile）填：
- 姓名 / 定位 / 時薪 / 自介
- Skills（精準對應 Upwork 標籤）
- Portfolio（每個作品：名 / 描述 / 技術棧 / live URL）
- 求職信規則（你個人的禁用詞 / 偏好結構）

去 **🎯 能力**（/me）填：
- 紅線（絕不接的）
- 各 skill 深度（1-5）+ canDo / cantDo
- searchKeywords（第一道門用）

```bash
# 跑 Profile Agent 從 GitHub 自動抓 proven capabilities
npm run profile:agent
```

### Step 2：擴充功能抓案

裝 Chrome 擴充功能 → 設好：
- Webhook URL: `https://upworkfilter.looptw.com/api/ingest?key=<INGEST_KEY>`
- Search queries（從 /me 同步）
- 抓案頻率（建議 30 min）

### Step 3：① 列表頁篩

去 **① 列表**：
- 預設只看 🟢 值得投
- **🦴 撿漏模式** ← 新手必用！低提案 + 小預算 + 付款驗證
- 排序選「🥶 競爭最少」優先

### Step 4：② 評估頁深看

點任一案 → **② 評估**：
- 看 AI 評分 + 7 維分數
- 看「客戶端 4 訊號」（付款 / 評分 / hire rate / 花費）
- 提案數會過期 → 點「🔄 即時刷新」

**4 訊號紅燈 ≥ 2 個 → 直接跳過**

### Step 5：③ 提案頁產信（核心）

去 **③ 提案**：

**重要**：把 Upwork 案子頁的完整內容（**包含 Activity 段：Proposals X, Interviewing Y, Boost rankings**）貼進「描述」框，否則能見度算不準。

點 **「✨ 產生提案」**（30-60 秒）→ 出來這些區塊：

#### 🚦 能見度評分（最上方）
```
🚦 能見度: Proposals 50+ · Interviewing 11 · Boost 1st 200 · 評級:極低
新手不建議投,燒 Connects 無回報
```
**極低 → 直接關頁面省 Connects。** 不要為了寫過信就硬投。

#### 💲 報價 + 🎯 Connects 競標
```
💲 新手搶單價:$25/hr · 有評價後:$35
🎯 Connects 競標:建議 12 搶 2nd 名,1st 名 51 太貴
```

#### ✍️ 求職信
3 writer + 1 總編合成的版本。

下方 3 個信任度檢核：

##### 🔍 幻覺偵測
```
✅5 ⚠️3 🚨1 · 建議改掉 $50/hr
✅ AgentsHub multi-agent → provenCapabilities[2]
🚨 Rate $50/hr → profile 是 $20/hr
⚠️ 1+ year production → profile 沒提
```
**🚨 必改、⚠️ 自己判斷、✅ 放心**

##### 📚 Citation
```
I built AgentsHub[1] - multi-agent workspace[2].
Rate $25/hr[!]. Taiwan UTC+8[6].

[1] verified → provenCapabilities.AgentsHub
[!] contradicted → profile rate is $20
```
每句話旁的標記告訴你來源 / 風險。

##### 😈 Skeptic
```
HIGH - 開頭太業務感
「Ready to be your dedicated full-stack partner」
→ 改成具體點客戶痛點

MEDIUM - 結尾沒推進對話
→ 加一個專業的具體問題
```
**高 severity 必改、中可改可不改。**

### Step 6：複製貼上 + Submit

1. 點 **📋 複製** → 貼到 Upwork Cover Letter
2. 從 **📌 Profile highlights** 選 4 個
3. **rate / connects** 照 AI 建議
4. Submit

### Step 7：📊 建追蹤紀錄（重要！）

Submit 後**回提案頁**，點 **「✅ 我投了(建追蹤)」**：
- 輸入實際報價
- 輸入燒了幾個 Connects
- 自動存進投案追蹤

### Step 8：等 1-7 天 → 更新狀態

去 **📊 投案追蹤**：
- 收到 Upwork 通知有人看 → 改 **👁 已閱**
- 客戶回訊息 → **💬 有回**
- 進面試 → **🎤 面試**
- 中標 → **🎉 中標**
- 拒信 / 30 天沒回 → **❌ 拒絕** / **🕳 沒回**

### Step 9：🧠 從失敗學 Lesson

在 **📊 投案追蹤** 失敗的那筆：

1. **Notes 欄** 寫「為什麼這案沒中」（30+ 字越具體越好）
   範例：
   > 客戶在 Romania 但 JD 沒提時區限制，我也沒主動 highlight UTC+8 的優勢。可能因此被當成隨機投標。

2. 點 **🧠 按鈕** → AI 萃取 lesson 候選 → 確認後一鍵存

範例輸出：
```
1. [location] 客戶在歐洲時區時,cover letter 開頭就 highlight UTC+8 的時差優勢
2. [strategy] JD 沒提時區限制 ≠ 沒影響,要主動 frame 成優勢
```

3. 從此**所有 AI** 寫 cover letter 都會自動避開這個錯。

---

## 🔁 學習迴圈視覺化

```
投案 ─→ Skeptic 挑刺 ─→ 修改 ─→ Submit
  │                                 │
  │                                 ↓
  │                            📊 追蹤狀態
  │                                 │
  │                                 ↓
  │                          失敗 → Notes
  │                                 │
  │                                 ↓
  │                          🧠 AI 萃取
  │                                 │
  │                                 ↓
  └────── 📌 Lessons 注入下次 prompt
```

**每投 5 案就會明顯感覺「AI 不再犯同樣錯」**。

---

## 🆘 浮動聊天助手（任何頁面右下角 💬）

不知道怎麼辦的時候點開：
- 「這案我該投嗎？」
- 「幫我改 cover letter 第二段」
- 「為什麼這案沒回？」
- 「教我寫 Required Project 答案」

它內化了 9 步 SOP，會給你務實答案。多對話歷史會留著。

---

## 💡 新手前 10 案重點

1. **只投 🦴 撿漏單**（< 10 提案 + 預算 < $200）
2. **Rate 不要 < $15**（被當業餘）
3. **能見度 = 極低 直接不投**，省 Connects
4. **每案都建追蹤**，不然數據累積不到
5. **失敗一定要寫 Notes**，不然 Lessons 學不到東西
6. **抓到 AI 寫錯立刻去 📌 Lessons 加一條**
7. **目標：拿第一個 5★**，不是賺錢
8. **影片題必錄**，沒錄自動 disqualified
9. **誠實 > 自吹**，但選擇性誠實（別自爆 Preferred 等級弱點）
10. **送出就不回頭**，立刻投下一案

---

## 🛠️ 常用指令

```bash
# 本機開發
npm start              # 起伺服器 (port 3012)
npm run rescore        # 重算所有案的評分 + blocked
npm run refresh -- <id> # 即時重抓單案 (gstack)
npm run profile:agent  # 從 GitHub 抓 proven capabilities

# 部署
git add -A && git commit -m "..." && git push
# server pm2 自動拉
```

---

## 📂 重要檔案

```
upworkfilter/
├── 1-dev/
│   ├── 00-INDEX.md                  ← 文件索引
│   ├── 01-SOP-投案流程.md            ← 9 步 SOP 詳細版
│   ├── 02-Profile改造.md
│   ├── 02-Portfolio填寫.md
│   ├── 02-帳號分析.md
│   └── 03-Applications/             ← 每案一資料夾
│       ├── claude-fullstack/
│       └── cowork-ai-engineer/
└── upwork-job-finder/
    ├── README.md
    ├── USER-FLOW.md                 ← 本檔
    ├── profile.json                 ← 你的 Upwork 身分
    └── src/                         ← 程式
```
