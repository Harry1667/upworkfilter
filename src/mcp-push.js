// Upwork 官方 MCP → 站台入庫。取代第三方擴充套件的批量來源。
// 流程:Claude Code 呼叫 upwork MCP 的 find_jobs(search / smart_search / get),把回應存成 JSON 檔,
//       本腳本把 MCP 欄位轉成 /api/ingest 認得的 key,POST 上站 → 走原本的評分 + AI 快篩。
// 用法:node src/mcp-push.js <回應.json> [更多.json...] [--dry]
//   --dry:只印轉換結果,不送出(對欄位用)
// 需求:.env 設 INGEST_KEY、REFRESH_URL(預設線上站)。
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* 沒有 .env 就用預設 */ }

const BASE = process.env.REFRESH_URL || 'http://upworkfilter.looptw.com';
const KEY = process.env.INGEST_KEY || '';

// MCP 的描述外層包了 <untrusted_participant_content> 標籤,剝掉只留正文
function cleanDesc(s) {
  return String(s || '').replace(/<\/?untrusted_participant_content>/g, '').trim();
}

// 去掉 MCP 加的 utm 追蹤參數,網址與擴充套件來源一致(ID 一樣才不會重複入庫)
function cleanUrl(u) {
  if (!u) return '';
  try { const x = new URL(u); x.search = ''; return x.toString(); } catch { return String(u); }
}

// 經驗等級統一成既有寫法(Entry level / Intermediate / Expert),score.js 才認得 Expert 閘
function normLevel(v) {
  const s = String(v || '').toLowerCase();
  if (s.startsWith('entry')) return 'Entry level';
  if (s.startsWith('inter')) return 'Intermediate';
  if (s.startsWith('expert')) return 'Expert';
  return v || undefined;
}

// get 回應的結構跟 search 列不同(標題/描述包在 data.marketplaceJobPosting 底下),攤平成同一種形狀
function flattenGet(r) {
  const p = r.data.marketplaceJobPosting;
  const t = p.contractTerms || {};
  const amt = t.fixedPriceContractTerms?.amount?.rawValue;
  const hr = t.hourlyContractTerms || {};
  return {
    id: p.id,
    url: p.url || r.url,
    title: p.content?.title,
    description: p.content?.description,
    experience_level: t.experienceLevel,
    job_type: /HOURLY/i.test(t.contractType) ? 'hourly' : 'fixed',
    budget: amt ? `$${amt}` : (hr.hourlyBudgetMin ? `$${hr.hourlyBudgetMin}-$${hr.hourlyBudgetMax}/hr` : ''),
    client_record: r.client_record,
    connects_cost: r.connects_cost,
    screening_questions: r.screening_questions
  };
}

// 一筆 MCP job(search / smart_search 的列,與 get 詳情合併後)→ ingest raw
export function fromMcp(j) {
  const c = j.client || {};
  const rec = j.client_record || {}; // 只有 get 才有:即時的雇用率/花費
  const exact = j.proposal_count; // Freelancer Plus 才有精確數,其他帳號只有級距
  let description = cleanDesc(j.description || j.description_snippet);
  if (j.screening_questions?.length) { // 篩選問題併進描述,提案頁的 AI 才看得到
    description += '\n\n篩選問題:\n' + j.screening_questions.map((q, i) => `${i + 1}. ${cleanDesc(q)}`).join('\n');
  }
  return {
    url: cleanUrl(j.url),
    id: j.id,
    title: j.title,
    description,
    skills: j.skills,
    experienceLevel: normLevel(j.experience_level),
    budget: j.budget || (j.job_type === 'hourly' ? 'Hourly' : ''),
    jobType: j.job_type,
    clientTotalSpent: rec.spend_total ?? c.total_spent,
    // 只有 search 列帶 verification_status;沒有就留空,別誤判成「未驗證」觸發死亡訊號
    paymentVerified: c.verification_status ? c.verification_status === 'VERIFIED' : undefined,
    proposals: exact != null ? `${exact} proposals` : j.proposals_tier,
    clientRating: rec.feedback_score ?? c.rating,
    reviews: rec.feedback_count ?? c.total_reviews,
    jobsPosted: rec.jobs_posted ?? c.total_posted_jobs,
    hireRate: rec.hire_rate_percent,
    connectsRequired: j.connects_cost ?? j.connect_price,
    postedAtIso: j.published_date || j.created_date,
    source: 'upwork-mcp'
  };
}

// 從一個檔案取出 jobs:接受 MCP 原始回應({jobs:[...]})、單筆 get 回應、或兩者混合的陣列
function loadJobs(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const items = Array.isArray(data) ? data : [data];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (Array.isArray(it.jobs)) out.push(...it.jobs);
    else if (it.data?.marketplaceJobPosting) out.push(flattenGet(it));
    else out.push(it);
  }
  return out.filter((j) => j && j.title && (j.url || j.id));
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('用法:node src/mcp-push.js <回應.json> [更多.json...] [--dry]');
    process.exit(1);
  }

  // 同一案可能出現在多個檔(smart_search / search / get),以 id 合併欄位:get 補上詳情,search 保留付款驗證等
  const byId = new Map();
  for (const f of files) {
    for (const j of loadJobs(f)) {
      const k = String(j.id || j.url);
      const merged = { ...(byId.get(k) || {}) };
      for (const [kk, v] of Object.entries(j)) if (v != null && v !== '') merged[kk] = v;
      byId.set(k, merged);
    }
  }
  const raws = [...byId.values()].map(fromMcp);
  console.log(`📦 讀到 ${raws.length} 筆(來自 ${files.length} 個檔)`);

  if (dry) { console.log(JSON.stringify(raws, null, 2)); return; }
  if (!KEY) console.warn('⚠️ .env 沒設 INGEST_KEY,站台若有設金鑰會回 401。');

  const res = await fetch(`${BASE}/api/ingest?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(raws)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`入庫失敗 HTTP ${res.status}:${text.slice(0, 300)}`);
  const out = JSON.parse(text);
  console.log(`✅ 入庫 ${out.ingested} 筆`);
  for (const r of out.results || []) console.log(`  ${r.verdict || '-'}\t${r.score ?? '-'}\t${r.title}`);
}

// 只有直接執行才跑 main;被 import(取 fromMcp)時不動作
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('❌', e.message); process.exit(1); });
}
