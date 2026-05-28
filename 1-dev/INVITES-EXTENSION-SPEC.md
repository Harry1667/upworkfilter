# 擴充功能對接 ⑤ 邀請 — Spec

> 後端已上線 `POST /api/invites/ingest`,擴充功能 content script 抓 `upwork.com/nx/proposals/` 的 Invites 區塊 → 打這個 endpoint。

## Endpoint

```
POST https://upworkfilter.looptw.com/api/invites/ingest?key=<INGEST_KEY>
Content-Type: application/json
X-Ingest-Key: <INGEST_KEY>   ← 二選一(header 或 query)
```

回應:`{ ok: true, id: "..." }`

## Payload(JSON)

| 欄位 | 必填 | 型別 | 說明 |
|---|---|---|---|
| `id` | 否 | string | 邀請唯一 ID(建議用案件 ID 或 invite URL hash);沒給就後端用 title+raw_text 雜湊 |
| `title` | 建議 | string | 案件標題 |
| `url` | 建議 | string | 案件 URL(`https://www.upwork.com/jobs/~xxx`) |
| `job_id` | 否 | string | Upwork job ID(若已在 jobs 表) |
| `received_at` | 否 | ISO string | 收到時間絕對時間戳 |
| `received_text` | 否 | string | 顯示用相對時間("1 hour ago" 之類) |
| `client_spent_text` | 否 | string | `$59K spent` 之類原文 |
| `client_hires` | 否 | number | 客戶 hires 數(`4722`) |
| `client_payment_verified` | 否 | boolean | 付款驗證 |
| `client_invites_sent` | 否 | number | **重要**:此案已發多少邀請(>20=廣撒網) |
| `raw_text` | **必填** | string | 完整案件描述 + 邀請訊息(AI 分析用) |

## 抓取目標

URL: `https://www.upwork.com/nx/proposals/`
DOM 區塊:`Invites from clients (N)` section 下每張卡片。

每張卡片可抓到的欄位(對應上面的 payload):
- `title` ← 卡片連結文字
- `url` ← 卡片連結 href
- `received_text` ← `Received {date}` / `{N} hour ago`
- 客戶區塊 ← `$59K spent` / `4722 hires` / `Payment verified`

**raw_text 怎麼來?** 因為列表頁沒有完整 description,需要二段式抓:
1. 列表頁先送一筆只有基本欄位的 payload(`raw_text: title` 暫代)。
2. 使用者點進案件頁時,content script 再 POST 一次(同 id),補完整 `raw_text` 與 `client_invites_sent`(來自 "Invites sent: N" 欄位)。

後端的 `upsertInvite` 用 `COALESCE`,後送的欄位會覆蓋空欄位,不會把已填的清掉。

## 示範 content script(精簡版)

```js
// 列表頁:抓所有 Invites 卡片
(async () => {
  if (!location.pathname.startsWith('/nx/proposals')) return;
  const cards = document.querySelectorAll('[data-test*="invitation"]'); // 視實際 DOM 調整
  for (const card of cards) {
    const link = card.querySelector('a[href*="/jobs/~"]');
    if (!link) continue;
    const url = new URL(link.href, location.origin).href;
    const id = (url.match(/~(\w+)/) || [])[1] || url;
    const payload = {
      id,
      title: link.textContent.trim(),
      url,
      received_text: card.querySelector('[data-test*="received"]')?.textContent.trim(),
      client_spent_text: card.querySelector('[data-test*="spent"]')?.textContent.trim(),
      client_hires: parseInt(card.querySelector('[data-test*="hires"]')?.textContent) || null,
      client_payment_verified: !!card.querySelector('[data-test*="payment-verified"]'),
      raw_text: link.textContent.trim()  // 先暫代,點進案件頁再補
    };
    await fetch('https://upworkfilter.looptw.com/api/invites/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
      body: JSON.stringify(payload)
    });
  }
})();

// 案件頁:補 raw_text + invites_sent
(async () => {
  const m = location.pathname.match(/\/jobs\/~(\w+)/);
  if (!m) return;
  const id = m[1];
  const description = document.querySelector('[data-test="job-description"]')?.innerText || '';
  const invitesSentEl = [...document.querySelectorAll('*')].find((el) => /invites sent/i.test(el.textContent));
  const invites_sent = parseInt(invitesSentEl?.textContent.match(/\d+/)?.[0]) || null;
  await fetch('https://upworkfilter.looptw.com/api/invites/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
    body: JSON.stringify({ id, raw_text: description, client_invites_sent: invites_sent })
  });
})();
```

## 後端流程

1. `ingest` 進 `invites` 表(status=`new`)。
2. 使用者開 `/invites` → 看到列表,點進 `/invite?id=xxx`。
3. 按「✨ 立刻分析」→ `POST /api/invites/analyze` → 跑 `invitePrompt` → AI 三層評判存回 DB。
4. 按「📦 Archive」→ status=`archived`,列表變灰。

## 不在本 repo 的部分

擴充功能代碼不在 `upwork-job-finder/`(跟 jobs 用同一個擴充功能,參照 `/api/ingest` 的實作位置)。把上面 content script 加進擴充功能後即可。
