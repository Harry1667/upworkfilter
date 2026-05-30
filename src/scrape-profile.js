// `node src/scrape-profile.js` — 抓「客戶看到的」公開 profile 做轉換率體檢。
// 抓 viewMode=1（訪客視角）+ 一般公開頁,存 innerText + 截圖到 session/recon/。
import { launch, warmup, waitIfChallenged, isLoggedIn } from './browser.js';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'session', 'recon');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const log = (m) => console.log(`[scrape-profile] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FREELANCER = '~017e3d3f3145bf9bd3';
const TARGETS = [
  { slug: 'public-profile-viewmode', url: `https://www.upwork.com/freelancers/${FREELANCER}?viewMode=1` },
  { slug: 'public-profile', url: `https://www.upwork.com/freelancers/${FREELANCER}` }
];

async function capture(page, slug) {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await waitIfChallenged(page);
  await sleep(1500 + Math.random() * 1500);
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 250)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await sleep(1000);
  const data = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body.innerText || '' }))
    .catch((e) => ({ url: page.url(), title: '', text: 'ERR:' + e.message }));
  writeFileSync(path.join(OUT, `${slug}.txt`), `URL: ${data.url}\nTITLE: ${data.title}\n\n${data.text}`);
  await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: true }).catch(() => {});
  log(`✓ ${slug} — ${data.text.length} 字 → ${data.url}`);
  return data;
}

async function main() {
  log('開啟瀏覽器。若跳 Cloudflare,請在視窗點一下完成驗證。');
  const ctx = await launch({ headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await warmup(page);
  if (!(await isLoggedIn(page))) { log('⚠️ 未登入,部分欄位可能看不到,但公開頁仍試抓。'); }
  for (const t of TARGETS) {
    log(`→ ${t.url}`);
    await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await capture(page, t.slug);
    await sleep(2000 + Math.random() * 1500);
  }
  log('完成。輸出 session/recon/public-profile*.txt / .png');
  await ctx.close();
}
main().catch((e) => { console.error('[scrape-profile] 失敗:', e.stack || e.message); process.exit(1); });
