// 職缺正規化 — 把外部來源(擴充 webhook / 貼上 / bookmarklet)的一坨 raw,
// 解析成統一的 job 物件。web.js 的 /api/ingest 與 quick-analyze 共用,避免兩份解析。
import { stripChrome, parseSpentUsd } from './score.js';

export const ID_RE = /~([0-9a-f]+)/i;

// 寬容取值:從多個可能的 key 取第一個有值的(支援 "a.b" 巢狀)
const pick = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, kk) => (a == null ? a : a[kk]), o);
    if (v != null && v !== '') return v;
  }
  return undefined;
};

function numOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

// 把「Posted 8 minutes ago / yesterday / 3 days ago」以錨點時間回推成 ISO
function parseRelativePosted(str, anchorMs) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  if (/just now|seconds? ago|moments? ago/.test(s)) return new Date(anchorMs).toISOString();
  if (/yesterday/.test(s)) return new Date(anchorMs - 86400000).toISOString();
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
  return new Date(anchorMs - n * unit).toISOString();
}

// 從 ingest payload 取「發布絕對時間戳」(ISO)。優先用算好的 ISO/ms,否則從相對字串回推。
function normalizePostedAt(raw) {
  const iso = pick(raw, 'postedAtIso', 'postedAtISO', 'postedAtISOString');
  if (iso && !isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  const ms = Number(pick(raw, 'postedAtMs', 'postedAtMS'));
  if (ms > 0) return new Date(ms).toISOString();
  const rel = pick(raw, 'datePosted', 'posted', 'postedOn');
  const anchorRaw = pick(raw, 'scrapedAt', 'scraped_at');
  const anchor = anchorRaw && !isNaN(Date.parse(anchorRaw)) ? new Date(anchorRaw).getTime() : Date.now();
  return parseRelativePosted(rel, anchor);
}

export function parseBudget(text) {
  const t = String(text || '');
  if (!t) return { budget_type: 'unknown' };
  if (/hourly|\/hr|\/ hr/i.test(t)) {
    const nums = [...t.matchAll(/\$?\s*([\d.]+)/g)].map((m) => parseFloat(m[1])).filter((n) => !isNaN(n));
    return { budget_type: 'hourly', budget_text: t.slice(0, 30), hourly_min: nums[0] ?? null, hourly_max: nums[1] ?? nums[0] ?? null };
  }
  const fx = t.match(/\$\s*[\d.,]+\s*[KkMm]?/);
  if (fx) return { budget_type: 'fixed', budget_text: t.slice(0, 30), fixed_budget: parseSpentUsd(fx[0]) };
  return { budget_type: 'unknown', budget_text: t.slice(0, 30) };
}

// 把外部來源送來的一筆職缺,正規化成我們的 job 物件
export function normalizeIngest(raw) {
  const url = pick(raw, 'url', 'jobUrl', 'link', 'job_url', 'permalink', 'href') || '';
  const idm = String(url).match(ID_RE);
  const id = (idm ? idm[1] : null) || pick(raw, 'id', 'jobId', 'ciphertext', 'uid') || ('h' + Math.abs([...String(url || JSON.stringify(raw))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)));
  let desc = stripChrome(pick(raw, 'description', 'descriptionText', 'snippet', 'summary', 'jobDescription', 'text') || ''); // 剝掉 Upwork 頁面 chrome 雜訊
  const skills = pick(raw, 'skills', 'skillsList', 'tags');
  if (Array.isArray(skills) && skills.length) desc += '\n技能: ' + skills.join(', '); // 併入 skills 幫助技能匹配
  const exp = pick(raw, 'experienceLevel', 'tier', 'contractorTier');
  if (exp) desc += `\n經驗等級: ${exp}`;
  const budgetText = pick(raw, 'budget', 'budgetText', 'price', 'hourlyRange', 'amount') || '';
  const jobType = String(pick(raw, 'jobType', 'type', 'contractType') || '');
  const spentText = pick(raw, 'clientTotalSpent', 'clientSpent', 'totalSpent', 'spent', 'client.totalSpent') || '';
  const pv = pick(raw, 'paymentVerified', 'payment_verified', 'paymentMethod', 'paymentStatus');
  const job = {
    id: String(id).replace(/[^\w-]/g, '').slice(0, 32) || 'j' + Date.now(),
    title: pick(raw, 'title', 'jobTitle', 'name') || '(無標題)',
    url: url || (idm ? `https://www.upwork.com/jobs/_~${idm[1]}/` : ''),
    description: String(desc).slice(0, 8000), // 放寬:長描述的「To Apply/影片題」常在後段,別切掉
    posted_text: pick(raw, 'datePosted', 'posted', 'postedOn', 'publishedDate', 'createdAt') || null,
    posted_at: normalizePostedAt(raw),
    experience_level: exp ? String(exp).trim() : null, // 之前只塞進描述文字、漏設此欄 → winCapFor 的 Expert 上限從沒生效(全 596 案 null)
    payment_verified: pv === true || /verified|^true$|是/i.test(String(pv ?? '')),
    proposals_bucket: String(pick(raw, 'proposals', 'proposalsBucket', 'applicants', 'totalApplicants') ?? '') || null,
    client_spent_text: spentText ? String(spentText) : null,
    client_spent_usd: parseSpentUsd(spentText),
    client_hire_rate: numOrNull(pick(raw, 'hireRate', 'clientHireRate', 'client.hireRate', 'hire_rate')),
    connects_required: numOrNull(pick(raw, 'connectsRequired', 'connects_required', 'connectsNeeded', 'connects')),
    client_rating: numOrNull(pick(raw, 'clientRating', 'rating', 'client.rating', 'feedback')),
    client_reviews: numOrNull(pick(raw, 'reviews', 'reviewsCount', 'clientReviews', 'client.reviews')),
    client_jobs_posted: numOrNull(pick(raw, 'jobsPosted', 'clientJobsPosted', 'client.jobsPosted', 'postedJobs')),
    enriched: true
  };
  if (job.client_rating === 0) job.client_rating = null; // 0 評價視為新客戶,非 0 分
  Object.assign(job, parseBudget(budgetText));
  if (job.budget_type === 'unknown' && /hourly/i.test(jobType)) job.budget_type = 'hourly';
  if (job.budget_type === 'unknown' && /fixed/i.test(jobType)) job.budget_type = 'fixed';
  return job;
}
