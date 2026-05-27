// 一次性/CLI 重算:套用最新能力邊界 + 回填 blocked(第二道門硬攔截)。
// 用法:node src/rescore.js  (或 npm run rescore)
// 線上 profile.json 若還沒有能力資料 → 用 profile.example.json 的預設種進去並存回(等同在 /me 按一次儲存)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, allJobs, upsertJob } from './db.js';
import { scoreJob } from './score.js';
import { loadProfile, saveProfile } from './assist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let p = loadProfile();
if (!p.capability || !(p.capability.skills || []).length) {
  try {
    const ex = JSON.parse(readFileSync(path.join(ROOT, 'profile.example.json'), 'utf8'));
    if (ex.capability) { p.capability = ex.capability; saveProfile(p); console.log('🌱 已從 example 種入能力邊界到 profile.json'); }
  } catch (e) { console.error('種入能力失敗:' + e.message); }
}
cfg.capability = p.capability || null;
cfg.provenTechs = p.provenTechs || [];

// 套用啟用模式的權重/門檻(對齊 web.js 的 loadConfig)
const s = cfg.scoring || {};
if (s.mode === 'newbie' && s.newbieWeights) {
  for (const k of Object.keys(s.criteria || {})) if (s.newbieWeights[k] != null) s.criteria[k].weight = s.newbieWeights[k];
  if (s.newbieThreshold != null) s.threshold = s.newbieThreshold;
  if (s.newbieMaybeThreshold != null) s.maybeThreshold = s.newbieMaybeThreshold;
}

const db = openDb();
let n = 0, blocked = 0;
for (const row of allJobs(db)) {
  const job = { ...row, payment_verified: !!row.payment_verified, enriched: !!row.enriched };
  Object.assign(job, scoreJob(job, cfg));
  upsertJob(db, job);
  n++; if (job.blocked) blocked++;
}
console.log(`✅ 重算完成:${n} 案,其中 ${blocked} 案被第二道門擋下(blocked=1)`);
db.close?.();
