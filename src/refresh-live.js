// 本機即時重抓:用 gstack 指紋瀏覽器(已登入 Upwork)開單一職缺即時頁,
// 解析會變動的數據(提案數/面試數/客戶花費/評分/雇用率/發布時間),POST 回站台更新 + 重算。
// 用法:npm run refresh -- <jobId 或 完整 Upwork 網址>
// 需求:本機已跑過 /open-gstack-browser 並登入 Upwork;.env 設 INGEST_KEY、REFRESH_URL(預設線上站)。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { parseSpentUsd } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BROWSE = path.join(os.homedir(), '.claude/skills/gstack/browse/dist/browse');
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ignore */ }

const REFRESH_URL = process.env.REFRESH_URL || 'http://upworkfilter.looptw.com';
const KEY = process.env.INGEST_KEY || '';

// 把相對發布字串以「現在」回推成 ISO(本機重抓即視為剛看到)
function parseRelativePosted(str, anchorMs = Date.now()) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  if (/just now|seconds? ago|moments? ago/.test(s)) return new Date(anchorMs).toISOString();
  if (/yesterday/.test(s)) return new Date(anchorMs - 86400000).toISOString();
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/);
  if (!m) return null;
  const u = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
  return new Date(anchorMs - parseInt(m[1], 10) * u).toISOString();
}

function scrape(url) {
  if (!existsSync(BROWSE)) throw new Error('找不到 gstack browse,請先在主視窗跑 /open-gstack-browser 並登入 Upwork。');
  const run = (args, t = 60000) => {
    try { return execFileSync(BROWSE, args, { encoding: 'utf8', timeout: t, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return (e.stdout || '') + (e.stderr || ''); }
  };
  run(['connect']);
  run(['goto', url]);
  let snap = run(['snapshot']);
  if (/Cloudflare Ray ID/i.test(snap) && snap.length < 800) { execFileSync('sleep', ['8']); run(['goto', url]); snap = run(['snapshot']); }
  if (/account-security\/login/i.test(snap)) throw new Error('gstack 未登入 Upwork,請在 gstack 視窗登入後再試。');
  return snap;
}

// 從即時頁文字解析「會變動的欄位」
// gstack 快照是無障礙樹(含 @eNN 節點 id 與 [type] 標記)→ 先清掉避免 \d+ 誤抓到節點號(@e46→46)
function parseLive(raw) {
  const text = String(raw).replace(/@e\d+/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const live = {};
  const prop = text.match(/Proposals:[\s\S]{0,80}?(Less than \d+|Fewer than \d+|\d+\s*to\s*\d+|\d+\+|\d+)/i);
  if (prop) live.proposals_bucket = prop[1].replace(/\s+/g, ' ').trim();
  const intv = text.match(/Interviewing:?\s*(\d+)/i);
  if (intv) live.interviewing = parseInt(intv[1], 10);
  const hire = text.match(/(\d+)%\s*hire rate/i);
  if (hire) live.client_hire_rate = parseInt(hire[1], 10);
  const rating = text.match(/Rating is ([\d.]+) out of 5/i) || text.match(/\b([\d.]+)\s+of\s+\d+\s+reviews/i);
  if (rating) live.client_rating = parseFloat(rating[1]);
  const reviews = text.match(/of\s+(\d+)\s+reviews/i);
  if (reviews) live.client_reviews = parseInt(reviews[1], 10);
  const jp = text.match(/(\d+)\s+jobs?\s+posted/i);
  if (jp) live.client_jobs_posted = parseInt(jp[1], 10);
  const spent = text.match(/\$[\d.,KM]+\+?\s*total spent/i) || text.match(/\$[\d.,KM]+\+?\s*(?:total )?spent/i);
  if (spent) { live.client_spent_text = spent[0].replace(/\s*total/i, '').trim(); live.client_spent_usd = parseSpentUsd(spent[0]); }
  const posted = text.match(/Posted\s+([\w\s]+?\bago|yesterday|just now)/i);
  if (posted) { const iso = parseRelativePosted(posted[1]); if (iso) live.posted_at = iso; }
  return live;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('用法:npm run refresh -- <jobId 或 Upwork 網址>'); process.exit(1); }
  // 取完整數字 id(保留前導 0,Upwork ciphertext 常以 02… 開頭)
  const id = (String(arg).match(/(\d{15,})/) || [])[1] || String(arg).replace(/[^\d]/g, '');
  const url = /^https?:/.test(arg) ? arg : `https://www.upwork.com/jobs/~${id}/`;

  console.log('🌐 gstack 開即時頁:', url);
  const snap = scrape(url);
  const live = parseLive(snap);
  if (Object.keys(live).length === 0) { console.error('❌ 沒解析到即時數據(頁面可能被擋或格式變了)。'); process.exit(1); }
  console.log('📊 解析到即時數據:', JSON.stringify(live));

  const endpoint = `${REFRESH_URL.replace(/\/$/, '')}/api/refresh-job${KEY ? `?key=${KEY}` : ''}`;
  const r = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, live }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) { console.error('❌ 更新失敗:', r.status, JSON.stringify(j)); process.exit(1); }
  const ai = j.ai_score != null ? ` · AI ${j.ai_score}/10 勝率 ${j.ai_win ?? '?'}%` : '';
  console.log(`✅ 已更新並重算 → verdict=${j.verdict} 競爭分=${j.competition} 提案=${j.proposals_bucket}${ai}`);
  console.log(`   看結果:${REFRESH_URL}/job?id=${id}`);
}

main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
