// `npm run web` — 看案子 + 設定評分標準的網頁(讀/寫 jobs.db 與 config.json)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, markApplied, allJobs, upsertJob, setAiVerdict } from './db.js';
import { scoreJob, parseSpentUsd } from './score.js';
import { askAI, analyzeJob } from './analyze.js';
import { loadProfile, saveProfile, coverLetterPrompt, advicePrompt, replyPrompt, extractJson } from './assist.js';
import { loadTaxonomy, toView } from './taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
// 部署用:可由環境變數設定。本機留預設即可。
try { if (existsSync(path.join(__dirname, '..', '.env'))) process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASSWORD = process.env.DASH_PASSWORD || ''; // 設了才啟用 dashboard 登入
const db = openDb();

// dashboard 登入(HTTP Basic Auth)。/api/ingest 不走這個(用 INGEST_KEY)。
function checkDashAuth(req, res) {
  if (!DASH_PASSWORD) return true; // 沒設密碼 = 本機開放
  const h = req.headers.authorization || '';
  const m = h.match(/^Basic (.+)$/);
  if (m) {
    const [u, p] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (u === DASH_USER && p === DASH_PASSWORD) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Upwork Job Finder"', 'content-type': 'text/plain; charset=utf-8' });
  res.end('需要登入');
  return false;
}

// 原始 config(未套用模式)— 寫入時用,避免把模式覆蓋值存回檔案
const loadConfigRaw = () => {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  try { cfg.provenTechs = loadProfile().provenTechs || []; } catch { cfg.provenTechs = []; }
  return cfg;
};
// 評分用 config:依 scoring.mode(newbie/standard)把對應權重與門檻套進 criteria
// 新手模式強調勝率(競爭/能力高、報酬低);標準模式用 criteria 原始 weight。
const loadConfig = () => {
  const cfg = loadConfigRaw();
  const s = cfg.scoring || {};
  if (s.mode === 'newbie' && s.newbieWeights) {
    for (const k of CRIT_ORDER) {
      if (s.criteria[k] && s.newbieWeights[k] != null) s.criteria[k].weight = s.newbieWeights[k];
    }
    if (s.newbieThreshold != null) s.threshold = s.newbieThreshold;
    if (s.newbieMaybeThreshold != null) s.maybeThreshold = s.newbieMaybeThreshold;
  }
  return cfg;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CRIT_ORDER = ['reward', 'skill', 'client', 'competition', 'longterm', 'clarity', 'risk'];
const COL = { reward: 'score_reward', skill: 'score_skill', client: 'score_client', competition: 'score_competition', longterm: 'score_longterm', clarity: 'score_clarity', risk: 'score_risk' };

// 用新 config 重算 DB 所有案子的分數
function rescoreAll() {
  const cfg = loadConfig();
  for (const row of allJobs(db)) {
    const job = { ...row, payment_verified: !!row.payment_verified, enriched: !!row.enriched };
    Object.assign(job, scoreJob(job, cfg));
    upsertJob(db, job);
  }
}

const CSS = `
  :root{--bg:#0d1117;--card:#161b22;--bd:#272e3a;--tx:#e6edf3;--mut:#8b949e;--grn:#2ea043;--ylw:#bb8009;--red:#6e7681;--ac:#4493f8}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,"PingFang TC",Segoe UI,sans-serif}
  a{color:var(--ac)}
  header{position:sticky;top:0;background:#0d1117ee;backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);padding:14px 20px;z-index:9}
  h1{font-size:18px;margin:0 0 10px;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  h1 .sub{color:var(--mut);font-size:13px;font-weight:400}
  nav a{margin-right:14px;font-size:14px;text-decoration:none;color:var(--mut)}
  nav.zones a{padding:4px 0;border-bottom:2px solid transparent}
  nav.zones a.on{color:var(--tx);font-weight:700;border-bottom-color:var(--ac)}
  nav .navsep{color:var(--bd);margin-right:14px}
  .flowhint{margin-top:10px;font-size:13px;color:var(--mut)}.flowhint b{color:var(--tx)}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .filters button{background:var(--card);color:var(--tx);border:1px solid var(--bd);padding:6px 15px;border-radius:20px;cursor:pointer;font-size:13px;transition:.15s}
  .filters button:hover{border-color:var(--ac)}
  .filters button.on{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
  main{max-width:860px;margin:0 auto;padding:18px}
  .card{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:12px;padding:16px;margin-bottom:14px}
  .card.v-APPLY{border-left-color:var(--grn)} .card.v-MAYBE{border-left-color:var(--ylw)} .card.v-SKIP{border-left-color:var(--red);opacity:.7}
  .top{display:flex;align-items:center;gap:10px}
  .score{font-size:24px;font-weight:700;min-width:40px}.score .smax{font-size:13px;color:var(--mut);font-weight:400}
  .aitag{font-size:10px;font-weight:700;background:#2d2150;color:#b392f0;padding:2px 7px;border-radius:5px;border:1px solid #4a3a6a;letter-spacing:.5px}
  .badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px}
  .badge.APPLY{background:#1a3a26;color:#3fb950}.badge.MAYBE{background:#3a3016;color:#d29922}.badge.SKIP{background:#21262d;color:#8b949e}
  .applied{margin-left:auto;font-size:13px;color:var(--mut);cursor:pointer;user-select:none}
  h2{font-size:16px;margin:10px 0 6px}h2 a{color:var(--tx);text-decoration:none}h2 a:hover{color:var(--ac)}
  .reason{color:var(--mut);font-size:13px;margin:0 0 12px}
  .grid7{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px 14px;margin-bottom:10px}
  .m{font-size:12px;color:var(--mut)}.m b{color:var(--tx);font-weight:600}
  .track{height:5px;background:#0d1117;border-radius:3px;overflow:hidden;margin-top:3px}.track i{display:block;height:100%;background:var(--ac)}
  .track.low i{background:#da3633}.track.mid i{background:#d29922}
  .tags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  .tags span{background:#0d1117;border:1px solid var(--bd);border-radius:6px;padding:2px 8px;font-size:12px;color:var(--mut)}
  .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:4px}
  /* 次要動作:描邊低調;主要動作(.primary):填色突出 */
  .open{display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--tx);border:1px solid var(--bd);text-decoration:none;padding:8px 15px;border-radius:9px;font-size:13px;font-weight:500;transition:.15s;cursor:pointer}
  .open:hover{border-color:var(--ac);color:var(--ac);background:#4493f815}
  .open.primary{background:var(--ac);color:#fff;border-color:var(--ac);font-weight:700;box-shadow:0 1px 8px #4493f840}
  .open.primary:hover{filter:brightness(1.12);color:#fff;background:var(--ac)}
  .gen{background:#1f6f3f;color:#fff;border:0;padding:8px 15px;border-radius:9px;font-size:13px;cursor:pointer;font-weight:600;transition:.15s}
  .gen:hover{filter:brightness(1.15)}.gen:disabled{opacity:.7;cursor:wait}
  /* settings */
  .srow{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .srow .lbl{flex:1}.srow .lbl b{font-size:15px}.srow .lbl small{display:block;color:var(--mut);font-size:12px}
  .srow input[type=range]{width:160px}.srow .val{width:54px;text-align:right;font-variant-numeric:tabular-nums}
  .sumbar{padding:12px 16px;border-radius:10px;margin:14px 0;font-weight:600}
  .sumbar.ok{background:#1a3a26;color:#3fb950}.sumbar.bad{background:#3a1a1a;color:#f85149}
  .thr{display:flex;gap:24px;flex-wrap:wrap;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-bottom:14px}
  .thr label{display:block;font-size:13px;color:var(--mut);margin-bottom:6px}
  .thr input{width:90px;background:#0d1117;border:1px solid var(--bd);color:var(--tx);border-radius:6px;padding:6px 10px;font-size:15px}
  .save{display:inline-flex;align-items:center;gap:6px;background:var(--grn);color:#fff;border:0;padding:11px 22px;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s;box-shadow:0 1px 10px #2ea04340}
  .save:hover{filter:brightness(1.12);transform:translateY(-1px)}
  .save:active{transform:translateY(0)}
  .save:disabled{opacity:.55;cursor:wait;transform:none;box-shadow:none}
`;

function trackCls(v) { return v < 34 ? 'track low' : v < 67 ? 'track mid' : 'track'; }

// AI verdict 可能夾帶說明(如「觀望 - 預算不符…」)→ 用關鍵字判定,不做精確比對
function aiVerdictShort(v) {
  v = String(v || '');
  for (const k of ['強力接', '可接', '觀望', '略過']) if (v.includes(k)) return k;
  return v.slice(0, 4) || '未知';
}
function aiVerdictClass(v) {
  const k = aiVerdictShort(v);
  if (k === '強力接' || k === '可接') return 'APPLY';
  if (k === '觀望') return 'MAYBE';
  return 'SKIP';
}
// 一個案最終要顯示的判斷:有 AI 分析就以 AI 為準,否則用規則
// 回傳 { score, scoreMax, verdict(短), note(完整), cls, isAi }
function effectiveVerdict(j) {
  if (j.ai_score != null && j.ai_verdict) {
    return { score: j.ai_score, scoreMax: 10, verdict: aiVerdictShort(j.ai_verdict), note: j.ai_verdict, cls: aiVerdictClass(j.ai_verdict), isAi: true };
  }
  return { score: j.total_score, scoreMax: 100, verdict: j.verdict, note: '', cls: j.verdict, isAi: false };
}

function pageJobs() {
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  const data = db.prepare('SELECT * FROM jobs ORDER BY total_score DESC, last_seen DESC').all();
  const counts = data.reduce((a, j) => { const c = effectiveVerdict(j).cls; a[c] = (a[c] || 0) + 1; return a; }, {});
  // 動線提示:今日新案 + 未處理(值得投但還沒投)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayNew = data.filter((j) => (j.first_seen || '').slice(0, 10) === todayStr).length;
  const todo = data.filter((j) => effectiveVerdict(j).cls === 'APPLY' && !j.applied).length;
  const cards = data
    .map((j) => {
      const tags = [];
      if (j.payment_verified) tags.push('✅ 付款驗證');
      if (j.client_spent_text) tags.push('💰 ' + esc(j.client_spent_text.replace(/\s*spent/i, '').trim()));
      if (j.client_hire_rate != null) tags.push('雇用 ' + j.client_hire_rate + '%');
      if (j.client_rating != null) tags.push('★ ' + j.client_rating);
      if (j.proposals_bucket) tags.push('提案 ' + esc(j.proposals_bucket));
      if (j.budget_text) tags.push(esc(j.budget_text));
      const metrics = CRIT_ORDER.map((k) => {
        const v = j[COL[k]] ?? 0;
        return `<div class="m"><b>${C[k].label}</b> ${v}<div class="${trackCls(v)}"><i style="width:${v}%"></i></div></div>`;
      }).join('');
      const ev = effectiveVerdict(j);
      const scoreHtml = ev.isAi
        ? `<span class="score">${ev.score}<span class="smax">/10</span></span><span class="aitag">AI</span>`
        : `<span class="score">${ev.score}</span>`;
      return `
      <article class="card v-${ev.cls}" data-verdict="${ev.cls}" data-applied="${j.applied}">
        <div class="top">
          ${scoreHtml}
          <span class="badge ${ev.cls}">${esc(ev.verdict)}</span>
          <label class="applied"><input type="checkbox" ${j.applied ? 'checked' : ''} onchange="mark('${j.id}',this.checked)"> 已投</label>
        </div>
        <h2><a href="${esc(cleanUrl(j))}" target="_blank" rel="noopener">${esc(j.title)}</a></h2>
        <p class="reason">${esc(j.reason)}</p>
        <div class="grid7">${metrics}</div>
        <div class="tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>
        <div class="acts">
          <a class="open primary" href="/job?id=${j.id}">② 評估 →</a>
          <a class="open" href="/proposal?id=${j.id}">③ 提案 →</a>
          <a class="open" href="${esc(cleanUrl(j))}" target="_blank" rel="noopener">Upwork ↗</a>
        </div>
      </article>`;
    })
    .join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Upwork 案子篩選</title><style>${CSS}</style></head><body>
<header>
  <h1>📋 探索案件 <span class="sub">APPLY ${counts.APPLY || 0} · MAYBE ${counts.MAYBE || 0} · SKIP ${counts.SKIP || 0} · 共 ${data.length} · 門檻 ${cfg.scoring.threshold}</span></h1>
  ${navBar('/')}
  <div class="flowhint">🆕 今日新案 <b>${todayNew}</b> · ⏳ 待處理(值得投未投) <b>${todo}</b></div>
  <div class="filters">
    <button data-f="APPLY" class="on">🟢 值得投</button><button data-f="MAYBE">🟡 可考慮</button>
    <button data-f="SKIP">🔴 排除</button><button data-f="applied">已投</button><button data-f="all">全部</button>
  </div>
</header>
<main>${cards || '<p style="color:var(--mut)">資料庫是空的。擴充套件抓到案子後會出現在這。</p>'}</main>
<script>
  const cards=[...document.querySelectorAll('.card')];
  function f(x){document.querySelectorAll('.filters button').forEach(b=>b.classList.toggle('on',b.dataset.f===x));
    cards.forEach(c=>{let s=x==='all'?1:x==='applied'?c.dataset.applied==='1':c.dataset.verdict===x;c.style.display=s?'':'none';});}
  document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>f(b.dataset.f));f('APPLY');
  async function mark(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});
    document.querySelector('input[onchange*="'+id+'"]').closest('.card').dataset.applied=a?'1':'0';}
</script></body></html>`;
}

// 👤 我的檔案:友善表單(非 JSON)— 身分 / 技能 / 作品集 / 求職信規則 + Profile Agent
function pageProfile() {
  const p = loadProfile();
  const v = (x) => esc(x == null ? '' : x);
  const skills = (p.skills || []).join(', ');
  const rules = (p.coverLetterStyle?.rules || []).join('\n');
  const portfolioRows = (p.portfolio || []).map((it, i) => portfolioRow(it, i)).join('');
  const capList = (p.provenCapabilities || [])
    .map((c) => `<li><b>${esc(c.repo)}</b> — ${esc(c.capability)}<br><small style="color:var(--mut)">[${esc((c.techs || []).join(' / '))}]</small></li>`)
    .join('') || '<li class="reason">尚未執行 Profile Agent。</li>';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的檔案</title><style>${CSS}
  .form label{display:block;color:var(--mut);font-size:13px;margin:14px 0 4px}
  .form input,.form textarea{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font:14px/1.6 inherit}
  .form textarea{min-height:80px}.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .port{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin:10px 0}
  .port input{margin-bottom:6px}.port .x{float:right;background:none;border:0;color:#f85149;cursor:pointer;font-size:16px}
  .caps li{margin:8px 0}h2{border-left:3px solid var(--grn);padding-left:10px}</style></head><body>
<header><h1>👤 我的檔案 <span class="sub">「我是誰」— AI 寫求職信/回覆/建議都讀這份</span></h1>${navBar('/profile')}</header>
<main class="form">
  <h2>基本資料</h2>
  <div class="row2">
    <div><label>姓名</label><input id="f_name" value="${v(p.name)}"></div>
    <div><label>定位 Title</label><input id="f_title" value="${v(p.title)}"></div>
  </div>
  <div class="row2">
    <div><label>等級 / 階段</label><input id="f_level" value="${v(p.level)}"></div>
    <div><label>時薪(USD)</label><input id="f_rate" type="number" value="${v(p.hourlyRate)}"></div>
  </div>
  <label>自我介紹 Bio</label><textarea id="f_bio">${v(p.bio)}</textarea>
  <label>報價備註</label><input id="f_rateNote" value="${v(p.rateNote)}">

  <h2>技能(逗號分隔)</h2>
  <textarea id="f_skills">${esc(skills)}</textarea>

  <h2>作品集</h2>
  <div id="ports">${portfolioRows}</div>
  <button class="save" style="background:#30363d" onclick="addPort()">＋ 新增作品</button>

  <h2>求職信規則(一行一條)</h2>
  <textarea id="f_rules" style="min-height:160px">${esc(rules)}</textarea>

  <p style="margin-top:16px"><button class="save" onclick="save()">💾 儲存檔案</button> <span id="msg" class="reason"></span></p>

  <h2 style="margin-top:30px">🤖 Profile Agent(已證明能力)</h2>
  <p class="reason">自動抓 GitHub(<b>${esc(p.githubUser || 'Harry1667')}</b>)歸納「已證明能力」,讓有真實 repo 證據的案子適配度加成、求職信引用真實作品。${p.provenUpdatedAt ? `上次更新:${esc(p.provenUpdatedAt.slice(0, 16).replace('T', ' '))},共 ${(p.provenCapabilities || []).length} 項。每週一自動刷新。` : '尚未執行。'}</p>
  <p><button class="save" onclick="runAgent()">🤖 立即執行(約 1-2 分)</button> <span id="amsg" class="reason"></span></p>
  <ul class="caps">${capList}</ul>
</main>
<script>
  // 原始 profile(保留表單沒涵蓋的欄位,存檔時合併回去)
  const BASE=${JSON.stringify(p)};
  function portTpl(it){it=it||{};return '<div class="port"><button class="x" onclick="this.parentNode.remove()">✕</button>'+
    '<input class="p_name" placeholder="名稱" value="'+(it.name||'').replace(/"/g,'&quot;')+'">'+
    '<input class="p_type" placeholder="類型" value="'+(it.type||'').replace(/"/g,'&quot;')+'">'+
    '<input class="p_desc" placeholder="描述" value="'+(it.desc||'').replace(/"/g,'&quot;')+'">'+
    '<input class="p_tech" placeholder="技術(逗號分隔)" value="'+((it.tech||[]).join(', ')).replace(/"/g,'&quot;')+'">'+
    '<input class="p_link" placeholder="連結" value="'+(it.link||'').replace(/"/g,'&quot;')+'"></div>';}
  function addPort(){document.getElementById('ports').insertAdjacentHTML('beforeend',portTpl({}));}
  function save(){
    const ports=[...document.querySelectorAll('.port')].map(p=>({
      name:p.querySelector('.p_name').value.trim(),type:p.querySelector('.p_type').value.trim(),
      desc:p.querySelector('.p_desc').value.trim(),
      tech:p.querySelector('.p_tech').value.split(',').map(s=>s.trim()).filter(Boolean),
      link:p.querySelector('.p_link').value.trim()})).filter(x=>x.name);
    const body=Object.assign({},BASE,{
      name:f_name.value.trim(),title:f_title.value.trim(),level:f_level.value.trim(),
      hourlyRate:Number(f_rate.value)||BASE.hourlyRate,bio:f_bio.value.trim(),rateNote:f_rateNote.value.trim(),
      skills:f_skills.value.split(',').map(s=>s.trim()).filter(Boolean),
      portfolio:ports,
      coverLetterStyle:Object.assign({},BASE.coverLetterStyle,{rules:f_rules.value.split('\\n').map(s=>s.trim()).filter(Boolean)})});
    fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(r=>r.json()).then(j=>{document.getElementById('msg').textContent=j.ok?'✅ 已儲存':'❌ 失敗';});}
  async function runAgent(){const m=document.getElementById('amsg');m.textContent='執行中…抓 GitHub + AI 歸納 + 重算分數(約 1-2 分,勿關閉)';
    try{const r=await fetch('/api/agent/profile',{method:'POST'});const j=await r.json();
      m.textContent=j.ok?('✅ 完成:'+j.count+' 項已證明能力。重新整理看更新。'):'❌ '+(j.error||'失敗');}
    catch(e){m.textContent='❌ '+e.message;}}
</script></body></html>`;
}

// 作品集單列(伺服器端初始渲染)
function portfolioRow(it, i) {
  const a = (s) => esc(s == null ? '' : s);
  return `<div class="port"><button class="x" onclick="this.parentNode.remove()">✕</button>
    <input class="p_name" placeholder="名稱" value="${a(it.name)}">
    <input class="p_type" placeholder="類型" value="${a(it.type)}">
    <input class="p_desc" placeholder="描述" value="${a(it.desc)}">
    <input class="p_tech" placeholder="技術(逗號分隔)" value="${a((it.tech || []).join(', '))}">
    <input class="p_link" placeholder="連結" value="${a(it.link)}"></div>`;
}

// ⚖️ 評分引擎:新手/標準模式切換 + 權重滑桿 + 門檻
function pageScoring() {
  const cfg = loadConfig();        // 已套用啟用模式的權重
  const C = cfg.scoring.criteria;
  const mode = cfg.scoring.mode === 'newbie' ? 'newbie' : 'standard';
  const rows = CRIT_ORDER.map((k) => {
    const c = C[k];
    return `<div class="srow">
      <div class="lbl"><b>${c.label}</b><small>${esc(c.desc)}</small></div>
      <input type="range" min="0" max="40" value="${c.weight}" data-k="${k}" oninput="upd()">
      <span class="val"><b class="w" data-k="${k}">${c.weight}</b>%</span>
    </div>`;
  }).join('');
  const tag = (m, label, desc) => `<button class="modebtn ${m === mode ? 'on' : ''}" onclick="setMode('${m}')">${label}<small>${desc}</small></button>`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>評分引擎</title><style>${CSS}
  .modes{display:flex;gap:10px;margin:6px 0 18px}
  .modebtn{flex:1;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:12px;cursor:pointer;text-align:left}
  .modebtn small{display:block;color:var(--mut);font-size:12px;margin-top:3px}
  .modebtn.on{border-color:var(--ac);background:#13233b}</style></head><body>
<header><h1>⚖️ 評分引擎 <span class="sub">「案子好不好」— 決定哪些案被推到你面前</span></h1>${navBar('/scoring')}</header>
<main>
  <h3 style="margin:4px 0">評分模式</h3>
  <div class="modes">
    ${tag('newbie', '🌱 新手模式', '強調勝率:競爭/能力高、報酬低。0 評價衝首單用')}
    ${tag('standard', '⚖️ 標準模式', '均衡:報酬與能力並重,適合有評價後')}
  </div>
  <p class="reason">切換模式會即時重算所有案子。下面滑桿是「<b>${mode === 'newbie' ? '新手' : '標準'}模式</b>」目前的權重,可微調。每維 0-100,依權重加權成總分;權重不必剛好 100%,系統自動正規化。</p>
  ${rows}
  <div id="sum" class="sumbar ok">權重合計:<span id="sumv">100</span>%</div>
  <div class="thr">
    <div><label>🟢 APPLY 門檻(≥ 幾分算「值得投」)</label><input id="thr" type="number" min="0" max="100" value="${cfg.scoring.threshold}"></div>
    <div><label>🟡 MAYBE 門檻(≥ 幾分算「可考慮」)</label><input id="mthr" type="number" min="0" max="100" value="${cfg.scoring.maybeThreshold}"></div>
  </div>
  <button class="save" onclick="saveScoring()">💾 儲存並重算所有案子</button>
  <p id="smsg" class="reason" style="margin-top:12px"></p>
</main>
<script>
  const MODE=${JSON.stringify(mode)};
  function upd(){let s=0;document.querySelectorAll('input[type=range]').forEach(r=>{
    document.querySelector('.w[data-k="'+r.dataset.k+'"]').textContent=r.value;s+=+r.value;});
    document.getElementById('sumv').textContent=s;document.getElementById('sum').className='sumbar '+(s>0?'ok':'bad');}
  upd();
  async function setMode(m){if(m===MODE)return;
    document.getElementById('smsg').textContent='切換中…重算所有案子';
    const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m})});
    if((await r.json()).ok)location.reload();}
  async function saveScoring(){
    const weights={};document.querySelectorAll('input[type=range]').forEach(r=>weights[r.dataset.k]=+r.value);
    const body={mode:MODE,weights,threshold:+document.getElementById('thr').value,maybeThreshold:+document.getElementById('mthr').value};
    document.getElementById('smsg').textContent='重算中…';
    const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    document.getElementById('smsg').innerHTML=j.ok?('✅ 已儲存並重算!→ <a href="/">回列表看新結果</a>'):'❌ 失敗:'+j.error;}
</script></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// 統一導航 — 6 個職責單一的獨立介面。
// 流程:① 列表 → ② 評估 → ③ 提案 → ④ 溝通 ｜ 設定:👤 檔案 · ⚖️ 評分
// jobId:目前在看的案(讓「② 評估 / ③ 提案」連到該案);沒有則連到無 id 頁(提示挑案)
function navBar(active, jobId) {
  const link = (href, label, on) => `<a href="${href}"${on ? ' class="on"' : ''}>${label}</a>`;
  const q = jobId ? `?id=${jobId}` : '';
  return `<nav class="zones">${link('/', '① 列表', active === '/')}${link('/job' + q, '② 評估', active === '/job')}${link('/proposal' + q, '③ 提案', active === '/proposal')}${link('/reply', '④ 溝通', active === '/reply')}<span class="navsep">｜</span>${link('/features', '🧩 功能地圖', active === '/features')}${link('/profile', '👤 檔案', active === '/profile')}${link('/scoring', '⚖️ 評分', active === '/scoring')}</nav>`;
}

// 🧩 功能地圖:把同類案子彙整成「大類 → 小功能(含難度/工具/頻率/相依)」
// 不開發,只記錄這類案子通常需要哪些功能。資料來自 npm run features 掃描。
function pageFeatures() {
  const tax = loadTaxonomy();
  const view = toView(tax);
  const dCls = { 低: 'ok', 中: 'mid', 高: 'bad' };
  const updated = tax.updatedAt ? esc(tax.updatedAt.slice(0, 16).replace('T', ' ')) : '尚未掃描';

  const cats = view.map((c) => {
    const rows = c.features.map((f) => {
      const tools = (f.tools || []).map((t) => `<span>${esc(t)}</span>`).join('') || '<span class="reason">—</span>';
      const deps = (f.depends || []).length ? `<div class="dep">↳ 需先:${(f.depends).map(esc).join('、')}</div>` : '';
      return `<tr>
        <td><b>${esc(f.name)}</b>${f.note ? `<div class="reason">${esc(f.note)}</div>` : ''}${deps}</td>
        <td class="${dCls[f.difficulty] || ''}" style="text-align:center;white-space:nowrap">${esc(f.difficulty)}</td>
        <td style="text-align:center"><b>${f.frequency}</b></td>
        <td><div class="tags">${tools}</div></td>
      </tr>`;
    }).join('');
    return `<details class="catbox" open>
      <summary><span class="cn">${esc(c.name)}</span> <span class="reason">${c.jobCount || 0} 個案 · ${c.features.length} 個功能</span></summary>
      <table class="ftab">
        <tr><th>小功能</th><th>難度</th><th>出現案數</th><th>常用工具 / API</th></tr>
        ${rows || '<tr><td colspan="4" class="reason">尚無功能</td></tr>'}
      </table>
    </details>`;
  }).join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>功能地圖</title><style>${CSS}
  .scan{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 16px}
  .scan input{flex:1;min-width:200px;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;font-size:14px}
  .catbox{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:8px 16px 14px;margin-bottom:14px}
  .catbox summary{cursor:pointer;font-size:16px;padding:8px 0;list-style:none}
  .catbox summary .cn{font-weight:700}
  .ftab{width:100%;border-collapse:collapse;margin-top:6px}
  .ftab th,.ftab td{border:1px solid var(--bd);padding:8px 10px;text-align:left;font-size:13px;vertical-align:top}
  .ftab th{background:#0d1117;color:var(--mut);font-weight:600}
  .ftab .tags{margin:0}.dep{font-size:12px;color:var(--ac);margin-top:3px}
  .ok{color:#3fb950}.mid{color:#d29922}.bad{color:#f85149}</style></head><body>
<header><h1>🧩 功能地圖 <span class="sub">同類案子需要哪些功能 · 更新:${updated}</span></h1>${navBar('/features')}</header>
<main>
  <p class="reason">輸入工作類型(關鍵字),系統去 Upwork 爬同類案子、用 AI 歸納出「這類案子通常需要哪些小功能」並標難度/工具/出現頻率。<b>只記錄功能,不開發</b>。一次可輸入多個,用逗號分隔。</p>
  <div class="scan">
    <input id="q" placeholder="例如:chatbot, voice assistant, web scraping">
    <button class="save" id="go" onclick="scan()">🔍 掃描功能</button>
  </div>
  <p id="st" class="reason"></p>
  ${cats || '<p class="reason">還沒有資料。在上面輸入工作類型按「掃描功能」,或在終端機跑 <code>npm run features -- "chatbot"</code>。</p>'}
</main>
<script>
  async function scan(){
    const q=document.getElementById('q').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(!q.length){alert('請先輸入工作類型關鍵字');return;}
    const btn=document.getElementById('go'),st=document.getElementById('st');
    btn.disabled=true;st.textContent='掃描中…(爬案子 + AI 歸納,每個關鍵字約 1-3 分,勿關閉)';
    try{const r=await fetch('/api/scan-features',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({queries:q})});
      const j=await r.json();
      if(j.ok){st.textContent='✅ 完成,重新整理中…';location.reload();}
      else st.textContent='❌ '+(j.error||'失敗');}
    catch(e){st.textContent='❌ '+e.message;}
    btn.disabled=false;}
</script></body></html>`;
}

function pageReply() {
  const jobs = db.prepare("SELECT id,title FROM jobs ORDER BY last_seen DESC LIMIT 50").all();
  const opts = ['<option value="">(不綁定特定案子)</option>'].concat(jobs.map((j) => `<option value="${j.id}">${esc(j.title.slice(0, 50))}</option>`)).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>客戶回覆助手</title><style>${CSS}
  textarea,select{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:12px;font-size:14px}
  textarea{min-height:140px;font-family:inherit}label{display:block;color:var(--mut);font-size:13px;margin:12px 0 4px}
  .out{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px;margin-top:14px;white-space:pre-wrap}</style></head><body>
<header><h1>💬 客戶回覆助手 <span class="sub">貼上客戶訊息,AI 幫你擬專業回覆 + 提醒</span></h1>${navBar('/reply')}</header>
<main>
  <label>客戶傳來的訊息</label>
  <textarea id="msg" placeholder="把客戶在 Upwork 訊息/面試裡說的話貼進來…"></textarea>
  <label>相關案子(選填,綁定後回覆更貼合)</label>
  <select id="job">${opts}</select>
  <label>語氣</label>
  <select id="tone"><option>專業友善</option><option>熱情積極</option><option>簡潔直接</option><option>謹慎正式</option></select>
  <p style="margin-top:14px"><button class="save" onclick="go()">✨ 產生回覆</button> <span id="st" class="reason"></span></p>
  <div id="result" style="display:none">
    <button class="save" style="padding:6px 12px;font-size:13px" onclick="navigator.clipboard.writeText(document.getElementById('reply').innerText);this.textContent='✅ 已複製'">📋 複製回覆</button>
    <div class="out" id="reply"></div>
    <div class="out" id="tips" style="border-color:#bb8009"></div>
  </div>
</main>
<script>
  async function go(){const msg=document.getElementById('msg').value.trim();if(!msg){alert('請先貼上客戶訊息');return;}
    document.getElementById('st').textContent='產生中…(約30秒)';
    try{const r=await fetch('/api/reply',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({message:msg,id:document.getElementById('job').value,tone:document.getElementById('tone').value})});
      const j=await r.json();document.getElementById('st').textContent='';
      if(j.ok){document.getElementById('reply').textContent=j.data.reply||'';
        document.getElementById('tips').innerHTML='<b>⚠️ 提醒:</b><br>'+(j.data.tips||[]).map(x=>'• '+x).join('<br>');
        document.getElementById('result').style.display='block';}
      else document.getElementById('st').textContent='❌ '+(j.error||'失敗');}
    catch(e){document.getElementById('st').textContent='❌ '+e.message;}}
</script></body></html>`;
}

// 規則式勝率估計(不花 AI)— 給新手一個「接不接得到」的直覺
function winRateHint(job) {
  const comp = job.score_competition ?? 0;     // 競爭越低分越高(提案少)
  const skill = job.score_skill ?? 0;          // 能力匹配(含作品契合)
  const client = job.score_client ?? 0;
  // 加權:競爭 45%、能力 40%、客戶 15%(能不能被看到 + 做不做得來)
  const pct = Math.round(comp * 0.45 + skill * 0.40 + client * 0.15);
  let level, color;
  if (pct >= 70) { level = '高'; color = 'var(--grn)'; }
  else if (pct >= 45) { level = '中'; color = 'var(--ylw)'; }
  else { level = '低'; color = '#f85149'; }
  const bits = [];
  if (comp >= 75) bits.push('提案數少、容易被看到'); else if (comp <= 30) bits.push('競爭激烈、難出頭');
  if (skill >= 80) bits.push('能力高度吻合(有作品證據)'); else if (skill < 50) bits.push('技能匹配偏弱');
  if (client < 40) bits.push('客戶條件普通');
  return { pct, level, color, note: bits.join('、') || '條件中性' };
}

// 共用:單一案頂部資訊列(評估/提案頁共用)
function jobBarHtml(job, active) {
  const back = active === '/proposal' ? `<a href="/job?id=${job.id}">← 回評估</a>` : `<a href="/">← 回列表</a>`;
  return `<div class="jobbar">
    ${back}
    <a href="${esc(cleanUrl(job))}" target="_blank" rel="noopener">🔗 Upwork 原案 ↗</a>
    <label class="applied"><input type="checkbox" ${job.applied ? 'checked' : ''} onchange="markJob('${job.id}',this.checked)"> 標記已投</label>
  </div>`;
}
const notFoundPage = (title, active, id) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>
<header><h1>${title}</h1>${navBar(active)}</header>
<main><p class="reason">${id ? '找不到這個案(可能已從資料庫移除)。' : '請從 <a href="/">① 列表</a> 挑一個案。'}</p></main></body></html>`;

// ② 評估:純判斷 — 核心數據 + 7維評分 + 勝率 + 工作內容。不產文案(去 ③ 提案)
function pageJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return notFoundPage('② 評估', '/job', id);
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  const wr = winRateHint(job);
  const ev = effectiveVerdict(job);
  const verdictLine = ev.isAi
    ? `AI 判斷 ${ev.score}/10 · ${esc(ev.verdict)}　|　規則快篩 ${job.total_score}/100`
    : `規則快篩 ${job.total_score}/100 · ${job.verdict}`;
  const aid = String(id).replace(/[^\w-]/g, '');
  const hasAnalysis = existsSync(path.join(__dirname, '..', `upwork-${aid}-analysis.html`));
  const core = [
    ['預算', job.budget_text], ['類型', job.budget_type], ['提案數', job.proposals_bucket],
    ['付款驗證', job.payment_verified ? '✅ 是' : '❌ 否'], ['客戶花費', job.client_spent_text],
    ['雇用率', job.client_hire_rate != null ? job.client_hire_rate + '%' : null],
    ['客戶評分', job.client_rating != null ? '★ ' + job.client_rating : null], ['發布', job.posted_text]
  ].filter(([, v]) => v != null && v !== '');
  const coreCards = core.map(([l, v]) => `<div class="c"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const metrics = CRIT_ORDER.map((k) => {
    const v = job[COL[k]] ?? 0;
    return `<div class="m"><b>${C[k].label}</b> ${v}<div class="${trackCls(v)}"><i style="width:${v}%"></i></div></div>`;
  }).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>評估:${esc(job.title)}</title><style>${CSS}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:8px}
  .cards .c{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px}.c .l{color:var(--mut);font-size:12px}.c .v{font-size:15px;font-weight:600;margin-top:2px}
  .winbox{display:flex;align-items:center;gap:16px;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:8px 0}
  .winpct{font-size:34px;font-weight:800}.desc{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;white-space:pre-wrap;font-size:14px;line-height:1.7;max-height:340px;overflow:auto}
  .jobbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.jobbar a,.jobbar label{font-size:13px}
  .cta{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:6px 0}
  #anframe{width:100%;height:600px;border:1px solid var(--bd);border-radius:12px;background:#0d1117}</style></head><body>
<header>
  <h1>② 評估 <span class="sub">${verdictLine}</span></h1>
  ${navBar('/job', job.id)}
  ${jobBarHtml(job, '/job')}
</header>
<main>
  <h2 style="margin-top:4px">${esc(job.title)}</h2>
  <p class="reason">${esc(job.reason)}</p>
  ${ev.isAi
    ? `<p class="reason" style="color:#b392f0">🤖 AI 判斷:${esc(ev.note)}</p>`
    : '<p class="reason" style="color:#d29922">⚠️ 尚未做 AI 詳細分析。下方分數是規則快篩(可能高估報酬),建議產生 AI 分析取得更準的判斷。</p>'}

  <h2>🌐 AI 詳細分析</h2>
  <div id="anwrap">${hasAnalysis
    ? `<iframe id="anframe" src="/analysis?id=${aid}" onload="fit(this)"></iframe>
       <p style="margin-top:8px"><button class="save" style="background:#30363d;padding:7px 14px;font-size:13px" onclick="genAn()">🔄 重新產生</button> <span id="anmsg" class="reason"></span></p>`
    : `<p class="reason">AI 會抓案子內容做完整評估(摘要 / 工作內容 / 技術 / 客戶 / 競爭 / 求職信 / 勝率 / 加權評分),約 30-60 秒。</p>
       <p><button class="save" onclick="genAn()">🌐 產生 AI 詳細分析</button> <span id="anmsg" class="reason"></span></p>`}
  </div>

  <h2>核心數據</h2>
  <div class="cards">${coreCards}</div>

  <h2>勝率估計(接不接得到)</h2>
  <div class="winbox">
    <div class="winpct" style="color:${wr.color}">${wr.pct}%</div>
    <div><b style="color:${wr.color}">${wr.level}勝率</b><br><span class="reason">${esc(wr.note)}</span></div>
  </div>

  <h2>7 維評分(規則式)</h2>
  <div class="grid7" style="margin-bottom:8px">${metrics}</div>

  <h2>工作內容</h2>
  <div class="desc">${esc(job.description || '(擴充套件未帶描述)')}</div>

  <p style="margin-top:18px"><a class="cta" href="/proposal?id=${job.id}">③ 決定投了 → 去寫提案</a></p>
</main>
<script>
  const ID=${JSON.stringify(job.id)}, AID=${JSON.stringify(aid)};
  let anTimer;
  async function markJob(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});}
  function fit(f){try{f.style.height=(f.contentWindow.document.body.scrollHeight+40)+'px';}catch(e){}}
  function showIframe(){clearInterval(anTimer);document.getElementById('anwrap').innerHTML=
    '<iframe id="anframe" src="/analysis?id='+AID+'&t='+Date.now()+'" onload="fit(this)"></iframe>'+
    '<p style="margin-top:8px"><button class="save" style="background:#30363d;padding:7px 14px;font-size:13px" onclick="genAn()">🔄 重新產生</button> <span id="anmsg" class="reason"></span></p>';}
  // 連線中斷時:後端可能已在背景產生,探測 /analysis 是否已有檔
  async function probeOrFail(m,btns){
    try{const c=await fetch('/analysis?id='+AID+'&t='+Date.now(),{method:'HEAD'});if(c.ok){showIframe();return;}}catch(e){}
    m.textContent='❌ 連線逾時(AI 這次較慢)。請按「重新整理」或再產生一次。';btns.forEach(b=>b.disabled=false);}
  async function genAn(){const m=document.getElementById('anmsg');
    const btns=document.querySelectorAll('#anwrap button');btns.forEach(b=>b.disabled=true);
    let s=0;m.textContent='產生中…抓取+AI(勿關閉) 0s';
    anTimer=setInterval(()=>{m.textContent='產生中…抓取+AI(勿關閉) '+(++s)+'s';},1000);
    try{const r=await fetch('/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID})});
      clearInterval(anTimer);
      if(r.ok){const j=await r.json();if(j.ok)showIframe();else{m.textContent='❌ '+(j.error||'失敗');btns.forEach(b=>b.disabled=false);}}
      else await probeOrFail(m,btns);}
    catch(e){clearInterval(anTimer);await probeOrFail(m,btns);}}
</script></body></html>`;
}

// ③ 提案:生產 — 求職信 + 主打作品 + 建議附截圖 + 投標項 + 報價(AI,只在這裡花 token)
function pageProposal(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return notFoundPage('③ 提案', '/proposal', id);
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>提案:${esc(job.title)}</title><style>${CSS}
  .sect{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:14px 0}
  .sect h2{margin:0 0 10px;border:0;padding:0}.out{white-space:pre-wrap;font-size:14px;line-height:1.7;margin-top:10px}
  .jobbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.jobbar a,.jobbar label{font-size:13px}</style></head><body>
<header>
  <h1>③ 提案 <span class="sub">${esc(job.budget_text || '')} · 提案 ${esc(job.proposals_bucket || '?')}</span></h1>
  ${navBar('/proposal', job.id)}
  ${jobBarHtml(job, '/proposal')}
</header>
<main>
  <h2 style="margin-top:4px">${esc(job.title)}</h2>
  <p class="reason">按下方按鈕一次產生:求職信(引用真實作品)+ 投標策略。約 30-60 秒。</p>
  <p><button class="save" id="go" onclick="gen()">✨ 產生提案</button> <span id="st" class="reason"></span></p>

  <div class="sect" id="clsect" style="display:none">
    <h2>✍️ 求職信(英文,可複製)</h2>
    <button class="save" style="background:var(--grn);padding:6px 12px;font-size:13px" onclick="navigator.clipboard.writeText(window._cl||'');this.textContent='✅ 已複製'">📋 複製</button>
    <div class="out" id="clout"></div>
  </div>

  <div class="sect" id="adsect" style="display:none">
    <h2>💡 投標策略</h2>
    <div class="out" id="adout"></div>
  </div>
</main>
<script>
  const ID=${JSON.stringify(job.id)};
  async function markJob(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});}
  async function gen(){const btn=document.getElementById('go'),st=document.getElementById('st');
    btn.disabled=true;st.textContent='產生中…(求職信 + 策略,約30-60秒)';
    const cover=fetch('/api/cover-letter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID})}).then(r=>r.json());
    const adv=fetch('/api/advice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID})}).then(r=>r.json());
    try{
      const [c,a]=await Promise.all([cover,adv]);
      if(c.ok){window._cl=c.text;document.getElementById('clout').textContent=c.text;document.getElementById('clsect').style.display='block';}
      if(a.ok){const d=a.data;
        document.getElementById('adout').innerHTML='<b>該主打作品:</b><br>'+(d.showPortfolio||[]).map(x=>'• '+x).join('<br>')+
          (d.screenshot?'<br><br><b>建議附截圖:</b>'+d.screenshot:'')+
          '<br><br><b>投標應附:</b><br>'+(d.submit||[]).map(x=>'• '+x).join('<br>')+
          '<br><br><b>報價:</b>'+(d.priceSuggestion||'')+'<br><b>切入角度:</b>'+(d.angle||'');
        document.getElementById('adsect').style.display='block';}
      st.textContent=(c.ok||a.ok)?'✅ 完成':'❌ '+((c.error||a.error)||'失敗');
    }catch(e){st.textContent='❌ '+e.message;}
    btn.disabled=false;}
</script></body></html>`;
}

// 寬容取值:從多個可能的 key 取第一個有值的
const pick = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((a, kk) => (a == null ? a : a[kk]), o);
    if (v != null && v !== '') return v;
  }
  return undefined;
};

const ID_RE = /~([0-9a-f]+)/i;

// 把職缺連結整理成乾淨的正式網址(去掉 SEO slug 與追蹤參數)
function cleanUrl(j) {
  const m = String(j.url || '').match(ID_RE);
  return m ? `https://www.upwork.com/jobs/_~${m[1]}/` : (j.url || '');
}

// 把外部 webhook 送來的一筆職缺,正規化成我們的 job 物件
function normalizeIngest(raw) {
  const url = pick(raw, 'url', 'jobUrl', 'link', 'job_url', 'permalink', 'href') || '';
  const idm = String(url).match(ID_RE);
  const id = (idm ? idm[1] : null) || pick(raw, 'id', 'jobId', 'ciphertext', 'uid') || ('h' + Math.abs([...String(url || JSON.stringify(raw))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)));
  let desc = pick(raw, 'description', 'descriptionText', 'snippet', 'summary', 'jobDescription', 'text') || '';
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
    description: String(desc).slice(0, 4000),
    posted_text: pick(raw, 'posted', 'postedOn', 'publishedDate', 'datePosted', 'createdAt') || null,
    payment_verified: pv === true || /verified|^true$|是/i.test(String(pv ?? '')),
    proposals_bucket: String(pick(raw, 'proposals', 'proposalsBucket', 'applicants', 'totalApplicants') ?? '') || null,
    client_spent_text: spentText ? String(spentText) : null,
    client_spent_usd: parseSpentUsd(spentText),
    client_hire_rate: numOrNull(pick(raw, 'hireRate', 'clientHireRate', 'client.hireRate')),
    client_rating: numOrNull(pick(raw, 'clientRating', 'rating', 'client.rating', 'feedback')),
    client_reviews: numOrNull(pick(raw, 'reviews', 'reviewsCount', 'clientReviews', 'client.reviews')),
    client_jobs_posted: numOrNull(pick(raw, 'jobsPosted', 'clientJobsPosted', 'client.jobsPosted', 'postedJobs')),
    enriched: true
  };
  // 評分時把 clientRating=0 視為「無評價」(新客戶),避免被當成 0 分
  if (job.client_rating === 0) job.client_rating = null;
  Object.assign(job, parseBudget(budgetText));
  if (job.budget_type === 'unknown' && /hourly/i.test(jobType)) job.budget_type = 'hourly';
  if (job.budget_type === 'unknown' && /fixed/i.test(jobType)) job.budget_type = 'fixed';
  return job;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function parseBudget(text) {
  const t = String(text || '');
  if (!t) return { budget_type: 'unknown' };
  if (/hourly|\/hr|\/ hr/i.test(t)) {
    const nums = [...t.matchAll(/\$?\s*([\d.]+)/g)].map((m) => parseFloat(m[1])).filter((n) => !isNaN(n));
    return { budget_type: 'hourly', budget_text: t.slice(0, 30), hourly_min: nums[0] ?? null, hourly_max: nums[1] ?? nums[0] ?? null };
  }
  const fx = t.match(/\$\s*([\d.,]+)/);
  if (fx) return { budget_type: 'fixed', budget_text: t.slice(0, 30), fixed_budget: parseFloat(fx[1].replace(/,/g, '')) };
  return { budget_type: 'unknown', budget_text: t.slice(0, 30) };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // CORS:讓瀏覽器擴充套件能跨來源 POST 進來
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ingest-key, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') { // preflight
    res.writeHead(204);
    return res.end();
  }
  // /api/ingest 用 INGEST_KEY 驗證(擴充套件用);其餘頁面/API 用 dashboard 登入
  if (url.pathname !== '/api/ingest' && !checkDashAuth(req, res)) return;
  try {
    if (url.pathname === '/api/mark') {
      markApplied(db, url.searchParams.get('id'), url.searchParams.get('applied') === '1');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/ingest') {
      if (req.method === 'GET') { // 健康檢查 / 測試用
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true,"msg":"ingest endpoint live. POST job(s) here."}');
      }
      // 選用金鑰:.env 設 INGEST_KEY 時需帶 ?key= 或 X-Ingest-Key
      const key = process.env.INGEST_KEY;
      if (key && url.searchParams.get('key') !== key && req.headers['x-ingest-key'] !== key) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"unauthorized"}');
      }
      const cfg = loadConfig();
      const rawText = (await readBody(req)) || '{}';
      // 記錄原始 payload 以便對照欄位格式(寫檔 + 印前 600 字)
      try { (await import('node:fs')).writeFileSync(path.join(__dirname, '..', 'last-ingest.json'), rawText); } catch {}
      console.log('📥 ingest 原始 payload(前600字):', rawText.slice(0, 600));
      const body = JSON.parse(rawText);
      const list = Array.isArray(body) ? body : Array.isArray(body.jobs) ? body.jobs : Array.isArray(body.data) ? body.data : Array.isArray(body.results) ? body.results : [body];
      const results = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const job = normalizeIngest(raw);
        Object.assign(job, scoreJob(job, cfg));
        upsertJob(db, job);
        results.push({ id: job.id, title: job.title, verdict: job.verdict, score: job.total_score });
      }
      console.log(`📥 ingest:收到 ${list.length} 筆,入庫 ${results.length} 筆`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, ingested: results.length, results }));
    }
    if (url.pathname === '/api/agent/profile' && req.method === 'POST') {
      // 觸發 Profile Agent:抓 GitHub → 歸納 proven capabilities → 寫回 profile + 重算分數
      try {
        const { runProfileAgent } = await import('./agents/profile-agent.js');
        const r = await runProfileAgent({}); // user 預設讀 profile.githubUser / GITHUB_USER / Harry1667
        rescoreAll(); // 立即用新作品證據重算所有案子的適配度
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, count: r.count, provenTechs: r.provenTechs, capabilities: r.capabilities }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    if (url.pathname === '/api/cover-letter' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      const text = await askAI(coverLetterPrompt(job, loadProfile()));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, text: text.trim() }));
    }
    if (url.pathname === '/api/advice' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      const data = extractJson(await askAI(advicePrompt(job, loadProfile())));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === '/api/reply' && req.method === 'POST') {
      const { message, id, tone } = JSON.parse(await readBody(req));
      const job = id ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) : null;
      const data = extractJson(await askAI(replyPrompt(message, job, loadProfile(), tone)));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      saveProfile(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const cfg = loadConfigRaw(); // 用原始 config,避免把模式覆蓋值寫回
      const s = cfg.scoring;
      if (body.mode === 'newbie' || body.mode === 'standard') s.mode = body.mode;
      // 權重/門檻寫進「目標模式」對應的欄位(預設寫進目前啟用的模式)
      const target = body.mode || s.mode || 'standard';
      if (body.weights) {
        if (target === 'newbie') {
          s.newbieWeights = s.newbieWeights || {};
          for (const k of CRIT_ORDER) if (body.weights[k] != null) s.newbieWeights[k] = Number(body.weights[k]);
        } else {
          for (const k of CRIT_ORDER) if (body.weights[k] != null && s.criteria[k]) s.criteria[k].weight = Number(body.weights[k]);
        }
      }
      if (body.threshold != null) { if (target === 'newbie') s.newbieThreshold = Number(body.threshold); else s.threshold = Number(body.threshold); }
      if (body.maybeThreshold != null) { if (target === 'newbie') s.newbieMaybeThreshold = Number(body.maybeThreshold); else s.maybeThreshold = Number(body.maybeThreshold); }
      delete cfg.provenTechs; // 不要把衍生欄位寫進檔案
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      rescoreAll();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      const r = await analyzeJob(job); // 抓取(雲端用 DB 描述)+ ProxyCLI AI + 產 HTML
      // 以 AI 判斷為準:把 AI 的總分/verdict 存進 DB,卡片/評估頁優先顯示
      if (r.totalScore != null) setAiVerdict(db, id, Number(r.totalScore), r.verdict);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r));
    }
    if (url.pathname === '/analysis') { // 提供已產生的 AI 詳細分析 HTML(評估頁 iframe 內嵌)
      const aid = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '');
      const f = path.join(__dirname, '..', `upwork-${aid}-analysis.html`);
      if (!aid || !existsSync(f)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('尚未產生 AI 詳細分析。');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(f, 'utf8'));
    }
    if (url.pathname === '/job') { // ② 評估(判斷 + AI 詳細分析)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageJob((url.searchParams.get('id') || '').replace(/[^\w-]/g, '')));
    }
    if (url.pathname === '/proposal') { // ③ 提案(生產)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageProposal((url.searchParams.get('id') || '').replace(/[^\w-]/g, '')));
    }
    if (url.pathname === '/profile') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageProfile());
    }
    if (url.pathname === '/scoring' || url.pathname === '/settings' || url.pathname === '/setup') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageScoring()); // /settings、/setup 舊路由導向(back-compat)
    }
    if (url.pathname === '/reply') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageReply());
    }
    if (url.pathname === '/features') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageFeatures());
    }
    if (url.pathname === '/api/scan-features' && req.method === 'POST') {
      const { queries } = JSON.parse(await readBody(req));
      const list = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q || '').trim()).filter(Boolean);
      if (!list.length) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"請提供關鍵字"}'); }
      const { scanFeatures } = await import('./scan-features.js');
      const view = await scanFeatures(list);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, categories: view.length }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageJobs());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}).listen(PORT, HOST, () => {
  console.log(`\n🌐 網頁:http://${HOST}:${PORT}   (① 列表 / ② 評估 / ③ 提案 / ④ 溝通 ｜ 檔案 · 評分)`);
  console.log(`   登入:${DASH_PASSWORD ? 'ON(需帳密)' : 'OFF(本機開放)'} | ingest 金鑰:${process.env.INGEST_KEY ? 'ON' : 'OFF'}\n   Ctrl+C 關閉。\n`);
});
