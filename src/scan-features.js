// `npm run features -- "chatbot" "voice assistant" …`
// 對每個關鍵字:爬 Upwork 同類案子 → 抓描述 → AI 萃取「需要哪些功能」→ 合併進功能地圖
// 不開發,只記錄功能。結果存 feature-taxonomy.json,用 npm run web 的 /features 頁檢視。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launch, isLoggedIn, warmup, waitIfChallenged } from './browser.js';
import { askAI } from './analyze.js';
import { extractJson } from './assist.js';
import { loadTaxonomy, saveTaxonomy, extractPrompt, mergeBatch, toView } from './taxonomy.js';
import { openDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const ID_RE = /~([0-9a-f]+)/i;

// 功能掃描專屬設定(沒設就給保守預設)
const FC = config.featureScan || {};
const MAX_JOBS = FC.maxJobsPerQuery ?? 12; // 每個關鍵字最多看幾個案子
const BATCH = FC.batchSize ?? 5;           // 每幾個案子餵一次 AI(算 frequency)
const DELAY = FC.delayMsBetweenDetails ?? 2000;

function searchUrl(query) {
  const p = new URLSearchParams({ q: query });
  if (config.searchFilters?.sort) p.set('sort', config.searchFilters.sort);
  return `https://www.upwork.com/nx/search/jobs/?${p.toString()}`;
}

async function extractTiles(page) {
  return page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('article')) {
      const link = a.querySelector('a[href*="/jobs/"]');
      if (link) out.push({ title: link.innerText.trim(), url: link.href.split('?')[0] });
    }
    return out;
  });
}

// 進詳情頁抓工作描述(功能萃取只需要描述,不需客戶數據)
async function fetchDescription(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  await waitIfChallenged(page);
  return page.evaluate(() => {
    const el = document.querySelector('[data-test="Description"], [class*="description"], section');
    return (el ? el.innerText : document.body.innerText).slice(0, 4000);
  });
}

// 退路:沒登入/爬不到時,從 jobs.db 既有描述撈同關鍵字的案子
function jobsFromDb(query) {
  try {
    const db = openDb();
    const words = query.split(/\s+(?:OR|AND)\s+|\s+/i).map((w) => w.trim()).filter((w) => w.length > 2);
    const rows = db.prepare('SELECT id, title, url, description FROM jobs WHERE description IS NOT NULL AND length(description) > 100').all();
    db.close?.();
    const hit = rows.filter((r) => {
      const hay = (r.title + ' ' + r.description).toLowerCase();
      return words.some((w) => hay.includes(w.toLowerCase()));
    });
    return hit.slice(0, MAX_JOBS);
  } catch {
    return [];
  }
}

// 把一個關鍵字的案子分批餵 AI,合併進 taxonomy
async function scanQuery(tax, query, jobs) {
  if (!jobs.length) { console.log(`   ⚠️ 「${query}」沒抓到可用描述,略過。`); return; }
  console.log(`   🧠 AI 萃取功能(${jobs.length} 案,分 ${Math.ceil(jobs.length / BATCH)} 批)…`);
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    try {
      const data = extractJson(await askAI(extractPrompt(query, batch)));
      const cat = mergeBatch(tax, query, data, batch);
      saveTaxonomy(tax); // 每批存一次,中途失敗也不白做
      process.stdout.write(`   ✓ ${cat.name}:累積 ${Object.keys(cat.features).length} 個功能\n`);
    } catch (e) {
      console.warn(`   ✗ 批次萃取失敗:${e.message}`);
    }
  }
}

// 可程式呼叫(web.js 的 /api/scan-features 也用這個)→ 回傳功能地圖檢視
export async function scanFeatures(queries) {
  if (!queries?.length) throw new Error('請提供至少一個關鍵字');
  const tax = loadTaxonomy();

  const ctx = await launch({ headless: config.scrape?.headless ?? false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const loggedIn = await isLoggedIn(page);
  if (loggedIn) await warmup(page);
  else console.log('⚠️ 未登入,改用 jobs.db 既有描述(先跑 npm run login 可改用即時爬取)。\n');

  for (const query of queries) {
    console.log(`\n🔍 關鍵字:${query}`);
    let jobs = [];
    if (loggedIn) {
      try {
        await page.goto(searchUrl(query), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2500 + Math.random() * 1200);
        await waitIfChallenged(page);
        const tiles = (await extractTiles(page))
          .filter((t) => ID_RE.test(t.url))
          .slice(0, MAX_JOBS);
        console.log(`   找到 ${tiles.length} 個案,抓描述中…`);
        for (const t of tiles) {
          try {
            const description = await fetchDescription(page, t.url);
            jobs.push({ id: t.url.match(ID_RE)[1], title: t.title, url: t.url, description });
            process.stdout.write('.');
            await page.waitForTimeout(DELAY);
          } catch { process.stdout.write('x'); }
        }
        process.stdout.write('\n');
      } catch (e) {
        console.warn(`   爬取失敗:${e.message},改用 jobs.db。`);
      }
    }
    if (!jobs.length) jobs = jobsFromDb(query);
    await scanQuery(tax, query, jobs);
  }

  await ctx.close();
  return toView(tax);
}

// CLI:npm run features -- "chatbot" "voice assistant"
const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain) {
  const queries = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (!queries.length) {
    console.error('用法:npm run features -- "chatbot" "voice assistant"');
    console.error('  (每個關鍵字 = 一個大功能類別,系統會去爬同類案子歸納小功能)');
    process.exit(1);
  }
  scanFeatures(queries)
    .then((view) => {
      console.log(`\n✅ 完成。功能地圖:${view.length} 個大類`);
      for (const c of view) console.log(`   • ${c.name}(${c.jobCount} 案)→ ${c.features.length} 個功能`);
      console.log('\n   檢視:npm run web → 開 /features');
    })
    .catch((e) => { console.error('scan-features 失敗:', e.message); process.exit(1); });
}
