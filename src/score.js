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

// gstack 無障礙樹快照會在欄位間夾 @eNN 與 [type] 標記(如 "@e21 [strong]: Expert")。
// 解析前一律先清掉,否則相鄰兩欄(等級 / Experience Level)會被標記隔開而比對不到。
function cleanSnap(snap) {
  return String(snap || '').replace(/@e\d+/g, ' ').replace(/\[[^\]]*\]/g, ' ');
}

// 從詳情頁文字快照抽「經驗等級」(Entry/Intermediate/Expert)。
// 等級詞必須與 "Experience Level" 相鄰(中間僅容許標點/空白,≤18 字元),避免誤抓內文裡的 "expert"。
export function parseExperienceLevel(snap) {
  if (!snap) return null;
  const t = cleanSnap(snap);
  const LV = '(Entry[\\s-]?level|Intermediate|Expert)';
  const m = t.match(new RegExp(`${LV}[^A-Za-z]{0,18}Experience\\s*Level`, 'i'))
    || t.match(new RegExp(`Experience\\s*Level[^A-Za-z]{0,18}${LV}`, 'i'));
  if (!m) return null;
  const w = (m[1] || '').toLowerCase();
  if (w.startsWith('entry')) return 'Entry';
  if (w.startsWith('inter')) return 'Intermediate';
  return 'Expert';
}

// 從文字抽「投這案需要幾個 Connects」(超熱門度代理)。注意:此數字只在「投案頁」出現,
// 詳情頁快照通常沒有 → enrich 多半抓不到(回 null,閘門改靠 Expert tag/預算,優雅降級)。
export function parseConnectsRequired(snap) {
  if (!snap) return null;
  const t = cleanSnap(snap);
  const m = t.match(/(?:requires|proposal for:?|Send a proposal for:?)\s*(\d+)\s*Connects/i)
    || t.match(/(\d+)\s*Connects?\s*(?:required|to (?:submit|apply))/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// ───────── 新帳號可勝性(first-win)輔助 — 接既有 can-win 閘,非另建評分系統 ─────────

// 提案數只有「桶」字串(無精確數)→ 正規化成保守等級
export function proposalBucketLevel(bucket) {
  const b = String(bucket || '').toLowerCase();
  if (!b) return 'unknown';
  if (b.includes('less than 5') || b.includes('fewer than 5') || b.includes('0 to 4')) return '<5';
  if (b.includes('5 to 10') || b.includes('5-9')) return '5-10';
  if (b.includes('10 to 15') || b.includes('10-14')) return '10-15';
  if (b.includes('15 to 20')) return '15-20';
  if (b.includes('20 to 50')) return '20-50';
  if (b.includes('50')) return '50+';
  return 'unknown';
}

// 剝掉 scraper 抓進來的 Upwork 頁面 chrome(導覽列 + footer),只留職缺正文。
// 只在偵測到明確 chrome 標記時才動,乾淨輸入不受損(冪等)。在 ingestion 清一次,下游全受惠。
export function stripChrome(desc) {
  let d = String(desc || '');
  // 去頭:Upwork 導覽列 "Skip to content...Toggle Search : Posted... : Summary :"
  d = d.replace(/^[\s\S]*?Toggle Search[\s\S]{0,200}?:\s*Summary\s*\n?\s*:?\s*/i, '');
  // 去尾:footer / 結構化欄位區(這些另有專欄,且含 Enterprise Solutions 等雜訊)
  d = d.split(/Enterprise Solutions|Trust, Safety|Follow Us|©\s*201\d|: Experience Level/i)[0];
  return d.trim();
}

// 髒資料防護:把 "13 Connects"/"200 USD"/"0"/數字 都安全轉成數值(抓不到回 null)
export function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 資深/Expert 案:experience_level=Expert、或「標題」資深字眼、或「描述」明確要求資深/Upwork 資歷
export function isSeniorExpertJob(j) {
  const lvl = String(j.experience_level || '').toLowerCase();
  if (lvl.includes('expert')) return true;
  const title = String(j.title || '').toLowerCase();
  const desc = String(j.description || '').toLowerCase();
  // 強資深訊號(不含裸 "expert"):客戶自己寫的硬門檻 → 即使 Upwork 標 Entry/Intermediate 也該擋(Codex review)
  // 標題不用裸 \blead\b(會誤判 "lead generation");只認「資深職位」的 lead 措辭
  const strongTitle = /\bsenior\b|\bprincipal\b|\bstaff engineer\b|tech lead|team lead|lead (developer|engineer|architect)|engineering lead|\barchitect\b|\brockstar\b|\bguru\b|\bninja\b|10x/.test(title);
  const descExcl = /do not apply if you('?re| are) new|no beginners|no newbies|previous upwork (history|experience)|expert[- ]level (freelancer|developer|engineer|contractor)|senior (contractor|freelancer)|must be (a |an )?(senior|expert)/.test(desc);
  if (strongTitle || descExcl) return true;
  // 只剩「裸 expert 標題」這種模糊訊號(如 "Flutter Expert Needed" = 想找高手做小活,非資深職位):
  // Upwork 官方 Entry/Intermediate 就信它,不誤判;level 未知才用裸 expert 標題推斷。
  if (lvl.includes('entry') || lvl.includes('intermediate')) return false;
  return /\bexpert\b/.test(title);
}

// 大型範圍:整套 SaaS/平台 from scratch / 企業 / 需團隊 / 長期但無明確第一里程碑
// 注意:刻意收緊,避免把正常「full-stack developer」案誤判成大型(stack/system 太鬆,新手吃得下全棧小案)
export function isLargeScope(j) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  // 「from scratch」必須與「大型產品詞」共現,否則「landing page from scratch」這種小案會被誤判
  const fromScratch = /(from scratch|ground up|greenfield)/.test(text) &&
    /(saas|platform|marketplace|ecosystem|crm|erp|portal|full system|entire system|whole system|product suite)/.test(text);
  // 「entire/complete/full + saas/platform/product/...」整套產品(要求相鄰,不被 full-stack 觸發)
  const wholeProduct = /(entire|complete|full|whole)\s+(saas|platform|product|system|marketplace|application|ecosystem|suite)/.test(text);
  // enterprise 要「職缺語境」才算(避免命中 scraper 抓進來的 Upwork footer「Enterprise Solutions」boilerplate)
  const enterprise = /enterprise[\s-](?:client|grade|software|platform|application|saas|system|customers?|deployment|account)|managed agents?|multi[\s-]?tenant/.test(text);
  const team = /team of \d|multi[\s-]?person team|our (dev|engineering) team/.test(text);
  const longNoFirst = /long[\s-]?term|ongoing|full[\s-]?time|retainer|\d+\+?\s*months/.test(text) &&
    !/(first|small|test|trial|milestone|start with|poc|proof of concept|pilot|task)/.test(text);
  return fromScratch || wholeProduct || enterprise || team || longNoFirst;
}

// 🎈 畫大餅偵測(期望 ≫ 預算)— Pragyan 型客戶:企業級願景/一長串功能,預算卻補不起來。
// 只用現有欄位(description + 預算)。回 {hit, severity, reason}。severity:0 無 / 1 輕 / 2 重。
// ⚠️ 最強訊號是「客戶平均實付 $/hr」(Pragyan $10/hr),但該欄位需擴充功能加抓 client 頁的
//    "avg hourly rate paid",目前尚未接入 → 這裡只做 post 級「範圍 vs 預算」軟訊號(警示不硬殺)。
export function scopeBudgetMismatch(j) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  // 整套平台/企業級願景詞
  const grandVision = isLargeScope(j) ||
    /fully (?:ai[\s-]?powered|automated)|end[\s-]?to[\s-]?end (?:automation|platform|system)|sell (?:it|this) to other|offer (?:it|this) to other|white[\s-]?label|multi[\s-]?compan|scale (?:it|this) (?:into|to) a (?:product|saas)/.test(text);
  // 功能清單密度:編號功能標記(①②③ / 行首 "1." "2.")或多個 feature/module 字眼
  const numberedMarkers = (text.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g) || []).length
    + (String(j.description || '').match(/^\s*\d[.)]\s/gm) || []).length;
  const featureWords = (text.match(/\b(feature|module|integration|workflow|automation)\b/g) || []).length;
  const manyFeatures = numberedMarkers >= 3 || featureWords >= 5;
  if (!(grandVision || manyFeatures)) return { hit: false, severity: 0, reason: '' };

  // 預算側:這份野心配了多小的錢?
  const fb = toNum(j.fixed_budget);
  const hi = toNum(j.hourly_max) ?? toNum(j.hourly_min);
  let small = false, label = '';
  if (j.budget_type === 'fixed' && fb != null) {
    if (fb < 1500) { small = true; label = `$${fb} fixed`; }
  } else if (j.budget_type === 'hourly' && hi != null) {
    if (hi < 40 && manyFeatures) { small = true; label = `$${hi}/hr 上限`; } // 企業級願景卻低時薪上限
  }
  if (!small) return { hit: false, severity: 0, reason: '' };

  const severity = (grandVision && manyFeatures) ? 2 : 1;
  const feat = numberedMarkers >= 3 ? `${numberedMarkers} 項列點功能`
    : (featureWords >= 5 ? '多模組需求' : '整套平台願景');
  return { hit: true, severity, reason: `🎈 期望≫預算(畫大餅):${feat} 卻僅 ${label}` };
}

// 🙅 非開發角色:標題明顯是招募/小編/行政/客服/業務/VA 等「找人做非開發工作」的案。
// 就算內文有 AI/automation buzzword(掛羊頭)也不是你的領域。標題若有開發職稱則不算(可能是「找工程師建招募工具」)。
export function isNonDevRole(j) {
  const title = String(j.title || '').toLowerCase();
  // 2026-06-18 三堂會審補:加 customer success / operations manager / marketing 系 / growth marketer /
  // sales development representative(這批非開發職原本漏接)。修複數(reps)與雙空白(operations  manager)。
  // 註:QA/SDET/test engineer 不列入 — 那是寫程式的相鄰領域(且含 engineer 會被下面 devRole 豁免),交給 AI 判。
  const NONDEV = /\b(recruiter|talent sourcer|sourcer|headhunter|content creator|copywriter|social media manager|community manager|virtual assistant|data entry|appointment setter|customer (support|service|success)|sales (rep|representative|development representative)s?|\bsdr\b|\bbdr\b|telemarket|cold caller|human resources|\bhr\b|admin(?:istrative)? (assistant|support)|executive assistant|bookkeeper|voice ?over|transcription(?:ist)?|proofreader|seo writer|brand ambassador|moderator|operations\s+manager|marketing (researcher|manager|specialist)|growth marketer)\b/;
  if (!NONDEV.test(title)) return false;
  // 標題同時有「開發職稱」→ 是開發案,不算非開發角色(例:Backend Developer for a CRM)
  const devRole = /\b(developer|programmer|coder|architect|full[\s-]?stack|back[\s-]?end|front[\s-]?end|software engineer)\b/;
  return !devRole.test(title);
}

// 🗣️ 語言/在地案(2026-07 實證開通):使用者實測至今全部正面訊號(3 面試邀請 + 2 進行中提案)
// 都是「華語/台語/台灣腔身分」案(華語錄音、台語配音、台灣腔英文電話錄音、華語 AI 訓練、台灣用戶問卷),
// 而非開發案。這類案「身分即可交付」,不該吃 isNonDevRole 黑名單(voice over/transcription 在裡面)
// 或能力圈外(outOfScope,無開發技能命中)硬擋 —— 舊規則等於把使用者唯一有牽引力的管道全殺光。
// 判定:身分詞(華語/台語/台灣籍)+ 任務詞(錄音/口譯/校對/標註/評測等)都要命中,且標題不能是開發職稱
// (避免「Mandarin-speaking React Developer」這種開發案被誤收進語言案通道)。
export function isLanguageCase(j) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  const IDENTITY = /\b(mandarin|taiwanese|hokkien|cantonese)\b|chinese[\s-]?(speaker|speaking|native|voice|audio|transcri|translat|annotat|writer|content)|native chinese|traditional chinese|zh[-_]?tw|taiwan[\s-]?based|in taiwan|from taiwan/;
  // 注意:transcri/translat/annotat/evaluat/speaker 是刻意截短的字根,要吃到 transcription/translate/
  // annotate/evaluate/speakers 等變化形 → 只留「開頭」\b,別在整組尾端也加 \b(會擋掉字根後面接的字尾,
  // 讓 evaluate/annotate/speakers 這類詞永遠比對不到,實測用 acceptance case (b) 抓到這個回歸)。
  const TASK = /\b(record|recording|voice|audio|speak|speaker|transcri|translat|interpret|annotat|evaluat|rating|survey|usability|test(?:er|ing)?|role[\s-]?play|data collection|ai training|proofread|linguist)/;
  if (!IDENTITY.test(text) || !TASK.test(text)) return false;
  const title = String(j.title || '').toLowerCase();
  const devRole = /\b(developer|programmer|coder|architect|full[\s-]?stack|back[\s-]?end|front[\s-]?end|software engineer)\b/;
  if (devRole.test(title)) return false; // 標題是開發職稱 → 開發案,走原流程
  return true;
}

// 第一單目標:小而明確、低競爭、付款驗證、客戶非全新爛,且非 Expert/大型 → 新手搶得到的案
export function isFirstReviewTarget(j, config) {
  if (isSeniorExpertJob(j) || isLargeScope(j)) return false;
  // 全職/長期/retainer 不是「第一單」目標(慢、面試多、競爭高)— 查標題「與描述」(描述也可能藏全職)
  const ftText = `${String(j.title || '')} ${String(j.description || '')}`.toLowerCase();
  if (/full[\s-]?time|\d+\s*hrs?\/\s*week|hours per week|long[\s-]?term|retainer|ongoing (role|work|basis|position)|\d+\+?\s*months/.test(ftText)) return false;
  if (!j.payment_verified) return false;
  const lvl = proposalBucketLevel(j.proposals_bucket);
  if (!(lvl === '<5' || lvl === '5-10' || lvl === 'unknown')) return false;
  // 高 Connects 案不是「第一單目標」(投案成本高)。Gemini review:門檻用 config.connectsHot(預設16)
  const cr = toNum(j.connects_required);
  if (cr != null && cr >= (config?.scoring?.connectsHot ?? 16)) return false;
  const floor = config?.rate || {};
  let budgetOk = false;
  const fb = toNum(j.fixed_budget);
  if (j.budget_type === 'fixed' && fb != null) {
    budgetOk = fb >= 50 && fb <= 400; // 第一單甜蜜區
  } else if (j.budget_type === 'hourly') {
    const hi = toNum(j.hourly_max) ?? toNum(j.hourly_min);
    budgetOk = hi != null && hi >= (floor.hourlyFloor ?? 12);
  }
  if (!budgetOk) return false;
  const hr = toNum(j.client_hire_rate);
  const hireZero = hr === 0 && (toNum(j.client_jobs_posted) ?? 0) >= 1;
  if (hireZero) return false;
  const someTrust = (toNum(j.client_spent_usd) ?? 0) > 0 || (hr ?? 0) > 0;
  if (!someTrust) return false;
  if (String(j.description || '').length < 200) return false; // 一句話模糊案不算「明確」
  return true;
}

// Connects 紀律:該不該「別 boost / 別投」+ 原因(供 score reason 與 web.js 共用)
export function connectsDiscipline(j, hotConnects = 16) {
  const reasons = [];
  let noBoost = false, avoidApply = false;
  const lvl = proposalBucketLevel(j.proposals_bucket);
  const cr = toNum(j.connects_required);
  const hireZero = toNum(j.client_hire_rate) === 0 && (toNum(j.client_jobs_posted) ?? 0) >= 1;
  if (isSeniorExpertJob(j)) { noBoost = true; reasons.push('Expert/資深案,boost 也搶不過老手'); }
  if (lvl === '20-50' || lvl === '50+') { noBoost = true; reasons.push(`提案${lvl},紅海`); }
  if (Number.isFinite(cr) && cr >= hotConnects) { noBoost = true; reasons.push(`需 ${cr} Connects,boost 成本過高`); }
  if (hireZero) { avoidApply = true; noBoost = true; reasons.push('客戶 0% 聘用率'); }
  // 明確「已驗證為未付款」才算;null/undefined(未 enrich)不計負面(抓不到不誤殺)
  if (j.payment_verified === 0 || j.payment_verified === false) { avoidApply = true; reasons.push('付款未驗證'); }
  return { noBoost, avoidApply, reasons };
}

// ① 報酬合理性:預算/時薪是否合理(對齊你的底價與目標)
// toNum 過濾 Infinity/NaN/字串髒值 → null;倒置時薪(min>max)用 max/min 正規化(Codex challenge)
function scoreReward(j, rate) {
  if (j.budget_type === 'hourly') {
    const vals = [toNum(j.hourly_max), toNum(j.hourly_min)].filter((v) => v != null);
    if (!vals.length) return 55;
    const hi = Math.max(...vals), lo = Math.min(...vals);
    if (hi < rate.hourlyFloor) return 10;
    if (lo >= rate.hourlyTarget) return 100;
    if (hi >= rate.hourlyTarget) return 80;
    return 60;
  }
  if (j.budget_type === 'fixed') {
    const b = toNum(j.fixed_budget); // Infinity/NaN → null → 視為未知
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

// 整字比對:關鍵字前後不可緊接英數,避免子字串誤判(community→unity、javascript→java、email→ai)
function wordHit(text, kw) {
  if (!kw) return false;
  const esc = String(kw).toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!esc) return false;
  try { return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i').test(text); }
  catch { return text.includes(esc); }
}

// 紅線詞是否為 JD 核心需求:出現在描述前 400 字、或全文出現 ≥2 次 → 是核心、不能軟標放行
function redlineIsCoreReq(descText, redHit) {
  const desc = String(descText || '').toLowerCase();
  const first400 = desc.slice(0, 400);
  for (const kw of redHit) {
    const esc = kw.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) continue;
    let re;
    try { re = new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'g'); }
    catch { re = new RegExp(esc, 'g'); }
    if (re.test(first400)) return true;
    re.lastIndex = 0;
    if ((desc.match(re) || []).length >= 2) return true;
  }
  return false;
}

function scoreSkill(j, mySkills, provenTechs = [], capability = null) {
  const text = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  const inText = (kw) => wordHit(text, kw);

  // 紅線/不碰:命中即超綱(關鍵字寬鬆,故只降分不直接 SKIP,留人工判斷)
  const redHit = [...new Set((capability?.redlines || []).filter(inText))];
  // 紅線出現在 title = 核心需求 → 強制硬擋(下面 overscope=true)
  const titleText = String(j.title || '').toLowerCase();
  const redInTitle = (capability?.redlines || []).some((kw) => wordHit(titleText, kw));

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
    matched = [...new Set((mySkills || []).filter((s) => wordHit(text, s)))];
    const table = [0, 35, 58, 75, 88, 100]; // 命中 0..5+
    score = matched.length >= 5 ? 100 : table[matched.length];
  }

  // 作品契合:案子文字也命中「有 GitHub 證據」的技術 → 每項 +10,最多 +30
  const proven = [...new Set((provenTechs || []).filter(inText))];
  if (proven.length) score = Math.min(100, score + Math.min(proven.length * 10, 30));

  // 紅線處理(2026-06 砍掉重練,放寬):只有「紅線=這案的核心」才硬擋,順帶提到一律軟標放行。
  // 舊版要求「命中深度≥4 才肯軟標」太嚴 → 例:Supabase+Python(你深度3)的快修案順帶一句 golang,
  // 就被硬擋成超綱。新判準只看紅線本身是不是核心(在 title、或描述前 400 字、或全文≥2 次),
  // 與你命中技能的深度無關。核心是紅線 → 硬擋;只是 JD 順帶列一句 → ⚠️ 軟標,讓你自己判。
  let overscope = false;   // 硬擋(SKIP + blocked):這案核心就是紅線技術
  let redlineSoft = false; // 軟標(⚠️ 提醒,不擋):核心是你強項,紅線只順帶提及
  if (redHit.length) {
    if (redInTitle || redlineIsCoreReq(j.description, redHit)) {
      score = Math.min(score, 22); overscope = true;
    } else {
      redlineSoft = true;
    }
  }

  // 能力圈外:有分級能力清單、且案子文字完全沒命中任何技能「也沒命中 GitHub 作品證據」→ 才算非我領域。
  // 2026-06 修 bug:舊版只看 matched(分級技能),漏算 proven → Firebase/SwiftUI/AI Agent 等命中
  // 你已證明過的技術的案,被誤判「完全能力圈外」硬擋。proven 命中即在圈內。
  const outOfScope = !!(graded && matched.length === 0 && proven.length === 0);

  return { score, matched, proven, overscope, redlineSoft, outOfScope, redHit, topLevel };
}

// ③ 客戶品質:付款驗證 + 花費 + 聘用率 + 評分
function scoreClient(j) {
  let s = 0;
  s += j.payment_verified ? 35 : 0; // 付款驗證(原 25,加重)
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
    else s -= 15; // 0% hire rate 直接扣分(原本 +0,新手要避)
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
  const b = String(j.proposals_bucket || '').toLowerCase();
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
  const d = String(j.description || '');
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
  // 🎈 期望≫預算(畫大餅):企業級願景/多功能清單卻配小預算 = Pragyan 型,風險升高
  const sbm = scopeBudgetMismatch(j);
  if (sbm.hit) s -= sbm.severity >= 2 ? 22 : 12;
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

  // 🎯 第一單目標:小而明確好客戶的案。Gemini review:不偽造維度分,改在 verdict 階段直接拉 APPLY。
  const isNewbie = config.scoring?.mode === 'newbie';
  const connectsHot = config.scoring?.connectsHot ?? 16; // 可調:超過此 Connects 才算超熱門(2026 漲價)
  const firstReview = isNewbie && isFirstReviewTarget(j, config);

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
  const b = String(j.proposals_bucket || '').toLowerCase();
  const crowded = /15 to 20|20 to 50|50/.test(b);

  // 💀 死亡訊號攔截:命中以下訊號 ≥ 2 個 → 強制 SKIP(新手投了等於燒 Connects)
  // (isNewbie 已於上方計算;客戶數值欄位一律 toNum 防髒資料字串如 "0")
  const hireRate = toNum(j.client_hire_rate);
  const jobsPosted = toNum(j.client_jobs_posted) ?? 0;
  const spentUsd = toNum(j.client_spent_usd);
  const deathSignals = [];
  // 明確未付款驗證才算;null/undefined(未 enrich)不計(Codex review:抓不到不誤殺)
  if (j.payment_verified === 0 || j.payment_verified === false) deathSignals.push('未付款驗證');
  if (hireRate === 0 && jobsPosted >= 1) deathSignals.push(`hire rate 0%(${jobsPosted}案`);
  if (/50/.test(b)) deathSignals.push('提案 50+');
  // 2026-06 砍掉重練:移除「spent=0」死亡訊號 —— 付款已驗證、只是還沒花錢的全新客戶,
  // 對新手反而常更好搶(第一次發案、沒老手關係)。未驗證的爛客戶已由上面 payment_verified 那條涵蓋。

  // 🚨 詐騙/違規硬擋(任一命中即 SKIP)— 跳出平台付款/聯絡、加密貨幣、股權分潤替代報酬、無償試做(Codex challenge)
  const jtext = `${j.title || ''} ${j.description || ''}`.toLowerCase();
  // 注意:必須是「付款語境」才算,避免誤殺正當的加密/股權「題材」案(如 scrape crypto prices、equity trading dashboard)
  const scamFlags = [];
  if (/pay(?:ment|ments)?\s+(?:outside|off)\b|outside\s+(?:of\s+)?upwork|off[\s-]?platform\s+(?:pay|payment)|take (?:this|it) off upwork|move (?:this )?off upwork|contact me (?:on|via) (?:telegram|whatsapp)/.test(jtext)) scamFlags.push('要求跳出 Upwork 付款/聯絡');
  // 加密貨幣:只在「付款」語境(pay/paid/payment/salary/compensation 鄰近)才算,不抓題材
  if (/(?:pay(?:ment|ments|ing)?|paid|salary|compensat\w*|wage)[^.]{0,30}\b(?:usdt|btc|eth|crypto|cryptocurrency|bitcoin|tether)\b|\b(?:usdt|crypto|bitcoin)\b[^.]{0,20}(?:payment|only|wallet|per task)/.test(jtext)) scamFlags.push('加密貨幣付款');
  if (/equity[\s-]?only|in exchange for equity|equity[\s-]?based (?:pay|comp)|(?:paid|pay|compensat\w*)[^.]{0,20}(?:equity|revenue[\s-]?share|profit[\s-]?share)|revenue[\s-]?share (?:instead|in lieu|only)/.test(jtext)) scamFlags.push('股權/分潤替代報酬');
  if (/unpaid\s+(?:test|task|trial|assessment|sample)|free\s+(?:test|trial)\s+(?:task|project|work)|no payment for (?:the )?test|test task[^.]{0,30}(?:unpaid|free|no pay)/.test(jtext)) scamFlags.push('無償試做');

  // 🙅 非開發角色(招募/小編/行政/客服等掛羊頭案)— 不是你的領域,直接擋
  const nonDevRole = isNonDevRole(j);

  // 🥊 新手競爭可行性訊號(can-win,與「客戶品質」無關)——
  // 抓住「②能力分很高、客戶也 OK,但 0 評價新手實際搶不到」這類案。資料抓不到的訊號不計(不誤殺)。
  const competeSignals = [];
  if (isNewbie) {
    if (isSeniorExpertJob(j)) competeSignals.push('Expert/資深等級(0 評價搶不過老手)');
    const cr = toNum(j.connects_required);
    // Gemini review:2026 Upwork connects 漲價 → 門檻用 config.connectsHot(預設16),避免餓死 leads
    if (cr != null && cr >= connectsHot) competeSignals.push(`需 ${cr} Connects(超熱門,新手提案沉底)`);
    const lvl = proposalBucketLevel(j.proposals_bucket);
    if (lvl === '20-50') competeSignals.push('提案 20-50(紅海,新手難被看到)');
    if (isLargeScope(j)) competeSignals.push('大型/長期案無明確第一里程碑(新手吃不下)');
    // 2026-06 砍掉重練:拔掉「貼出>24h」假訊號 —— 使用者沒有 API、永遠事後才看到案子,
    // 那條會對幾乎每個他看得到的案誤觸發,等於預設半殺。改用真新鮮度訊號:客戶是否已在面試
    // (interviewing,只在 refresh 抓到時計;抓不到=null=不誤殺)。雇主非按時間順序挑人,
    // interviewing=0 代表「客戶還在收集、沒開始篩」= 你還來得及。
    const intv = toNum(j.interviewing);
    if (intv != null && intv > 0) competeSignals.push(`客戶已面試 ${intv} 人(在挑了,你較晚進場)`);
    // 客戶上限低到「連你的底價都低於它」→ 你得跌破底價才進得了範圍 = 贏不了(非報酬好壞,是搶不到)
    // 用 hourlyFloor 而非 target,避免把一堆 $15-24 仍可投的案誤降(那些只是報酬偏低,不是搶不到)
    const floor = config.rate?.hourlyFloor;
    if (j.budget_type === 'hourly' && floor != null && j.hourly_max != null && j.hourly_max < floor) {
      competeSignals.push(`預算上限 $${j.hourly_max} < 你的底價 $${floor}(得跌破底價才進範圍)`);
    }
  }

  // 🥊 新帳號硬擋(hardWinBlocks)— 命中即強制 SKIP(newbie)。接既有 can-win,不另建系統。
  const hardWinBlocks = [];
  if (isNewbie) {
    const expertSenior = isSeniorExpertJob(j);
    const lvl = proposalBucketLevel(j.proposals_bucket);
    const cr = toNum(j.connects_required);
    const crHigh = cr != null && cr >= connectsHot; // Gemini review:connect 漲價,門檻用 config.connectsHot
    const hireZero = hireRate === 0 && jobsPosted >= 1;
    if (expertSenior && (lvl === '20-50' || lvl === '50+')) hardWinBlocks.push(`Expert/資深 + 提案${lvl}(陪榜)`);
    if (expertSenior && hireZero) hardWinBlocks.push('Expert/資深 + 客戶 0% 聘用');
    if (expertSenior && crHigh) hardWinBlocks.push(`Expert/資深 + 需 ${cr} Connects`);
    if (lvl === '50+' && ((j.payment_verified === 0 || j.payment_verified === false) || (spentUsd != null && spentUsd < 100) || crHigh)) {
      hardWinBlocks.push('提案 50+ 且 付款未驗證/花費<$100/高Connects');
    }
    // 註:hireZero + spentZero 已由既有 deathSignals ≥2 涵蓋,不重複加。
  }

  let verdict, reason;
  const deadClient = hireRate === 0 && jobsPosted >= 3;
  const deathHit = deathSignals.length;
  // 🗣️ 語言/在地案:身分即可交付,不吃②能力門(nonDevRole/紅線/能力圈外),客戶品質直接定 verdict
  const languageCase = isLanguageCase(j);

  // ─────────────────────────────────────────────────────────────────────
  // 統一閘門(2026-06 砍掉重練)— 只有「真正該死」才 SKIP。
  // 舊版有 5 套重疊硬殺(deathSignals / deadClient / hardWinBlocks / competeSignals≥2 /
  // lowPay+crowded),把一半案子殺成 SKIP;列表頁又預設只顯示 APPLY → 使用者「找不到案子」。
  // 新規則只硬殺四類:① 詐騙/違規 ② 非開發角色 ③ 客戶確定爛(死亡訊號達標 / 0%聘用+發過3案)
  // ④ Expert×紅海/爛客戶 的鐵組合(hardWinBlocks)。
  // 其餘「新手較難搶 / 低薪 / 畫大餅」一律放行成 APPLY/MAYBE,於下方降級並標明原因,
  // 讓使用者自己決定要不要花 Connects —— 系統提供判斷,不替他藏案子。
  // ─────────────────────────────────────────────────────────────────────
  if (scamFlags.length) {
    verdict = 'SKIP';
    reason = `🚨 詐騙/違規訊號:${scamFlags.join('、')} — 絕對別投`;
  } else if (languageCase) {
    // 🗣️ 語言/在地案分支:繞過 nonDevRole/紅線/能力圈外(不吃開發能力門),但爛客戶仍要擋
    const summary = `${j.client_spent_text || (spentUsd != null ? `$${spentUsd} spent` : '花費未知')}、評分 ${j.client_rating ?? '未知'}(${j.client_reviews ?? 0}則)、提案 ${j.proposals_bucket || '未知'}`;
    if ((isNewbie && deathHit >= 2) || deathHit >= 3 || deadClient) {
      verdict = 'SKIP';
      total = Math.min(total, 30);
      const deathReason = deathSignals.length ? deathSignals.join('、') : `雇用率0%(發了${j.client_jobs_posted}案沒雇人)`;
      reason = `🗣️ 語言/在地案(華語/台語/台灣身分即可交付,不吃開發能力門)— 但 💀 客戶死亡訊號:${deathReason} — 別投 — ${summary}`;
    } else if (j.payment_verified === 0 || j.payment_verified === false) {
      verdict = 'SKIP';
      total = Math.min(total, 30);
      reason = `🗣️ 語言/在地案(華語/台語/台灣身分即可交付,不吃開發能力門)— 付款未驗證,別投 — ${summary}`;
    } else {
      const clientGood = !!j.payment_verified &&
        ((spentUsd ?? 0) >= 1000 || (toNum(j.client_rating) >= 4.5 && (toNum(j.client_reviews) ?? 0) >= 5));
      if (clientGood) {
        verdict = 'APPLY';
        total = 72;
        reason = `🗣️ 語言/在地案(華語/台語/台灣身分即可交付,不吃開發能力門)— 客戶優質,值得投 — ${summary}`;
      } else {
        verdict = 'MAYBE';
        total = 55;
        reason = `🗣️ 語言/在地案(華語/台語/台灣身分即可交付,不吃開發能力門)— 客戶普通,可考慮 — ${summary}`;
      }
    }
  } else if (nonDevRole) {
    verdict = 'SKIP';
    reason = '🙅 非開發角色(招募/小編/行政/客服/業務等)— 不是你的領域,別投';
  } else if ((isNewbie && deathHit >= 2) || deathHit >= 3) {
    verdict = 'SKIP';
    reason = `💀 客戶死亡訊號 (${deathHit}個):${deathSignals.join('、')} — 別投`;
  } else if (deadClient) {
    verdict = 'SKIP';
    reason = `排除:雇用率0%(發了${j.client_jobs_posted}案沒雇人)`;
  } else if (hardWinBlocks.length) {
    verdict = 'SKIP';
    reason = `🥊 新帳號搶不到 (${hardWinBlocks.length}):${hardWinBlocks.join('、')} — 別燒 Connects`;
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

  // 🚪 第二道門(能力)硬攔截:blocked=1 → 不進 AI 快篩/分析(省成本)。
  // ① 紅線在 title / 核心 ② 完全能力圈外 → SKIP;③ 紅線只順帶提及 → 軟標不擋。
  // 🗣️ 語言案繞過此門(身分即可交付,不吃開發能力門;上面分支已自行判過客戶/死亡訊號)。
  let blocked = 0;
  if (!languageCase) {
    if (nonDevRole) blocked = 1;
    if (sk.overscope) {
      verdict = 'SKIP'; blocked = 1;
      reason = `🚫 第二道門·紅線「${sk.redHit.join('/')}」(核心技術,不碰)— ${reason}`;
    } else if (sk.outOfScope) {
      verdict = 'SKIP'; blocked = 1;
      reason = `🚫 第二道門·能力圈外(無技能命中,非你的領域)— ${reason}`;
    } else if (sk.redlineSoft) {
      if (verdict === 'APPLY') verdict = 'MAYBE';
      reason = `⚠️ 含紅線「${sk.redHit.join('/')}」(順帶提及,核心是你強項,自行判斷)— ${reason}`;
    }
  }

  // ── 軟降級:不殺,只把 APPLY 壓到 MAYBE 並標明原因(讓你自己權衡值不值得 Connects)──
  // 這些都是「dev 導向」訊號(Expert/Connects/紅海/低薪/畫大餅),語言案不吃(通道判準見上方分支)。
  if (!languageCase) {
    // ① 競爭可行性:命中任一(Expert/高Connects/紅海/客戶面試中/超預算)→ 最多 MAYBE。
    //    舊版命中 ≥2 直接 SKIP 是過度防衛 —— 你已有 1 個交付案,這類案是「較難」不是「不可能」。
    if (competeSignals.length && verdict === 'APPLY') verdict = 'MAYBE';
    if (competeSignals.length && (verdict === 'APPLY' || verdict === 'MAYBE')) {
      const extra = competeSignals.length > 1 ? `(+${competeSignals.length - 1})` : '';
      reason = `🥊 ${competeSignals[0]}${extra} — ${reason}`;
    }
    // ② 低薪(±紅海):不殺,降 MAYBE。低薪又紅海確實是燒 Connects 雷,但留給你自己判(可用「🦴撿漏」過濾)。
    if (lowPay && verdict === 'APPLY') verdict = 'MAYBE';
    if (lowPay && (verdict === 'APPLY' || verdict === 'MAYBE')) {
      reason = `💰 預算偏低${crowded ? '+競爭多' : ''} — ${reason}`;
    }

    // 🎯 第一單目標:小而明確好客戶 → 拉回 APPLY(無 can-win 紅旗、非低薪時)
    if (firstReview && !blocked && !lowPay && verdict === 'MAYBE'
        && total >= (config.scoring.maybeThreshold ?? 45) && competeSignals.length === 0) {
      verdict = 'APPLY';
    }
    if (firstReview && !blocked && (verdict === 'APPLY' || verdict === 'MAYBE')) {
      reason = `🎯 第一單目標 — ${reason}`;
    }
    // 🎈 期望≫預算(畫大餅 / Pragyan 型客戶):surface 警示。放在 firstReview 之後 → 有最終否決權:
    //    新手 + 重度(整套願景 × 一長串功能 × 小預算)→ APPLY 降 MAYBE,別一頭栽進註定的範圍拉鋸。
    const sbm = scopeBudgetMismatch(j);
    if (sbm.hit && (verdict === 'APPLY' || verdict === 'MAYBE')) {
      if (isNewbie && sbm.severity >= 2 && verdict === 'APPLY') verdict = 'MAYBE';
      reason = `${sbm.reason} — ${reason}`;
    }
  }

  // 🚫 不要 boost 提示(可投但不值得 boost 的案;web.js 另有完整顯示)
  const cd = connectsDiscipline(j, connectsHot);
  if (cd.noBoost && (verdict === 'APPLY' || verdict === 'MAYBE')) {
    reason = `${reason} ｜🚫 不要 boost(${cd.reasons[0]})`;
  }

  // 🔒 第二道門擋下的案(非開發職/紅線/能力圈外)→ 規則總分封頂 35,別讓它們在「AI 還沒評分」的視窗
  // 用 total_score×35 的 EV 排到真正契合案前面(三堂會審 #2:銷售/招聘/QA/SDET tot 原本 92-97 霸榜)。
  if (blocked) total = Math.min(total, 35);

  // 🗣️ 語言案標 category='語言案'(供 run-triage.js 跳過 AI 快篩 + 列表分類用)。
  // 非語言案絕對不帶 category key(讓 rescore.js 的 Object.assign 不去動已由功能地圖 AI 設好的 category)。
  const result = { scores, total_score: total, verdict, reason, blocked, matched_skills: sk.matched };
  if (languageCase) result.category = '語言案';
  return result;
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
