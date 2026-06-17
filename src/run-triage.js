// `node src/run-triage.js [--all]` — 對未快篩的案跑 AI 快篩(triage),寫回 ai_score/ai_verdict/ai_win。
// 等同網頁「🤖 AI 快篩」按鈕,但可在伺服器 CLI 跑。需 .env 設好 AI proxy。
// 預設只跑「ai_score IS NULL 且 blocked=0」的案;--all 重跑全部未 blocked。
import { openDb, setAiVerdict } from './db.js';
import { triageJobs } from './triage.js';

const all = process.argv.includes('--all');
const db = openDb();
const where = all ? 'blocked=0' : 'ai_score IS NULL AND blocked=0';
const rows = db.prepare(`SELECT * FROM jobs WHERE ${where}`).all();
console.log(`🤖 待快篩:${rows.length} 案${all ? '(--all 重跑)' : ''}`);
if (!rows.length) { console.log('沒有要跑的案。'); process.exit(0); }

// 即時寫入(每批/每單案打完就存)— proxy 飄時跑到哪存到哪,中途掛掉不丟已篩結果
let done = 0, written = 0;
const res = await triageJobs(rows, {
  onBatch: (batch) => {
    for (const r of batch) setAiVerdict(db, r.id, r.score, r.reason ? `${r.verdict} - ${r.reason}` : r.verdict, r.win, r.tags, r.parent);
    written += batch.length;
  },
  onProgress: (n, total) => { if (n - done >= 10 || n === total) { done = n; console.log(`  進度 ${n}/${total}(已寫入 ${written})`); } }
});
console.log(`✅ 快篩完成:跑 ${res.length} 案、已寫入 ${written} 案的 ai_score/ai_verdict/ai_win。`);
