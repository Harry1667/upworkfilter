// 評分引擎 — 7 維度,每維 0-100,依 config 權重加權成總分(0-100)。
// 維度:① 報酬合理性 ② 能力匹配度 ③ 客戶品質 ④ 競爭強度 ⑤ 長期潛力 ⑥ 需求清晰度 ⑦ 風險訊號
// 超過 config.scoring.threshold 才判 APPLY(篩下來)。

// 把 "$20K+ spent" / "$1.4K" / "$100+" / "$0" 轉成美金數字
export function parseSpentUsd(text) {
  if (!text) return null;
  const m = String(text).match(/\$\s*([\d.,]+)\s*([KM]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  const unit = m[2].toUpperCase();
  if (unit === 'K') n *= 1000;
  else if (unit === 'M') n *= 1_000_000;
  return Math.round(n);
}

// ① 報酬合理性:預算/時薪是否合理(對齊你的底價與目標)
function scoreReward(j, rate) {
  if (j.budget_type === 'hourly') {
    const hi = j.hourly_max ?? j.hourly_min;
    const lo = j.hourly_min ?? j.hourly_max;
    if (hi == null) return 55;
    if (hi < rate.hourlyFloor) return 10;
    if (lo >= rate.hourlyTarget) return 100;
    if (hi >= rate.hourlyTarget) return 80;
    return 60;
  }
  if (j.budget_type === 'fixed') {
    if (j.fixed_budget == null) return 55;
    if (j.fixed_budget < rate.fixedFloor) return 25;
    if (j.fixed_budget >= rate.fixedFloor * 5) return 100;
    if (j.fixed_budget >= rate.fixedFloor * 2) return 80;
    return 65;
  }
  return 55; // 預算未知
}

// ② 能力匹配度:案子文字命中多少你的技能
function scoreSkill(j, mySkills) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  const matched = [...new Set(mySkills.filter((s) => text.includes(s.toLowerCase())))];
  const table = [0, 35, 58, 75, 88, 100]; // 命中 0..5+
  const score = matched.length >= 5 ? 100 : table[matched.length];
  return { score, matched };
}

// ③ 客戶品質:付款驗證 + 花費 + 聘用率 + 評分
function scoreClient(j) {
  let s = 0;
  s += j.payment_verified ? 25 : 0; // 付款驗證
  const spent = j.client_spent_usd;
  if (spent != null) {
    if (spent >= 50000) s += 35;
    else if (spent >= 10000) s += 28;
    else if (spent >= 3000) s += 22;
    else if (spent >= 1000) s += 16;
    else if (spent >= 100) s += 8;
    else s += 0;
  } else s += 12;
  if (j.client_hire_rate != null) {
    if (j.client_hire_rate >= 70) s += 25;
    else if (j.client_hire_rate >= 50) s += 20;
    else if (j.client_hire_rate >= 30) s += 12;
    else if (j.client_hire_rate > 0) s += 5;
    else s += 0;
  } else s += 12;
  if (j.client_rating != null && j.client_reviews > 0) {
    if (j.client_rating >= 4.8) s += 15;
    else if (j.client_rating >= 4.5) s += 10;
    else if (j.client_rating >= 4.0) s += 5;
  } else s += 8;
  return Math.min(s, 100);
}

// ④ 競爭強度:提案數越少越高分(資料有面試/已hire也納入)
function scoreCompetition(j) {
  const b = (j.proposals_bucket || '').toLowerCase();
  let s;
  if (b.includes('less than 5') || b.includes('fewer than 5') || b.includes('0 to 4')) s = 100;
  else if (b.includes('5 to 10') || b.includes('5-9')) s = 75;
  else if (b.includes('10 to 15') || b.includes('10-14')) s = 50;
  else if (b.includes('15 to 20')) s = 30;
  else if (b.includes('20 to 50')) s = 12;
  else if (b.includes('50')) s = 0;
  else s = 45;
  return s;
}

// ⑤ 長期潛力:轉長期/回頭客的可能
function scoreLongterm(j) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  let s = 45; // 預設中性
  if (/long[\s-]?term|ongoing|retainer|monthly|full[\s-]?time|長期|長期合作|recurring|continuous/.test(text)) s += 35;
  if (/potential|opportunity|grow|scale|expand|roster|team/.test(text)) s += 10;
  if (/one[\s-]?time|quick fix|small task|single|short[\s-]?term|one off/.test(text)) s -= 25;
  // 回頭客訊號:客戶歷史聘用多
  if ((j.client_hire_rate ?? 0) >= 50 && (j.client_jobs_posted ?? 0) >= 10) s += 10;
  return Math.max(0, Math.min(s, 100));
}

// ⑥ 需求清晰度:要什麼寫得清不清楚、有沒有 input/output/交付項
function scoreClarity(j) {
  const d = j.description || '';
  const len = d.length;
  let s = 0;
  if (len >= 1200) s = 80;
  else if (len >= 600) s = 65;
  else if (len >= 250) s = 45;
  else if (len >= 80) s = 25;
  else s = 15; // 幾乎沒寫
  const t = d.toLowerCase();
  if (/deliverable|scope|requirement|must include|responsibilit|milestone|input|output|acceptance|step \d|1\.|•|-\s/.test(t)) s += 15;
  if (/budget|timeline|deadline|by [a-z]+ \d|duration/.test(t)) s += 5;
  return Math.min(s, 100);
}

// ⑦ 風險訊號:從 100 往下扣(分數越高越安全)
function scoreRisk(j, rate) {
  let s = 100;
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  if (!j.payment_verified) s -= 40; // 付款未驗證
  if (j.client_spent_usd === 0) s -= 12; // 全新客戶沒花過錢
  if (j.client_hire_rate === 0 && (j.client_jobs_posted ?? 0) >= 3) s -= 40; // 只發案不雇人
  // 預算矛盾:範圍大喊但預算低
  if (j.budget_type === 'hourly' && (j.hourly_max ?? 99) < rate.hourlyFloor) s -= 25;
  if (j.budget_type === 'fixed' && j.fixed_budget != null && j.fixed_budget < 50 && /platform|full|system|app|complete|build/.test(text)) s -= 20;
  // 廣撒/緊急/壓榨訊號
  if (/urgent|asap|immediately|right now/.test(text)) s -= 8;
  if (/cheap|lowest|rockbottom|low budget|tight budget/.test(text)) s -= 10;
  if (/per 100|per hundred|\$5 per|commission only/.test(text)) s -= 25; // 壓榨型
  // 跳出 Upwork 詐騙訊號
  if (/telegram|whatsapp|skype|contact me at|email me/.test(text)) s -= 20;
  return Math.max(0, Math.min(s, 100));
}

// 綜合:7 子分 → 加權總分(0-100)→ 依門檻判 APPLY / MAYBE / SKIP
export function scoreJob(j, config) {
  const C = config.scoring.criteria;
  const sk = scoreSkill(j, config.mySkills);
  const scores = {
    reward: scoreReward(j, config.rate),
    skill: sk.score,
    client: scoreClient(j),
    competition: scoreCompetition(j),
    longterm: scoreLongterm(j),
    clarity: scoreClarity(j),
    risk: scoreRisk(j, config.rate)
  };

  // 加權總分(權重自動正規化,即使加起來不是 100 也沒關係)
  const totalWeight = Object.values(C).reduce((a, c) => a + (c.weight || 0), 0) || 1;
  let total = 0;
  for (const key of Object.keys(scores)) {
    const w = C[key]?.weight || 0;
    total += scores[key] * (w / totalWeight);
  }
  total = Math.round(total);

  // 硬性安全閘:雇用率 0% 的死客戶直接打回(不論加權分)
  let verdict, reason;
  const deadClient = j.client_hire_rate === 0 && (j.client_jobs_posted ?? 0) >= 3;
  if (deadClient) {
    verdict = 'SKIP';
    reason = `排除:雇用率0%(發了${j.client_jobs_posted}案沒雇人)`;
  } else if (total >= config.scoring.threshold) {
    verdict = 'APPLY';
    reason = buildReason(j, sk.matched, '值得投', scores);
  } else if (total >= config.scoring.maybeThreshold) {
    verdict = 'MAYBE';
    reason = buildReason(j, sk.matched, '可考慮', scores);
  } else {
    verdict = 'SKIP';
    reason = buildReason(j, sk.matched, '分數不足', scores);
  }

  return { scores, total_score: total, verdict, reason, matched_skills: sk.matched };
}

function buildReason(j, matched, prefix, scores) {
  // 找出最低的兩維,點出弱點
  const low = Object.entries(scores).sort((a, b) => a[1] - b[1]).slice(0, 2)
    .map(([k]) => ({ reward: '報酬', skill: '技能', client: '客戶', competition: '競爭', longterm: '長期', clarity: '清晰度', risk: '風險' }[k]));
  const bits = [];
  if (j.client_spent_text) bits.push('客戶' + j.client_spent_text.replace(/\s*spent/i, '').trim());
  if (j.proposals_bucket) bits.push('提案' + j.proposals_bucket);
  if (matched.length) bits.push('match:' + matched.slice(0, 3).join('/'));
  bits.push('弱項:' + low.join('/'));
  return `${prefix} — ${bits.join('、')}`;
}
