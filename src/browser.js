// 共用瀏覽器啟動 — 用「持久化 profile」記住登入指紋(cookies/localStorage)
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// 反偵測:patch navigator.webdriver、chrome runtime、permissions 等 → 過 Cloudflare
chromium.use(stealth());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = path.join(__dirname, '..', 'session', 'chrome-profile');
export const STATE_PATH = path.join(__dirname, '..', 'session', 'state.json');

// 沿用同一個 profile 目錄,並重新注入登入指紋(含 session cookie)→ 保持登入
export async function launch({ headless = false } = {}) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled']
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // 重新注入上次登入存下的 cookie(session cookie 不會留在 profile,故需這步)
  if (existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      if (state.cookies?.length) await context.addCookies(state.cookies);
    } catch {
      /* 壞檔就忽略,當作未登入 */
    }
  }
  return context;
}

// 登入成功後呼叫:把所有 cookie(含 session cookie)匯出存檔
export async function saveState(context) {
  await context.storageState({ path: STATE_PATH });
}

// 人類化暖機:先逛首頁拿 Cloudflare clearance,降低被擋機率
export async function warmup(page) {
  await page.bringToFront().catch(() => {}); // 把視窗叫到最前面
  await page.goto('https://www.upwork.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2500 + Math.random() * 1500);
  await waitIfChallenged(page);
}

// 判斷目前是不是 Cloudflare 的 human 檢測頁
export async function isChallenged(page) {
  try {
    const t = await page.evaluate(() => document.body.innerText || '');
    if (t.length < 400) return true; // 挑戰頁內容極短
    return /Cloudflare|Verify you are human|Just a moment|檢查您的瀏覽器|請稍候|Checking your browser|needs to review the security/i.test(t);
  } catch {
    return true;
  }
}

// 偵測到 CF 挑戰就暫停,等你在視窗裡點一下通過(最多等 maxWaitMs)
export async function waitIfChallenged(page, maxWaitMs = 150000) {
  if (!(await isChallenged(page))) return true;
  console.log('\n⚠️  Cloudflare human 檢測跳出來了!');
  console.log('   👉 請到瀏覽器視窗裡「點一下驗證框 / 完成檢測」,我會自動偵測並繼續。');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (!(await isChallenged(page))) {
      console.log('✅ 檢測通過,繼續。\n');
      await page.waitForTimeout(1500);
      return true;
    }
  }
  console.log('⏱️  等太久還沒通過,跳過這頁。');
  return false;
}

// 檢查是否已登入(看有沒有進到 Find Work / 個人選單)。冷啟動較慢,故重試。
export async function isLoggedIn(page) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto('https://www.upwork.com/nx/find-work/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000
      });
      // 等網路靜止或關鍵元素出現(最多 ~12 秒)
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      const url = page.url();
      if (/\/ab\/account-security\/login|\/login\b|\/signup/i.test(url)) return false;
      const text = await page.evaluate(() => document.body.innerText.slice(0, 6000));
      // 已登入訊號
      if (/Jobs you might like|Best Matches|My Proposals|Find Work|Saved jobs|Log out|Profile/i.test(text)) {
        return true;
      }
      // 未登入訊號(出現登入表單)
      if (/Log in to Upwork|Continue with Google|Welcome back/i.test(text)) return false;
      await page.waitForTimeout(3000); // 還沒確定,稍等再試一次
    } catch {
      await page.waitForTimeout(2000);
    }
  }
  return false;
}
