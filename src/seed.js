// `npm run seed` — 把本次對話已抓到的真實案子(透過能過 Cloudflare 的瀏覽器)寫入 DB 並評分。
// 用途:CF 擋住自動爬取時,仍能用已收集的資料產生報表。資料來源:2026-05-26 手動掃描。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, upsertJob } from './db.js';
import { scoreJob, parseSpentUsd } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

const u = (id) => `https://www.upwork.com/jobs/_~${id}/`;

// 已收集資料(title/id/payment/proposals/spent/budget + 部分客戶詳情)
const raw = [
  { id:'022058458295665159406', title:'Claude Code fluent contractor needed: complete a live B2B SaaS + code security audit', desc:'Claude Code B2B SaaS code security audit full stack node react', verified:true, prop:'5 to 10', spent:'$0 spent', bt:'hourly', hmin:25, hmax:40 },
  { id:'022058214001785582505', title:'Flutter Expert Needed: Bug Fixing, UI Polishing, and App Store/Play Store Deployment', desc:'Flutter bug fixing UI polishing app store play store deployment mobile ios', verified:true, prop:'Fewer than 5', spent:'$0 spent', bt:'fixed' },
  { id:'022059153197661074802', title:'Pre-Launch Security Audit for iOS Social App (Supabase/React/Capacitor)', desc:'security audit OWASP website security Supabase React Capacitor iOS social app data privacy', verified:true, prop:'10 to 15', spent:'$0 spent', bt:'unknown' },
  { id:'022058226194519560574', title:'Indie React Native Dev to Help Us Ship a Kawaii Coloring App by July 31', desc:'React Native coloring app mobile app development indie ship', verified:true, prop:'10 to 15', spent:'$200K+ spent', bt:'unknown' },
  { id:'022059117584360664302', title:'AI Tool Bug Fixing Specialist', desc:'AI tool bug fixing specialist debugging', verified:true, prop:'10 to 15', spent:'$1K+ spent', bt:'unknown' },
  { id:'022059064752973156734', title:'Full-Time Base44 / Lovable Developer Needed – Internal Lead Generation Platform', desc:'Base44 Lovable developer lead generation platform full stack ai app builder', verified:true, prop:'5 to 10', spent:'$60K+ spent', bt:'hourly', hmin:5, hmax:15 },
  { id:'022058977914440117486', title:'Full Stack Developer Consultation AI Integration Experience Required', desc:'full stack React Next.js Node.js .NET AI integration OpenAI Claude Gemini architecture SaaS prompt vector RAG', verified:true, prop:'5 to 10', spent:'$35 spent', bt:'fixed', hire:67, rating:5.0, reviews:5, jobs:9 },
  { id:'022059199787813188521', title:'OAuth App Registration Specialist', desc:'OAuth app registration API integration oauth flow', verified:true, prop:'10 to 15', spent:'$100K+ spent', bt:'unknown' },
  { id:'022059073616699391853', title:'Copilot in Visual Studio Trainer/Coach', desc:'GitHub Copilot Visual Studio trainer coach teaching .NET', verified:true, prop:'5 to 10', spent:'$8K+ spent', bt:'hourly' },
  { id:'022058930849792851821', title:'QA Engineer for Web Live Stream', desc:'QA engineer web live stream testing quality assurance', verified:true, prop:'10 to 15', spent:'$100K+ spent', bt:'hourly', hmin:15, hmax:20 },
  { id:'022059170965273884018', title:'AI Developer with Power BI Integration demo and review', desc:'AI Power BI integration DAX semantic model demo code review', verified:true, prop:'Fewer than 5', spent:'$20K+ spent', bt:'fixed', fixed:10 },
  { id:'022058941894063549678', title:'Live Data API Integrator', desc:'live data API integration realtime', verified:true, prop:'10 to 15', spent:'$0 spent', bt:'hourly', hmin:10, hmax:20 },
  { id:'022058422462703178221', title:'Senior Laravel + Flutter Developer Needed for 6amMart / Mivo Customization', desc:'Laravel Flutter 6amMart Mivo customization mobile', verified:true, prop:'10 to 15', spent:'$100 spent', bt:'fixed' },
  { id:'022058159224187350043', title:'Senior SwiftUI iOS Engineer Needed for Premium Audio & AI Consumer App', desc:'SwiftUI iOS audio AI consumer app swift', verified:true, prop:'10 to 15', spent:'$1K+ spent', bt:'unknown' },
  { id:'022058150754276961307', title:'Wix API Developer', desc:'Wix API developer integration', verified:true, prop:'10 to 15', spent:'$0 spent', bt:'unknown' },
  { id:'022059201541603243378', title:'Urgently looking for AI Agent developer', desc:'AI agent developer urgent', verified:true, prop:'10 to 15', spent:'$0 spent', bt:'unknown' },
  { id:'022059064093034409198', title:'Full Predictive Dialer Development', desc:'predictive dialer development telephony voip', verified:true, prop:'5 to 10', spent:'$100+ spent', bt:'unknown' },

  // ── 2026-05-26 第二批(gstack 掃描)──
  { id:'022059009473567091739', title:'AI Implementation & Integration Specialist (small short-term task)', desc:'AI implementation integration specialist api openai claude short task', verified:true, prop:'5 to 10', spent:'$60K+ spent', bt:'fixed' },
  { id:'022058954883261000942', title:'Full Stack Developer for Custom Canvas Print Website (Fabric.js, AI Image, DevOps)', desc:'full stack react fabric.js ai image tools devops docker website', verified:true, prop:'10 to 15', spent:'$10K+ spent', bt:'fixed' },
  { id:'022059001279551508862', title:'1-2 Day Quick Fix: Supabase + Python AI Patch (Next.js, React, Golang)', desc:'supabase python ai next.js react golang bug fix quick patch', verified:true, prop:'10 to 15', spent:'$7K+ spent', bt:'fixed' },
  { id:'022058958804882732402', title:'React Native Expert Needed for Quick Bug Fixes', desc:'react native bug fix mobile app quick', verified:true, prop:'5 to 10', spent:'$6K+ spent', bt:'fixed' },
  { id:'022059005847339625499', title:'Deploy Lovable Real Estate Website To Vercel', desc:'lovable vercel deploy next.js react website real estate', verified:true, prop:'10 to 15', spent:'$1K+ spent', bt:'fixed' },
  { id:'022059218562911632241', title:'Seeking skilled Firebase Engineers to join expanding team', desc:'firebase engineer backend node realtime database', verified:true, prop:'Fewer than 5', spent:'$1K+ spent', bt:'hourly', hmin:15, hmax:30 },
  { id:'022059174663206038555', title:'Looking for Payment Gateway Integration', desc:'payment gateway integration api stripe node backend', verified:true, prop:'5 to 10', spent:'$1K+ spent', bt:'fixed' },
  { id:'022059123851678444782', title:'AI-Driven Modern Website Redesign (Motion Design + Headless CMS)', desc:'react next.js headless cms website redesign motion design ai', verified:true, prop:'10 to 15', spent:'$700+ spent', bt:'fixed' },
  { id:'022058953207234784283', title:'Fix Lovable + Capacitor iOS TestFlight Bugs', desc:'lovable capacitor ios testflight bug fix react mobile', verified:true, prop:'5 to 10', spent:'$0 spent', bt:'fixed' },
  { id:'022058852375927165421', title:'Next.js Developer Needed for Modern Dynamic Website Development', desc:'next.js react dynamic website development frontend', verified:true, prop:'5 to 10', spent:'$0 spent', bt:'fixed' },
  { id:'022058951308911509357', title:'Full-Stack Developer: Digital Goods Arbitrage Bot & Dashboard', desc:'full stack node automation bot dashboard scraping api', verified:true, prop:'5 to 10', spent:'$0 spent', bt:'fixed' },
  { id:'022058965200945479533', title:'Semi-Automated Strategic Simulation Platform (MVP)', desc:'mvp full stack automation platform react node', verified:true, prop:'10 to 15', spent:'$0 spent', bt:'fixed' },
  { id:'022059160568819004786', title:'Real-Time iOS AR Object Recognition & Tracking POC — CoreML + ByteTrack', desc:'ios coreml ar object recognition swift machine learning poc', verified:true, prop:null, spent:'$300K+ spent', bt:'fixed' }
];

const db = openDb();
let apply = 0, maybe = 0, skip = 0;
for (const r of raw) {
  const job = {
    id: r.id,
    title: r.title,
    url: u(r.id),
    description: r.desc,
    payment_verified: r.verified,
    proposals_bucket: r.prop,
    client_spent_text: r.spent,
    client_spent_usd: parseSpentUsd(r.spent),
    client_hire_rate: r.hire ?? null,
    client_rating: r.rating ?? null,
    client_reviews: r.reviews ?? null,
    client_jobs_posted: r.jobs ?? null,
    budget_type: r.bt,
    hourly_min: r.hmin ?? null,
    hourly_max: r.hmax ?? null,
    fixed_budget: r.fixed ?? null,
    budget_text: r.bt === 'hourly' ? `Hourly: $${r.hmin ?? '?'}-$${r.hmax ?? '?'}` : (r.bt === 'fixed' ? `Fixed${r.fixed ? ' $' + r.fixed : ''}` : null),
    enriched: r.hire != null
  };
  const s = scoreJob(job, config);
  Object.assign(job, s);
  upsertJob(db, job);
  if (s.verdict === 'APPLY') apply++; else if (s.verdict === 'MAYBE') maybe++; else skip++;
}
console.log(`✅ 已寫入 ${raw.length} 筆真實案子 → 值得投 ${apply}、可考慮 ${maybe}、排除 ${skip}`);
console.log('   看報表:npm run report');
