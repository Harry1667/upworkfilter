// `node src/scrape-me.js` — 用已登入 session 抓「我自己」的 Upwork 資料:
//   個人檔案 + 投過的提案清單 + 每個提案/案子詳情(含我當初寫的 cover letter)。
// 輸出到 session/recon/(已 gitignore,含個資不進版控)。每頁存 innerText + HTML + 截圖。
// 設計原則:不靠脆弱的逐欄位 selector,先把每頁原始文字/截圖整包抓下來,離線再讀。
import { launch, warmup, waitIfChallenged, isLoggedIn } from './browser.js';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'session', 'recon');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const log = (m) => console.log(`[scrape-me] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 把一頁的文字/HTML/截圖整包存檔,回傳擷取到的相關連結
async function capture(page, slug) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await waitIfChallenged(page);
  await sleep(1500 + Math.random() * 1500);
  // 滾到底觸發 lazy-load
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await sleep(800);

  const data = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && /\/(nx\/proposals|jobs\/~|freelancers\/~|nx\/freelancer-profile)/.test(h));
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText || '',
      links: [...new Set(links)]
    };
  }).catch((e) => ({ url: page.url(), title: '', text: 'ERR:' + e.message, links: [] }));

  writeFileSync(path.join(OUT, `${slug}.txt`), `URL: ${data.url}\nTITLE: ${data.title}\n\n${data.text}`);
  writeFileSync(path.join(OUT, `${slug}.links.json`), JSON.stringify(data.links, null, 2));
  await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: true }).catch(() => {});
  log(`✓ ${slug} — ${data.text.length} 字, ${data.links.length} 連結 → ${data.url}`);
  return data;
}

async function main() {
  log('開啟瀏覽器(可見視窗)。若跳 Cloudflare,請在視窗點一下完成驗證。');
  const ctx = await launch({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());

  await warmup(page);
  const ok = await isLoggedIn(page);
  if (!ok) {
    log('⚠️ 偵測到未登入(session 可能過期)。請先在這個視窗手動登入 Upwork,我等你 3 分鐘…');
    const deadline = Date.now() + 180000;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (!/login|account-security|signup/i.test(page.url())) {
        loggedIn = await isLoggedIn(page);
        if (loggedIn) break;
      }
    }
    if (!loggedIn) { log('❌ 還是沒登入,結束。請跑 `npm run login` 重新登入後再試。'); await ctx.close(); return; }
    log('✅ 已登入,繼續。');
  }

  const manifest = { capturedAt: new Date().toISOString(), pages: [], proposals: [] };

  // 1) 投過的提案清單(試多個候選路徑,Upwork 路由會變)
  const proposalListUrls = [
    'https://www.upwork.com/nx/proposals/',
    'https://www.upwork.com/nx/proposals/archived'
  ];
  const proposalLinks = new Set();
  for (let i = 0; i < proposalListUrls.length; i++) {
    log(`→ 提案清單 ${proposalListUrls[i]}`);
    await page.goto(proposalListUrls[i], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const d = await capture(page, `proposals-list-${i}`);
    manifest.pages.push({ slug: `proposals-list-${i}`, url: d.url, chars: d.text.length });
    d.links.filter((h) => /\/nx\/proposals\/[0-9~]/.test(h) || /\/jobs\/~/.test(h)).forEach((h) => proposalLinks.add(h));
  }

  // 2) 個人檔案(找 freelancer 連結,沒有就試設定頁)
  const profileCandidates = [
    'https://www.upwork.com/freelancers/settings/profile',
    'https://www.upwork.com/nx/freelancer-profile/'
  ];
  for (let i = 0; i < profileCandidates.length; i++) {
    log(`→ 個人檔案 ${profileCandidates[i]}`);
    await page.goto(profileCandidates[i], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const d = await capture(page, `profile-${i}`);
    manifest.pages.push({ slug: `profile-${i}`, url: d.url, chars: d.text.length });
    // 從檔案頁也可能撈到自己的 freelancers/~ 連結
    d.links.filter((h) => /\/freelancers\/~/.test(h)).forEach((h) => proposalLinks.add('PROFILE::' + h));
  }

  // 3) 逐個提案詳情(含我當初寫的 cover letter)
  const detailUrls = [...proposalLinks].filter((h) => !h.startsWith('PROFILE::')).slice(0, 25);
  log(`找到 ${proposalLinks.size} 個相關連結,抓前 ${detailUrls.length} 個提案詳情…`);
  for (let i = 0; i < detailUrls.length; i++) {
    const u = detailUrls[i].startsWith('http') ? detailUrls[i] : 'https://www.upwork.com' + detailUrls[i];
    log(`  → 提案 ${i + 1}/${detailUrls.length}: ${u}`);
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    const d = await capture(page, `proposal-${String(i + 1).padStart(2, '0')}`);
    manifest.proposals.push({ slug: `proposal-${String(i + 1).padStart(2, '0')}`, url: d.url, chars: d.text.length });
    await sleep(2000 + Math.random() * 2000); // 放慢,別觸發反爬
  }

  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`完成。輸出在 session/recon/(manifest.json + 各頁 .txt/.png)。提案 ${manifest.proposals.length} 筆。`);
  await ctx.close();
}

main().catch((e) => { console.error('[scrape-me] 失敗:', e.stack || e.message); process.exit(1); });
