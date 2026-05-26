// `npm run login` — 開瀏覽器讓你登入一次,session 會永久存進 profile(登入指紋)
import { launch, isLoggedIn, saveState } from './browser.js';

async function main() {
  console.log('開啟瀏覽器…請在視窗裡登入 Upwork(含任何 email/驗證碼)。');
  const ctx = await launch({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await page.goto('https://www.upwork.com/ab/account-security/login', {
    waitUntil: 'domcontentloaded'
  });

  console.log('\n等你登入中… 登入成功進到 Find Work 後,這裡會自動偵測。');
  console.log('(最多等 5 分鐘;登好後不用關視窗,程式會自己收尾)\n');

  const deadline = Date.now() + 5 * 60 * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const url = page.url();
    if (!/login|account-security/i.test(url)) {
      ok = await isLoggedIn(page);
      if (ok) break;
    }
  }

  if (ok) {
    await saveState(ctx); // 匯出所有 cookie(含 session cookie)
    console.log('✅ 登入指紋已記住(已存 session/state.json)。之後直接 `npm run scrape` 不用再登入。');
  } else {
    console.log('⚠️ 5 分鐘內沒偵測到登入。請重跑 `npm run login`。');
  }
  await ctx.close();
}

main().catch((e) => {
  console.error('login 失敗:', e.message);
  process.exit(1);
});
