// `npm run api:fetch` — 用 Upwork 官方 GraphQL API 抓職缺 → 評分 → 進 DB(全自動,無 Cloudflare)
// 可掛 cron 排程,無人值守。加 `--raw` 印出原始回應方便對照 schema 微調。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, upsertJob } from './db.js';
import { scoreJob } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const SESSION_DIR = path.join(__dirname, '..', 'session');
const CRED_PATH = path.join(SESSION_DIR, 'api-credentials.json');
const TOKEN_PATH = path.join(SESSION_DIR, 'api-tokens.json');

const TOKEN_URL = 'https://www.upwork.com/api/v3/oauth2/token';
const GRAPHQL_URL = 'https://api.upwork.com/graphql';
const RAW = process.argv.includes('--raw');

// ── token 管理:過期自動用 refresh_token 換新 ──────────────────────────────
async function getAccessToken() {
  if (!existsSync(TOKEN_PATH)) throw new Error('尚未授權。先跑:npm run api:auth');
  const t = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  if (t.expires_at && Date.now() < t.expires_at) return t.access_token;

  // 過期 → refresh
  const creds = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`refresh 失敗 ${r.status}: ${await r.text()}。請重跑 npm run api:auth`);
  const nt = await r.json();
  nt.expires_at = Date.now() + (nt.expires_in ? nt.expires_in * 1000 : 86400000) - 60000;
  if (!nt.refresh_token) nt.refresh_token = t.refresh_token;
  writeFileSync(TOKEN_PATH, JSON.stringify(nt, null, 2));
  return nt.access_token;
}

// ── GraphQL 查詢(欄位以官方 schema 為準;拿到 API 後用 --raw 對照微調)──────
const QUERY = `
query SearchJobs($filter: MarketplaceJobPostingsSearchFilter, $pagination: PaginationInput) {
  marketplaceJobPostingsSearch(
    marketplaceJobPostingsSearchFilter: $filter
    searchType: USER_JOBS_SEARCH
    sortAttributes: [{ field: RECENCY }]
    pagination: $pagination
  ) {
    totalCount
    edges {
      node {
        id
        ciphertext
        title
        description
        createdDateTime
        totalApplicants
        amount { rawValue currency }
        hourlyBudgetMin { rawValue }
        hourlyBudgetMax { rawValue }
        job { contractTerms { contractType } }
        client {
          totalSpent { rawValue }
          totalHires
          totalPostedJobs
          totalReviews
          totalFeedback
          verificationStatus
        }
      }
    }
  }
}`;

async function gql(token, query, variables) {
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (RAW) console.log(JSON.stringify(json, null, 2));
  if (json.errors) throw new Error('GraphQL 錯誤:' + JSON.stringify(json.errors));
  return json.data;
}

// ── 把 API node 轉成我們的 job 物件(防禦性:欄位缺就給 null)──────────────
function mapNode(n) {
  const id = n.ciphertext?.replace(/^~/, '') || n.id;
  const contract = n.job?.contractTerms?.contractType;
  const budget_type = contract === 'HOURLY' ? 'hourly' : contract === 'FIXED' ? 'fixed' : 'unknown';
  const spent = n.client?.totalSpent?.rawValue != null ? Math.round(Number(n.client.totalSpent.rawValue)) : null;
  const hires = n.client?.totalHires ?? null;
  const posted = n.client?.totalPostedJobs ?? null;
  const hireRate = hires != null && posted ? Math.round((hires / posted) * 100) : null;
  return {
    id,
    title: n.title,
    url: id ? `https://www.upwork.com/jobs/_~${id}/` : null,
    description: (n.description || '').slice(0, 4000),
    payment_verified: /VERIFIED/i.test(n.client?.verificationStatus || ''),
    proposals_bucket: bucketize(n.totalApplicants),
    client_spent_text: spent != null ? `$${spent}` : null,
    client_spent_usd: spent,
    client_hire_rate: hireRate,
    client_rating: n.client?.totalFeedback != null ? Number(n.client.totalFeedback) : null,
    client_reviews: n.client?.totalReviews ?? null,
    client_jobs_posted: posted,
    budget_type,
    hourly_min: n.hourlyBudgetMin?.rawValue != null ? Number(n.hourlyBudgetMin.rawValue) : null,
    hourly_max: n.hourlyBudgetMax?.rawValue != null ? Number(n.hourlyBudgetMax.rawValue) : null,
    fixed_budget: budget_type === 'fixed' && n.amount?.rawValue != null ? Number(n.amount.rawValue) : null,
    budget_text:
      budget_type === 'hourly'
        ? `Hourly: $${n.hourlyBudgetMin?.rawValue ?? '?'}-$${n.hourlyBudgetMax?.rawValue ?? '?'}`
        : budget_type === 'fixed'
        ? `Fixed $${n.amount?.rawValue ?? '?'}`
        : null,
    enriched: true // API 直接給齊客戶數據
  };
}

// 把提案人數轉成跟網頁一致的區間字串(讓評分邏輯共用)
function bucketize(n) {
  if (n == null) return null;
  if (n < 5) return 'Less than 5';
  if (n < 10) return '5 to 10';
  if (n < 15) return '10 to 15';
  if (n < 20) return '15 to 20';
  if (n < 50) return '20 to 50';
  return '50+';
}

async function main() {
  const token = await getAccessToken();
  const db = openDb();
  const seen = new Map();

  for (const q of config.searchQueries) {
    try {
      const data = await gql(token, QUERY, {
        filter: { titleExpression: q }, // 若無結果,改 searchExpression / userQuery,用 --raw 確認
        pagination: { first: config.scrape.maxJobsPerQuery || 40 }
      });
      const edges = data?.marketplaceJobPostingsSearch?.edges || [];
      console.log(`🔍 "${q}" → ${edges.length} 筆`);
      for (const e of edges) {
        const job = mapNode(e.node);
        if (job.id && !seen.has(job.id)) seen.set(job.id, job);
      }
    } catch (err) {
      console.warn(`   查詢失敗:${err.message}`);
    }
  }

  let apply = 0, maybe = 0, skip = 0;
  for (const job of seen.values()) {
    Object.assign(job, scoreJob(job, config));
    upsertJob(db, job);
    if (job.verdict === 'APPLY') apply++; else if (job.verdict === 'MAYBE') maybe++; else skip++;
  }
  console.log(`\n✅ 共 ${seen.size} 筆 → 值得投 ${apply}、可考慮 ${maybe}、排除 ${skip}`);
  console.log('   看報表:npm run report   或開網頁:npm run web');
}

main().catch((e) => {
  console.error('api:fetch 失敗:', e.message);
  if (!RAW) console.error('提示:加 --raw 看原始回應以對照 schema → npm run api:fetch -- --raw');
  process.exit(1);
});
