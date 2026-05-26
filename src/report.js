// `npm run report` — 列出值得投的案子(依分數排序)。也可:npm run report -- all | applied | skip
import { openDb, markApplied } from './db.js';

const arg = process.argv[2] || 'apply';

function fmt(j) {
  const tags = [];
  if (j.payment_verified) tags.push('✅付款');
  if (j.client_spent_text) tags.push(j.client_spent_text.replace(/\s*spent/i, '').trim());
  if (j.client_hire_rate != null) tags.push(`雇用${j.client_hire_rate}%`);
  if (j.client_rating != null) tags.push(`★${j.client_rating}`);
  if (j.proposals_bucket) tags.push(`提案${j.proposals_bucket}`);
  if (j.budget_text) tags.push(j.budget_text);
  const appliedMark = j.applied ? ' 〔已投〕' : '';
  return [
    `\n[${j.total_score}分 · ${j.verdict}]${appliedMark} ${j.title}`,
    `  ${j.reason}`,
    `  維度 → 報酬${j.score_reward} 技能${j.score_skill} 客戶${j.score_client} 競爭${j.score_competition} 長期${j.score_longterm} 清晰${j.score_clarity} 風險${j.score_risk}`,
    `  ${tags.join(' | ')}`,
    `  🔗 ${j.url}`,
    `  id: ${j.id}`
  ].join('\n');
}

function main() {
  const db = openDb();

  // 子指令:標記已投 — npm run report -- mark <id>
  if (arg === 'mark') {
    const id = process.argv[3];
    if (!id) return console.error('用法:npm run report -- mark <id>');
    console.log(markApplied(db, id) ? `已標記 ${id} 為「已投」` : `找不到 ${id}`);
    return;
  }

  let where = "verdict = 'APPLY'";
  let title = '🟢 值得投的案子(APPLY)';
  if (arg === 'all') { where = '1=1'; title = '全部案子'; }
  else if (arg === 'maybe') { where = "verdict = 'MAYBE'"; title = '🟡 可考慮(MAYBE)'; }
  else if (arg === 'skip') { where = "verdict = 'SKIP'"; title = '🔴 已排除(SKIP)'; }
  else if (arg === 'applied') { where = 'applied = 1'; title = '已投紀錄'; }

  const rows = db.prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY total_score DESC, last_seen DESC`).all();

  // 統計
  const stats = db.prepare(`SELECT verdict, COUNT(*) c FROM jobs GROUP BY verdict`).all();
  const statLine = stats.map((s) => `${s.verdict}:${s.c}`).join('  ');

  console.log(`\n===== ${title} (${rows.length}) =====`);
  console.log(`資料庫總覽 → ${statLine || '(空)'}`);
  for (const j of rows) console.log(fmt(j));
  console.log(`\n提示:`);
  console.log(`  npm run report -- maybe    看「可考慮」`);
  console.log(`  npm run report -- all      看全部`);
  console.log(`  npm run report -- mark <id>  把某案標記為已投`);
}

main();
