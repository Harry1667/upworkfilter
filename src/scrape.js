// `npm run scrape` — 爬取 Upwork 搜尋結果 → 抓客戶數據 → 評分 → 存 SQLite
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launch, isLoggedIn, warmup, waitIfChallenged } from './browser.js';
import { openDb, upsertJob } from './db.js';
import { scoreJob, parseSpentUsd } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const ID_RE = /~([0-9a-f]+)/i;

function buildSearchUrl(query) {
  const f = config.searchFilters;
  const p = new URLSearchParams();
  p.set('q', query);
  if (f.paymentVerifiedOnly) p.set('payment_verified', '1');
  if (f.jobType) p.set('t', f.jobType);
  if (f.sort) p.set('sort', f.sort);
  return `https://www.upwork.com/nx/search/jobs/?${p.toString()}`;
}

// 在頁面內抽出每個 job tile 的基本欄位
async function extractTiles(page) {
  return page.evaluate(() => {
    const out = [];
    for (const a of document.querySelectorAll('article')) {
      const link = a.querySelector('a[href*="/jobs/"]');
      if (!link) continue;
      const txt = a.innerText || '';
      const pm = txt.match(/Payment (verified|unverified)/i);
      const pr = txt.match(/Proposals:?\s*([^\n]+)/i);
      const sp = txt.match(/\$[\d.,KM]+\+?\s*(?:total )?spent/i);
      const bd = txt.match(/(Hourly:\s*[^\n]+|Est\.?\s*[Bb]udget:\s*[^\n]+|Fixed[- ]price)/i);
      out.push({
        title: link.innerText.trim(),
        url: link.href.split('?')[0],
        payment: pm ? pm[1].toLowerCase() : null,
        proposals: pr ? pr[1].trim() : null,
        spent: sp ? sp[0].replace(/\s+/g, ' ') : null,
        budget: bd ? bd[1].trim() : null
      });
    }
    return out;
  });
}

function parseBudget(text) {
  if (!text) return { budget_type: 'unknown' };
  if (/fixed/i.test(text)) {
    const m = text.match(/\$\s*([\d.,]+)/);
    return { budget_type: 'fixed', budget_text: text, fixed_budget: m ? parseFloat(m[1].replace(/,/g, '')) : null };
  }
  if (/hourly/i.test(text)) {
    const nums = [...text.matchAll(/\$\s*([\d.,]+)/g)].map((m) => parseFloat(m[1].replace(/,/g, '')));
    return {
      budget_type: 'hourly',
      budget_text: text,
      hourly_min: nums[0] ?? null,
      hourly_max: nums[1] ?? nums[0] ?? null
    };
  }
  return { budget_type: 'unknown', budget_text: text };
}

// 進案子詳情頁,抓客戶花費/雇用率/評分/描述(列表頁拿不到的)
async function enrich(page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await waitIfChallenged(page); // 詳情頁也可能被擋
  const data = await page.evaluate(() => document.body.innerText);

  const hire = data.match(/(\d+)%\s*hire rate/i);
  const rating = data.match(/Rating is ([\d.]+) out of 5/i);
  const reviews = data.match(/([\d.]+) of (\d+) reviews/i);
  const jobsPosted = data.match(/(\d+)\s+jobs? posted/i);
  const spent = data.match(/\$[\d.,KM]+\+?\s*(?:total )?spent/i);
  const descEl = await page.evaluate(() => {
    const p = document.querySelector('[data-test="Description"], [class*="description"], section');
    return p ? p.innerText.slice(0, 4000) : document.body.innerText.slice(0, 4000);
  });

  if (hire) job.client_hire_rate = parseInt(hire[1], 10);
  if (rating) job.client_rating = parseFloat(rating[1]);
  if (reviews) job.client_reviews = parseInt(reviews[2], 10);
  if (jobsPosted) job.client_jobs_posted = parseInt(jobsPosted[1], 10);
  if (spent && !job.client_spent_text) {
    job.client_spent_text = spent[0];
    job.client_spent_usd = parseSpentUsd(spent[0]);
  }
  job.description = descEl;
  job.enriched = true;
  return job;
}

async function main() {
  const db = openDb();
  const ctx = await launch({ headless: config.scrape.headless });
  const page = ctx.pages()[0] || (await ctx.newPage());

  if (!(await isLoggedIn(page))) {
    console.error('⚠️ 尚未登入。請先跑:npm run login');
    await ctx.close();
    process.exit(1);
  }
  console.log('✅ 已登入,開始爬取…\n');
  await warmup(page); // 先逛首頁,降低 Cloudflare 攔截

  const seen = new Map();
  // 第一輪:跑每個搜尋,收集列表頁基本資料
  for (const q of config.searchQueries) {
    const url = buildSearchUrl(q);
    console.log(`🔍 搜尋:${q}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000 + Math.random() * 1500);
      await waitIfChallenged(page); // CF 跳出來就等你點過
      const tiles = await extractTiles(page);
      let added = 0;
      for (const t of tiles.slice(0, config.scrape.maxJobsPerQuery)) {
        const idm = t.url.match(ID_RE);
        if (!idm) continue;
        const id = idm[1];
        if (seen.has(id)) continue;
        const job = {
          id,
          title: t.title,
          url: t.url,
          payment_verified: t.payment === 'verified',
          proposals_bucket: t.proposals,
          client_spent_text: t.spent,
          client_spent_usd: parseSpentUsd(t.spent),
          ...parseBudget(t.budget)
        };
        seen.set(id, job);
        added++;
      }
      console.log(`   +${added} 個新案(累積 ${seen.size})`);
    } catch (e) {
      console.warn(`   搜尋失敗:${e.message}`);
    }
  }

  // 第二輪:挑值得細看的(已驗證 + 提案非 50+)進詳情頁抓客戶數據
  const candidates = [...seen.values()]
    .filter((j) => j.payment_verified && !/50/.test(j.proposals_bucket || ''))
    .slice(0, config.scrape.enrichTopN);
  console.log(`\n📄 抓 ${candidates.length} 個候選的客戶數據(詳情頁)…`);
  for (const job of candidates) {
    try {
      await enrich(page, job);
      process.stdout.write('.');
      await page.waitForTimeout(config.scrape.delayMsBetweenDetails);
    } catch (e) {
      process.stdout.write('x');
    }
  }
  console.log('');

  // 評分 + 入庫
  let apply = 0, maybe = 0, skip = 0;
  for (const job of seen.values()) {
    const s = scoreJob(job, config);
    Object.assign(job, s);
    upsertJob(db, job);
    if (s.verdict === 'APPLY') apply++;
    else if (s.verdict === 'MAYBE') maybe++;
    else skip++;
  }

  console.log(`\n✅ 完成。共 ${seen.size} 案 → 值得投 ${apply}、可考慮 ${maybe}、排除 ${skip}`);
  console.log('   看報表:npm run report');
  await ctx.close();
  db.close?.();
}

main().catch((e) => {
  console.error('scrape 失敗:', e.message);
  process.exit(1);
});
