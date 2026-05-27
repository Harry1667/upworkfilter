// `npm run features -- "chatbot" "voice assistant" …`
// 對每個關鍵字:收集同類案子描述 → AI 萃取「需要哪些功能」→ 合併進功能地圖。
// 不開發,只記錄功能。結果存 feature-taxonomy.json,用 npm run web 的 /features 頁檢視。
//
// ⚠️ 資料來源策略(與專案既有「能過 Cloudflare」的做法一致):
//   主來源 = jobs.db(擴充套件 ingest / seed 累積的完整描述,CF-safe、零爬取)
//   補抓   = gstack 指紋瀏覽器(能過 CF),只在 DB 案子不足時低頻取用
//   ❌ 不用 raw Playwright 直爬 — 那條路被 Cloudflare 互動檢測擋、量大會被封。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { askAI } from './analyze.js';
import { extractJson } from './assist.js';
import { loadTaxonomy, saveTaxonomy, extractPrompt, mergeBatch, toView } from './taxonomy.js';
import { openDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const BROWSE = path.join(os.homedir(), '.claude/skills/gstack/browse/dist/browse');
const ID_RE = /~([0-9a-f]+)/i;

// 功能掃描設定(沒設就給保守預設)
const FC = config.featureScan || {};
const MAX_JOBS = FC.maxJobsPerQuery ?? 12;       // 每個關鍵字最多用幾個案子餵 AI
const BATCH = FC.batchSize ?? 5;                  // 每幾個案子餵一次 AI(算功能出現頻率)
const MIN_DB_JOBS = FC.minDbJobs ?? 5;            // DB 少於這數才啟動 gstack 補抓
const GSTACK_LIMIT = FC.gstackFetchLimit ?? 8;    // 補抓上限(低量,降反爬風險)
const GSTACK_DELAY_S = FC.gstackDelaySeconds ?? 3; // 每筆間隔秒數(放慢)
const USE_GSTACK = FC.gstackSupplement !== false; // 預設啟用補抓

// ── gstack 指紋瀏覽器(能過 Cloudflare;沿用 enrich-gstack.js 的呼叫方式)──
function browse(args, t = 60000) {
  try { return execFileSync(BROWSE, args, { encoding: 'utf8', timeout: t, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
const gstackReady = () => existsSync(BROWSE);

function searchUrl(query) {
  const p = new URLSearchParams({ q: query });
  if (config.searchFilters?.sort) p.set('sort', config.searchFilters.sort);
  return `https://www.upwork.com/nx/search/jobs/?${p.toString()}`;
}

// 從目前頁面(搜尋結果)抽出 job tile 的 title/url。js 回 JSON,容錯解析;失敗退回 snapshot 抓 ~id。
function extractJobLinks() {
  const expr = 'JSON.stringify([...document.querySelectorAll(\'article a[href*="/jobs/"]\')].map(a=>({title:(a.innerText||"").trim(),url:a.href.split("?")[0]})))';
  const out = browse(['js', expr]);
  try {
    const a = out.indexOf('['), b = out.lastIndexOf(']');
    if (a >= 0 && b > a) {
      const arr = JSON.parse(out.slice(a, b + 1));
      if (Array.isArray(arr) && arr.length) return arr.filter((x) => x?.url && ID_RE.test(x.url));
    }
  } catch { /* 退回 snapshot regex */ }
  const snap = browse(['snapshot']);
  const seen = new Set();
  const links = [];
  for (const m of snap.matchAll(/https?:\/\/[^\s)\]]*\/jobs\/[^\s)\]]*~([0-9a-f]+)/gi)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    links.push({ title: '', url: m[0].split('?')[0] });
  }
  return links;
}

// 抓單一案子描述(snapshot 後清理;沿用 enrich-gstack.js 的清法)
function fetchDescription(url) {
  browse(['goto', url]);
  let snap = browse(['snapshot']);
  if (/Cloudflare Ray ID/i.test(snap) && snap.length < 800) { // 被擋 → 等一下重試一次
    try { execFileSync('sleep', [String(GSTACK_DELAY_S + 4)]); } catch {}
    browse(['goto', url]);
    snap = browse(['snapshot']);
  }
  if (/account-security\/login/i.test(snap)) throw new Error('gstack 未登入 Upwork');
  if (snap.length < 600) throw new Error('被擋或空白');
  return snap
    .replace(/^---.*$/gm, '')
    .replace(/@e\d+\s*\[[^\]]*\]\s*/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(0, 4000);
}

// 主來源:從 jobs.db 撈關鍵字相符、且有描述的案子
function jobsFromDb(query, limit) {
  try {
    const db = openDb();
    const words = query.split(/\s+(?:OR|AND)\s+|\s+/i).map((w) => w.trim()).filter((w) => w.length > 2);
    const rows = db.prepare('SELECT id, title, url, description FROM jobs WHERE description IS NOT NULL AND length(description) > 100').all();
    db.close?.();
    const hit = rows.filter((r) => {
      const hay = (r.title + ' ' + r.description).toLowerCase();
      return words.some((w) => hay.includes(w.toLowerCase()));
    });
    return hit.slice(0, limit);
  } catch {
    return [];
  }
}

// 補抓:用 gstack 從搜尋頁低頻取幾個新案的描述(排除 DB 已有的 id)
function supplementWithGstack(query, have, need) {
  if (!gstackReady()) { console.log('   ⚠️ 找不到 gstack browse,跳過補抓(先在主視窗跑 /open-gstack-browser)。'); return []; }
  console.log(`   🌐 gstack 補抓(目標 ${need} 筆,能過 CF、低頻)…`);
  browse(['connect']);
  browse(['goto', searchUrl(query)]);
  try { execFileSync('sleep', ['2']); } catch {}
  let probe = browse(['snapshot']);
  if (/Cloudflare Ray ID/i.test(probe) && probe.length < 800) {
    console.log('   ⏳ 撞到 Cloudflare,等 8 秒(必要時請在 gstack 視窗點過檢測)…');
    try { execFileSync('sleep', ['8']); } catch {}
    browse(['goto', searchUrl(query)]);
  }
  const links = extractJobLinks().filter((l) => {
    const id = l.url.match(ID_RE)?.[1];
    return id && !have.has(id);
  });
  const got = [];
  for (const l of links) {
    if (got.length >= need) break;
    const id = l.url.match(ID_RE)[1];
    try {
      const description = fetchDescription(l.url);
      got.push({ id, title: l.title || '', url: l.url, description });
      have.add(id);
      process.stdout.write('.');
    } catch (e) {
      if (/未登入/.test(e.message)) { console.log('\n   ⚠️ gstack 未登入 Upwork,停止補抓。'); break; }
      process.stdout.write('x');
    }
    try { execFileSync('sleep', [String(GSTACK_DELAY_S)]); } catch {} // 放慢,降反爬風險
  }
  if (got.length) process.stdout.write('\n');
  return got;
}

// 把一個關鍵字的案子分批餵 AI,合併進 taxonomy
async function scanQuery(tax, query, jobs) {
  if (!jobs.length) { console.log(`   ⚠️ 「${query}」沒有可用描述,略過。`); return; }
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
//   opts.noGstack: 強制只用 jobs.db(不補抓)
export async function scanFeatures(queries, opts = {}) {
  if (!queries?.length) throw new Error('請提供至少一個關鍵字');
  const allowGstack = USE_GSTACK && !opts.noGstack;
  const tax = loadTaxonomy();

  for (const query of queries) {
    console.log(`\n🔍 關鍵字:${query}`);
    const dbJobs = jobsFromDb(query, MAX_JOBS);
    console.log(`   📦 jobs.db 命中 ${dbJobs.length} 個案(主來源)`);
    let jobs = dbJobs;

    if (allowGstack && dbJobs.length < MIN_DB_JOBS) {
      const have = new Set(dbJobs.map((j) => j.id));
      const need = Math.min(GSTACK_LIMIT, MAX_JOBS - dbJobs.length);
      const fresh = supplementWithGstack(query, have, need);
      console.log(`   ➕ gstack 補到 ${fresh.length} 個新案`);
      jobs = [...dbJobs, ...fresh];
    } else if (dbJobs.length < MIN_DB_JOBS) {
      console.log('   (gstack 補抓已關閉;只用 jobs.db)');
    }

    await scanQuery(tax, query, jobs);
  }

  return toView(tax);
}

// CLI:npm run features -- "chatbot" "voice assistant"  [--no-gstack]
const _isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_isMain) {
  const args = process.argv.slice(2);
  const noGstack = args.includes('--no-gstack');
  const queries = args.filter((a) => !a.startsWith('-'));
  if (!queries.length) {
    console.error('用法:npm run features -- "chatbot" "voice assistant" [--no-gstack]');
    console.error('  每個關鍵字 = 一個大功能類別。主用 jobs.db,不足時用 gstack 低頻補抓。');
    process.exit(1);
  }
  scanFeatures(queries, { noGstack })
    .then((view) => {
      console.log(`\n✅ 完成。功能地圖:${view.length} 個大類`);
      for (const c of view) console.log(`   • ${c.name}(${c.jobCount} 案)→ ${c.features.length} 個功能`);
      console.log('\n   檢視:npm run web → 開 /features');
    })
    .catch((e) => { console.error('scan-features 失敗:', e.message); process.exit(1); });
}
