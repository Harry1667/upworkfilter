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
    const b = j.fixed_budget;
    if (b == null) return 55;
    let s;
    if (b < rate.fixedFloor) s = 25;
    else if (b >= rate.fixedFloor * 5) s = 100;
    else if (b >= rate.fixedFloor * 2) s = 80;
    else s = 65;
    // 預算 vs 工作量:大範圍專案卻給低 fixed 預算 → 報酬其實不合理,降分
    // (例:$2000 接「整套 AI sales stack / CRM / 平台」是嚴重低價)
    const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
    const bigScope =
      /(full|complete|entire|whole|end[\s-]?to[\s-]?end|from scratch|full[\s-]?stack)/.test(text) ||
      (/(crm|saas|platform|system|stack|marketplace|mvp|dashboard|web app|mobile app|automation pipeline)/.test(text) &&
       /(build|develop|create|set ?up|implement|design and|architect)/.test(text));
    if (bigScope) {
      if (b < 1000) s = Math.min(s, 35);
      else if (b < 3000) s = Math.min(s, 55);
      else if (b < 5000) s = Math.min(s, 70);
    }
    return s;
  }
  return 55; // 預算未知
}

// ② 能力匹配度:案子要求 vs「我的能力(分級)」+ 作品契合加成 + 超綱偵測
// 兩種模式:
//  (A) 有 capability.skills(分級技能清單)→ 用「能力數值/邊界」評分(主力 + 紅線)。
//  (B) 沒有 → 退回舊的關鍵字命中計數(相容)。
// provenTechs = Profile Agent 從你 GitHub 歸納出的「有真實 repo 證據」技術關鍵字。
// 設計原則:能力深度(level)決定上限;命中紅線(不碰)技能 → 超綱、封頂。
const LEVEL_BASE = { 5: 90, 4: 78, 3: 60, 2: 38, 1: 20 }; // 主力技能 level → 基準分

function scoreSkill(j, mySkills, provenTechs = [], capability = null) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  const inText = (kw) => kw && text.includes(String(kw).toLowerCase());

  // 紅線/不碰:命中即超綱(關鍵字寬鬆,故只降分不直接 SKIP,留人工判斷)
  const redHit = [...new Set((capability?.redlines || []).filter(inText))];

  const graded = capability?.skills?.length ? capability.skills : null;
  let score, matched, topLevel = null;

  if (graded) {
    // (A) 分級能力:命中技能取其 level,最高 level 定基準,其餘深度技能加成
    const hits = graded
      .filter((s) => [s.name, ...(s.keywords || [])].some(inText))
      .map((s) => ({ name: s.name, level: Number(s.level) || 1 }));
    matched = hits.map((h) => h.name);
    if (hits.length === 0) {
      score = 15; // 完全在能力圈外
    } else {
      const levels = hits.map((h) => h.level).sort((a, b) => b - a);
      topLevel = levels[0];
      const base = LEVEL_BASE[topLevel] ?? 20;
      const bonus = Math.min(levels.slice(1).filter((l) => l >= 3).length * 8, 20); // 額外夠深技能 +8/項,上限 +20
      score = Math.min(100, base + bonus);
    }
  } else {
    // (B) 舊邏輯:命中幾個口頭技能
    matched = [...new Set((mySkills || []).filter((s) => text.includes(s.toLowerCase())))];
    const table = [0, 35, 58, 75, 88, 100]; // 命中 0..5+
    score = matched.length >= 5 ? 100 : table[matched.length];
  }

  // 作品契合:案子文字也命中「有 GitHub 證據」的技術 → 每項 +10,最多 +30
  const proven = [...new Set((provenTechs || []).filter(inText))];
  if (proven.length) score = Math.min(100, score + Math.min(proven.length * 10, 30));

  // 超綱封頂:命中紅線技能 → 能力分大幅降
  let overscope = false;
  if (redHit.length) { score = Math.min(score, 22); overscope = true; }

  // 能力圈外:有分級能力清單、但案子文字完全沒命中任何技能 → 不是我的領域
  const outOfScope = !!(graded && matched.length === 0);

  return { score, matched, proven, overscope, outOfScope, redHit, topLevel };
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
  const sk = scoreSkill(j, config.mySkills, config.provenTechs, config.capability);
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

  // 低 CP 值閘:預算明顯低於底價 → 降級(避免燒 Connects 投不值得的案)
  // 低預算 + 高競爭(提案多)= 燒代幣雷案 → 直接略過
  const floor = config.rate || {};
  const lowPay =
    (j.budget_type === 'hourly' && (j.hourly_max ?? j.hourly_min ?? 99) < (floor.hourlyFloor ?? 12)) ||
    (j.budget_type === 'fixed' && j.fixed_budget != null && j.fixed_budget < (floor.fixedFloor ?? 80));
  const b = (j.proposals_bucket || '').toLowerCase();
  const crowded = /15 to 20|20 to 50|50/.test(b);

  // 硬性安全閘:雇用率 0% 的死客戶直接打回(不論加權分)
  let verdict, reason;
  const deadClient = j.client_hire_rate === 0 && (j.client_jobs_posted ?? 0) >= 3;
  if (deadClient) {
    verdict = 'SKIP';
    reason = `排除:雇用率0%(發了${j.client_jobs_posted}案沒雇人)`;
  } else if (lowPay && crowded) {
    verdict = 'SKIP';
    reason = `排除:低預算+高競爭(燒 Connects 不值得)— 提案${j.proposals_bucket || '多'}`;
  } else if (lowPay && total >= config.scoring.maybeThreshold) {
    // 低薪但其他不錯 → 最多到「可考慮」,不讓它變「值得投」
    verdict = 'MAYBE';
    reason = buildReason(j, sk.matched, '可考慮(預算偏低)', scores, sk.proven);
  } else if (total >= config.scoring.threshold) {
    verdict = 'APPLY';
    reason = buildReason(j, sk.matched, '值得投', scores, sk.proven);
  } else if (total >= config.scoring.maybeThreshold) {
    verdict = 'MAYBE';
    reason = buildReason(j, sk.matched, '可考慮', scores, sk.proven);
  } else {
    verdict = 'SKIP';
    reason = buildReason(j, sk.matched, '分數不足', scores, sk.proven);
  }

  // 🚪 第二道門(能力)硬攔截:在進 AI 分析前先擋掉。blocked=1 → AI 快篩/分析會跳過(省成本)。
  // ① 命中紅線(不碰)技能 ② 完全在能力圈外(無任何技能命中)→ 一律 SKIP。
  let blocked = 0;
  if (sk.overscope) {
    verdict = 'SKIP'; blocked = 1;
    reason = `🚫 第二道門·紅線「${sk.redHit.join('/')}」(不碰)— ${reason}`;
  } else if (sk.outOfScope) {
    verdict = 'SKIP'; blocked = 1;
    reason = `🚫 第二道門·能力圈外(無技能命中,非你的領域)— ${reason}`;
  }

  return { scores, total_score: total, verdict, reason, blocked, matched_skills: sk.matched };
}

function buildReason(j, matched, prefix, scores, proven = []) {
  // 找出最低的兩維,點出弱點
  const low = Object.entries(scores).sort((a, b) => a[1] - b[1]).slice(0, 2)
    .map(([k]) => ({ reward: '報酬', skill: '技能', client: '客戶', competition: '競爭', longterm: '長期', clarity: '清晰度', risk: '風險' }[k]));
  const bits = [];
  if (j.client_spent_text) bits.push('客戶' + j.client_spent_text.replace(/\s*spent/i, '').trim());
  if (j.proposals_bucket) bits.push('提案' + j.proposals_bucket);
  if (matched.length) bits.push('match:' + matched.slice(0, 3).join('/'));
  if (proven.length) bits.push('✓作品:' + proven.slice(0, 3).join('/')); // 有 GitHub 證據
  bits.push('弱項:' + low.join('/'));
  return `${prefix} — ${bits.join('、')}`;
}
