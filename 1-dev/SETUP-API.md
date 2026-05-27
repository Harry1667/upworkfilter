# 官方 API 設定 + 排程(全自動,無 Cloudflare)

這是最安全、可無人值守的抓取方式。走 Upwork 官方 GraphQL API,不碰網頁、不碰反爬。

## 步驟 1:申請 API key

1. 登入 Upwork,到 **https://www.upwork.com/developer/keys/**
2. 建一個 API key(app),類型選可用 OAuth2 的。
3. **Redirect URI(回呼網址)填:** `http://localhost:3000/callback`
4. 拿到 **Client ID** 和 **Client Secret**。

> ⚠️ Upwork 近年對「職缺搜尋」API 權限審核較嚴,申請時把用途寫清楚(個人找案輔助)。
> 若被拒,改用瀏覽器擴充套件方案(同樣安全)。

## 步驟 2:填憑證

```bash
npm run api:auth      # 第一次會在 session/api-credentials.json 建範本
```
打開 `session/api-credentials.json`,填入 Client ID / Secret,存檔。

## 步驟 3:授權(一次)

```bash
npm run api:auth
```
- 會自動開授權頁,你按「同意」。
- 瀏覽器跳回 `localhost:3000/callback`,token 自動存進 `session/api-tokens.json`。
- 之後 token 過期會自動用 refresh_token 換新,不用再手動授權。

## 步驟 4:抓取

```bash
npm run api:fetch              # 抓 → 評分 → 進 DB
npm run api:fetch -- --raw     # 印出 API 原始回應(對照 schema 用)
npm run report                 # 看結果
npm run web                    # 或開網頁看
```

> 📌 **重要:** 我沒有你的憑證,無法實測 GraphQL。Upwork schema 偶爾會變。
> 第一次跑若報錯或抓到 0 筆,用 `--raw` 把原始回應貼給我,我幫你對照微調
> `src/api-fetch.js` 裡的 `QUERY` 與 `filter` 欄位(例如 `titleExpression`
> 可能要改成 `searchExpression` 或 `userQuery`)。

---

## 步驟 5:排程(無人值守自動跑)

### macOS — 用 launchd(推薦,開機常駐)

建立 `~/Library/LaunchAgents/com.upwork.jobfinder.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.upwork.jobfinder</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/Desktop/未命名檔案夾/upwork-job-finder && /usr/local/bin/node src/api-fetch.js >> session/cron.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
  </array>
</dict></plist>
```
> `node` 路徑用 `which node` 查;上面每天 09:00 與 18:00 各跑一次。

載入:
```bash
launchctl load ~/Library/LaunchAgents/com.upwork.jobfinder.plist
launchctl start com.upwork.jobfinder      # 立刻測一次
```
移除:`launchctl unload ~/Library/LaunchAgents/com.upwork.jobfinder.plist`

### Linux / 通用 — 用 cron

```bash
crontab -e
# 每天 9:00 和 18:00 抓一次
0 9,18 * * * cd ~/upwork-job-finder && /usr/bin/node src/api-fetch.js >> session/cron.log 2>&1
```

---

## 日常使用(設定完之後)

排程會自動把新案抓進 `jobs.db`。你只要:
```bash
npm run web        # 開網頁看值得投的案子
```
投完一個就在網頁勾「已投」。完全不用自己爬、不碰 Cloudflare。
