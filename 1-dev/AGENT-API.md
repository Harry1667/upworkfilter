# 🤖 CLI AI 唯讀通道 (Agent Read API)

讓終端機裡的 AI agent（Claude / Codex / Gemini CLI）直接讀 upworkfilter 網站裡的案件 + 評分資料。
**唯讀**，不會改任何東西。建立於 2026-05-30。

## 開啟方式

在 `.env` 設一把金鑰：
```
AGENT_KEY=隨便一串夠長的隨機字串
```
沒設 → 通道關閉（所有 `/api/agent/read/*` 回 401）。

## 認證

帶 key 二選一：
- Header：`x-agent-key: <KEY>`
- Query：`?key=<KEY>`

本機 `NO_AUTH=1` 開發模式下不用 key 也能讀。

## 端點

| 端點 | 說明 |
|------|------|
| `GET /api/agent/read/summary` | 總覽：案件總數、各 verdict 數量、前 15 個「APPLY 且未投」的案 |
| `GET /api/agent/read/jobs` | 案件列表（精簡 JSON）。參數：`verdict=APPLY\|MAYBE\|SKIP`、`limit=N`(預設100/上限500)、`unapplied=1`、`exclude_blocked=1` |
| `GET /api/agent/read/job?id=<id>` | 單一案件完整詳情（含 description） |

verdict「以 AI 為準」：有 `ai_score` 就用 AI 快篩結果，否則用規則分。

## 範例

```bash
# 本機(對應 port 3012;線上換成 https://upworkfilter.looptw.com)
KEY=你的_AGENT_KEY

# 1) 快速掌握現況(給 AI 開場讀)
curl -s -H "x-agent-key: $KEY" http://localhost:3012/api/agent/read/summary

# 2) 拿「該投但還沒投」的案
curl -s "http://localhost:3012/api/agent/read/jobs?verdict=APPLY&unapplied=1&exclude_blocked=1&key=$KEY"

# 3) 看某個案的完整描述
curl -s "http://localhost:3012/api/agent/read/job?id=022059064752973156734&key=$KEY"
```

## 回傳 job 欄位

`id, title, url, verdict, score(0-10), total_score, ai_score, ai_win, reason, budget, proposals, payment_verified, client{spent,hire_rate,rating,jobs_posted}, experience_level, connects_required, posted_at, tags, category, blocked, applied, favorited`
（`/job` 另含 `description`）

## 安全

- 唯讀:只有 `GET`,不提供任何寫入/改 verdict 的 agent 端點。
- 金鑰比照 `INGEST_KEY` 模式,放 `.env`(不進版控)。
- 別把 `AGENT_KEY` 貼進聊天/commit。線上要用 HTTPS 帶 key。
