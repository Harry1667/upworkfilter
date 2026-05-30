# Niche 搜尋網址（給瀏覽器擴充 Upwork Job Scraper 用，2026-05-31）

擴充是排程監看型（每 X 分鐘自動跑），用你登入的 session 開 Upwork 分頁抓（不被 CF 擋）。
每個 search target 各有自己的 webhook → 為了少設幾次，把 12 條 niche 合併成 **4 條 OR 查詢**
（評分系統會再篩，所以查詢寬一點沒關係）。

## 4 條合併版（推薦：每條當一個 search target）

**① AI API / 聊天機器人 / 自動化**
```
https://www.upwork.com/nx/search/jobs/?q=%22OpenAI+API%22+OR+%22Claude+API%22+OR+%22AI+chatbot%22+OR+%22AI+automation%22&payment_verified=1&t=0%2C1&sort=recency
```
**② 爬蟲 / 解析**
```
https://www.upwork.com/nx/search/jobs/?q=%22web+scraping%22+OR+%22Playwright%22+OR+%22PDF+parser%22+OR+%22PDF+data+extraction%22+OR+%22email+parser%22&payment_verified=1&t=0%2C1&sort=recency
```
**③ 無代碼自動化**
```
https://www.upwork.com/nx/search/jobs/?q=%22n8n%22+OR+%22Make.com%22+OR+%22Zapier%22+OR+%22Google+Sheets+automation%22+OR+%22Apps+Script%22&payment_verified=1&t=0%2C1&sort=recency
```
**④ 小 bug 修復**
```
https://www.upwork.com/nx/search/jobs/?q=%22Next.js%22+%22bug+fix%22+OR+%22FastAPI%22+%22bug+fix%22+OR+%22Node.js%22+%22bug+fix%22&payment_verified=1&t=0%2C1&sort=recency
```

## 設定步驟（擴充 → Search + Webhook URLs）
1. 既有那個舊 target：把 Search URL 改成上面 ①，名字隨意改。webhook 不動（已設）。
2. 按「+ Add」3 次，分別貼 ②③④；每個都打開「Send to webhook」並貼上「跟 ① 同一個」webhook URL（從 ① 的欄位複製）。
3. 自動存檔（Auto-save on）。回 Dashboard 按「Run scrape now」。

webhook URL（已在你擴充裡）：`https://upworkfilter.looptw.com/api/ingest?key=<你的 INGEST_KEY>`
