# Upwork API 金鑰 — 重審回信文件

金鑰:`9dda3f9ae5c32abb4d265a0953eac98b`
狀態:已建立但未啟用 → 需回信請 Upwork 重審(他們收到後約 24h 內重審)。

---

## ✅ 條件檢查(profile 已符合,不用再改)

- [x] 真實姓名:Po-Han Hua
- [x] 真人頭像:已上傳
- [x] 完整地址(含樓層):文山區育英街 85 號 2 樓, Taipei City 116, Taiwan
- [x] 電話:+886 933580232
- [ ] 用途說明清楚（← 這次重點，靠下面回信補上）
- [x] 不使用 Upwork logo / 品牌 / 商標

---

## 📧 直接複製這封，回覆給 Upwork（原信回覆 or Upwork Support）

Subject:
```
Re: API key 9dda3f9ae5c32abb4d265a0953eac98b — ready for re-review
```

Body:
```
Hi Upwork Team,

Thank you for the review notes. I've confirmed my account meets all the criteria:

1. Profile is complete:
   - Real name: Po-Han Hua
   - Full address incl. floor/unit: No. 85, 2F, Yuying St., Wenshan Dist.,
     Taipei City 116, Taiwan
   - A real profile portrait is uploaded

2. Purpose (internal / personal use only):
   This is a private, single-user tool for my own use as a freelancer on
   Upwork. It is read-only and authenticates via OAuth2 with my own account.
   It calls marketplaceJobPostingsSearch a few times a day to pull recent job
   postings that match my skills, stores them in my own private database, and
   helps ME decide which jobs to apply to and write better proposals. It is NOT
   a public product and will never be distributed to other users or resold.

3. I will keep usage well within reasonable limits — only a few scheduled runs
   per day, far below the 40K requests/day limit.

4. The application does not use the Upwork logo, brand name, colors, or any
   trademarked content (app name: "Personal Job-Search Assistant").

The key (9dda3f9ae5c32abb4d265a0953eac98b) is ready for re-review whenever
you're available. Thank you!

Best regards,
Po-Han Hua
```

---

## 📝 備用：申請表「用途說明」欄要填的內容（如果要重填表單）

```
Application name: Personal Job-Search Assistant (private, single-user)

Purpose:
A private tool for my own personal use only. It is NOT a public product and
will never be distributed or resold. As an Upwork freelancer, I use it to
organize and evaluate job postings that match my skills, so I can decide which
jobs to apply to and write better, more relevant proposals.

How it uses the API:
- Authenticates via OAuth2 with my own Upwork account.
- Calls marketplaceJobPostingsSearch a few times per day to pull recent
  postings matching my search terms, stored in my own private database.
- Strictly read-only. No posting, no messaging, no actions on behalf of others.

Usage type: Internal / personal only (single user — me).

Request volume:
Very low — roughly 2-4 scheduled runs per day, ~1-2 queries each, well under
the 40K/day limit.

Branding:
Does not use the Upwork logo, brand name, colors, or any trademarked content.
```

---

## 之後（金鑰啟用後）

API 路徑已備好（`posted_at` 已對齊 API 的 `createdDateTime`、能力邊界已套進評分、detail 探針已加）。拿到 key 後：

1. `npm run api:auth` → 填 Client ID / Secret → 授權一次。
2. `npm run api:fetch`（抓→評分→進 DB）；或 `npm run api:fetch -- --raw` 看搜尋原始回應。
3. 探測「篩選問題」是否在 API 裡：
   ```
   npm run api:fetch -- --detail <職缺ciphertext>
   ```
   把輸出貼給 Claude → 逐一打開 `src/api-fetch.js` 的 `QUERY_DETAIL` 候選欄位（additionalQuestions / questions / preferredQualifications）對齊 schema。
4. 第一次跑若報錯或 0 筆，用 `--raw` 輸出貼給 Claude 微調 `QUERY` / `filter` 欄位。
