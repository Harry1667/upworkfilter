// `node src/run-triage.js [--all]` — 對未快篩的案跑 AI 快篩(triage),寫回 ai_score/ai_verdict/ai_win。
// 等同網頁「🤖 AI 快篩」按鈕,但可在伺服器 CLI 跑。需 .env 設好 AI proxy。
// 預設只跑「ai_score IS NULL 且 blocked=0」的案;--all 重跑全部未 blocked。
// 🗣️ 語言案(category='語言案')不進 AI 快篩:AI prompt 是開發顧問人格,會拿開發能力標準亂殺
// 語言/在地案,規則層(score.js isLanguageCase 分支)算出的 verdict 已是最終判斷。
import { openDb, setAiVerdict, getSetting } from './db.js';
import { triageJobs } from './triage.js';

const all = process.argv.includes('--all');
const db = openDb();
const where = (all ? 'blocked=0' : 'ai_score IS NULL AND blocked=0') + " AND (category IS NULL OR category != '語言案')";
const rows = db.prepare(`SELECT * FROM jobs WHERE ${where}`).all();
console.log(`🤖 待快篩:${rows.length} 案${all ? '(--all 重跑)' : ''}`);
if (!rows.length) { console.log('沒有要跑的案。'); process.exit(0); }

// 🟢🔴 接案狀態模式:CLI 也套用目前 sidebar 切換的模式,快篩尺度跟網頁一致
const workMode = getSetting('work_mode', 'idle');
console.log(`   目前狀態:${workMode === 'busy' ? '🔴 忙碌(嚴格底線)' : '🟢 空閒(預設)'}`);

// 即時寫入(每批/每單案打完就存)— proxy 飄時跑到哪存到哪,中途掛掉不丟已篩結果
let done = 0, written = 0;
const res = await triageJobs(rows, {
  mode: workMode,
  onBatch: (batch) => {
    for (const r of batch) setAiVerdict(db, r.id, r.score, r.reason ? `${r.verdict} - ${r.reason}` : r.verdict, r.win, r.tags, r.parent);
    written += batch.length;
  },
  onProgress: (n, total) => { if (n - done >= 10 || n === total) { done = n; console.log(`  進度 ${n}/${total}(已寫入 ${written})`); } }
});
console.log(`✅ 快篩完成:跑 ${res.length} 案、已寫入 ${written} 案的 ai_score/ai_verdict/ai_win。`);
