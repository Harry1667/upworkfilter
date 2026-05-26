// `npm run enrich` — 用 gstack 逐筆抓「值得投/可考慮」案子的詳情頁,補齊真實資料(描述/預算/雇用率/評分)後重新評分。
// 需 gstack 已連線並登入 Upwork(headed)。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { openDb, upsertJob } from './db.js';
import { scoreJob, parseSpentUsd } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const BROWSE = path.join(os.homedir(), '.claude/skills/gstack/browse/dist/browse');

function browse(args, t = 60000) {
  try { return execFileSync(BROWSE, args, { encoding: 'utf8', timeout: t, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}

function parseDetail(snap, job) {
  const hire = snap.match(/(\d+)%\s*hire rate/i);
  const rating = snap.match(/Rating is ([\d.]+) out of 5/i);
  const reviews = snap.match(/([\d.]+) of (\d+) reviews/i);
  const posted = snap.match(/(\d+)\s+jobs? posted/i);
  const spent = snap.match(/\$[\d.,KM]+\+?\s*(?:total )?spent/i);
  if (hire) job.client_hire_rate = parseInt(hire[1], 10);
  if (rating) job.client_rating = parseFloat(rating[1]);
  if (reviews) job.client_reviews = parseInt(reviews[2], 10);
  if (posted) job.client_jobs_posted = parseInt(posted[1], 10);
  if (spent) { job.client_spent_text = spent[0]; job.client_spent_usd = parseSpentUsd(spent[0]); }
  if (/Payment (method )?verified/i.test(snap)) job.payment_verified = true;

  // 預算
  const hr = [...snap.matchAll(/\$\s*([\d.]+)\s*\/?\s*hr|\$\s*([\d.]+)\.00\/hr/gi)].map((m) => parseFloat(m[1] || m[2]));
  const hrRange = snap.match(/\$([\d.]+)\s*[-–]\s*\$([\d.]+)\s*\/?\s*hr|Hourly[^$]*\$([\d.]+)[^$]*\$([\d.]+)/i);
  if (hrRange) {
    const nums = [hrRange[1] || hrRange[3], hrRange[2] || hrRange[4]].map(Number).filter((n) => !isNaN(n));
    if (nums.length) { job.budget_type = 'hourly'; job.hourly_min = nums[0]; job.hourly_max = nums[1] ?? nums[0]; job.budget_text = `Hourly: $${nums[0]}-$${nums[1] ?? nums[0]}`; }
  } else if (/hourly/i.test(snap) && hr.length) {
    job.budget_type = 'hourly'; job.hourly_min = Math.min(...hr); job.hourly_max = Math.max(...hr); job.budget_text = `Hourly: $${job.hourly_min}-$${job.hourly_max}`;
  } else {
    const fx = snap.match(/(?:Fixed[- ]price|Est(?:imated)?\.?\s*[Bb]udget)[^$]*\$\s*([\d.,]+)/i);
    if (fx) { job.budget_type = 'fixed'; job.fixed_budget = parseFloat(fx[1].replace(/,/g, '')); job.budget_text = `Fixed $${job.fixed_budget}`; }
  }

  // 描述:抓 Summary / 主要內文(用於清晰度評分)。取 snapshot 中段一大塊純文字。
  const clean = snap.replace(/^---.*$/gm, '').replace(/@e\d+\s*\[[^\]]*\]\s*/g, '').replace(/\n{2,}/g, '\n').trim();
  job.description = clean.slice(0, 4000);
  job.enriched = true;
}

async function main() {
  const db = openDb();
  browse(['connect']);
  const rows = db.prepare("SELECT * FROM jobs WHERE verdict IN ('APPLY','MAYBE') ORDER BY total_score DESC").all();
  console.log(`補資料:${rows.length} 筆(值得投/可考慮)…\n`);
  let ok = 0, blocked = 0;
  for (const row of rows) {
    const job = { ...row, payment_verified: !!row.payment_verified };
    browse(['goto', job.url]);
    let snap = browse(['snapshot']);
    if (/Cloudflare Ray ID/i.test(snap) && snap.length < 800) { execFileSync('sleep', ['7']); browse(['goto', job.url]); snap = browse(['snapshot']); }
    if (/account-security\/login/i.test(snap)) { console.log('⚠️ gstack 未登入,請登入後重跑'); break; }
    if (/no longer available/i.test(snap)) { console.log(`  (已關閉) ${job.title.slice(0, 40)}`); }
    if (snap.length < 600) { process.stdout.write('x'); blocked++; }
    else {
      parseDetail(snap, job);
      Object.assign(job, scoreJob(job, config));
      upsertJob(db, job);
      process.stdout.write('.');
      ok++;
    }
    execFileSync('sleep', ['3']); // 放慢,降低反爬風險
  }
  console.log(`\n\n✅ 補完 ${ok} 筆(${blocked} 筆被擋)。重新評分完成 → npm run report 或 npm run web`);
}

main().catch((e) => { console.error('enrich 失敗:', e.message); process.exit(1); });
