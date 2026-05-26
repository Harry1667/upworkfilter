// `npm run web` — 看案子 + 設定評分標準的網頁(讀/寫 jobs.db 與 config.json)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, markApplied, allJobs, upsertJob } from './db.js';
import { scoreJob, parseSpentUsd } from './score.js';
import { analyzeJob, askAI } from './analyze.js';
import { loadProfile, saveProfile, coverLetterPrompt, advicePrompt, replyPrompt, extractJson } from './assist.js';

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

const loadConfig = () => {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // 帶入 Profile Agent 歸納的「有 GitHub 證據」技術,供評分作品契合加成
  try { cfg.provenTechs = loadProfile().provenTechs || []; } catch { cfg.provenTechs = []; }
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
  nav a{margin-right:14px;font-size:14px;text-decoration:none}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .filters button{background:var(--card);color:var(--tx);border:1px solid var(--bd);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:13px}
  .filters button.on{background:var(--ac);border-color:var(--ac);color:#fff}
  main{max-width:860px;margin:0 auto;padding:18px}
  .card{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:12px;padding:16px;margin-bottom:14px}
  .card.v-APPLY{border-left-color:var(--grn)} .card.v-MAYBE{border-left-color:var(--ylw)} .card.v-SKIP{border-left-color:var(--red);opacity:.7}
  .top{display:flex;align-items:center;gap:10px}
  .score{font-size:24px;font-weight:700;min-width:40px}
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
  .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .open{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;padding:7px 14px;border-radius:8px;font-size:13px}
  .gen{background:#1f6f3f;color:#fff;border:0;padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer}
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
  .save{background:var(--grn);color:#fff;border:0;padding:11px 22px;border-radius:9px;font-size:15px;cursor:pointer}
  .save:hover{filter:brightness(1.1)}
`;

function trackCls(v) { return v < 34 ? 'track low' : v < 67 ? 'track mid' : 'track'; }

function pageJobs() {
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  const data = db.prepare('SELECT * FROM jobs ORDER BY total_score DESC, last_seen DESC').all();
  const counts = data.reduce((a, j) => ((a[j.verdict] = (a[j.verdict] || 0) + 1), a), {});
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
      return `
      <article class="card v-${j.verdict}" data-verdict="${j.verdict}" data-applied="${j.applied}">
        <div class="top">
          <span class="score">${j.total_score}</span>
          <span class="badge ${j.verdict}">${j.verdict}</span>
          <label class="applied"><input type="checkbox" ${j.applied ? 'checked' : ''} onchange="mark('${j.id}',this.checked)"> 已投</label>
        </div>
        <h2><a href="${esc(cleanUrl(j))}" target="_blank" rel="noopener">${esc(j.title)}</a></h2>
        <p class="reason">${esc(j.reason)}</p>
        <div class="grid7">${metrics}</div>
        <div class="tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>
        <div class="acts">
          <a class="open" href="${esc(cleanUrl(j))}" target="_blank" rel="noopener">在 Upwork 開啟 ↗</a>
          <button class="gen" onclick="cover('${j.id}',this)">✍️ 求職信</button>
          <button class="gen" onclick="advice('${j.id}',this)">💡 建議</button>
          <button class="gen" onclick="gen('${j.id}',this)">🌐 評估網站</button>
        </div>
      </article>`;
    })
    .join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Upwork 案子篩選</title><style>${CSS}</style></head><body>
<header>
  <h1>Upwork 案子篩選 <span class="sub">APPLY ${counts.APPLY || 0} · MAYBE ${counts.MAYBE || 0} · SKIP ${counts.SKIP || 0} · 共 ${data.length} · 門檻 ${cfg.scoring.threshold}</span></h1>
  <nav><a href="/"><b>📋 案子</b></a><a href="/reply">💬 客戶回覆</a><a href="/profile">👤 我的檔案</a><a href="/settings">⚙️ 評分設定</a></nav>
  <div class="filters">
    <button data-f="APPLY" class="on">🟢 值得投</button><button data-f="MAYBE">🟡 可考慮</button>
    <button data-f="SKIP">🔴 排除</button><button data-f="applied">已投</button><button data-f="all">全部</button>
  </div>
</header>
<main>${cards || '<p style="color:var(--mut)">資料庫是空的。擴充套件抓到案子後會出現在這。</p>'}</main>
<div id="modal" style="display:none;position:fixed;inset:0;background:#000a;z-index:50;padding:30px;overflow:auto" onclick="if(event.target.id==='modal')this.style.display='none'">
  <div style="max-width:680px;margin:0 auto;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <b id="mtitle" style="font-size:16px"></b>
      <button onclick="document.getElementById('modal').style.display='none'" style="background:none;border:0;color:var(--mut);font-size:20px;cursor:pointer">✕</button>
    </div>
    <button id="mcopy" class="save" style="padding:6px 12px;font-size:13px;margin-bottom:10px;display:none" onclick="navigator.clipboard.writeText(document.getElementById('mbody').dataset.copy||document.getElementById('mbody').innerText);this.textContent='✅ 已複製'">📋 複製</button>
    <div id="mbody" style="white-space:pre-wrap;font-size:14px;line-height:1.7"></div>
  </div>
</div>
<script>
  const cards=[...document.querySelectorAll('.card')];
  function showModal(title,html,copyText){document.getElementById('mtitle').textContent=title;
    const b=document.getElementById('mbody');b.innerHTML=html;b.dataset.copy=copyText||'';
    document.getElementById('mcopy').style.display=copyText?'inline-block':'none';
    document.getElementById('modal').style.display='block';}
  async function cover(id,btn){const t=btn.textContent;btn.disabled=true;btn.textContent='寫作中…';
    try{const r=await fetch('/api/cover-letter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
      const j=await r.json();if(j.ok)showModal('✍️ 求職信(英文,可複製)',j.text.replace(/</g,'&lt;'),j.text);else alert(j.error||'失敗');}
    catch(e){alert(e.message);}btn.disabled=false;btn.textContent=t;}
  async function advice(id,btn){const t=btn.textContent;btn.disabled=true;btn.textContent='分析中…';
    try{const r=await fetch('/api/advice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
      const j=await r.json();if(j.ok){const d=j.data;
        const html='<b>該主打作品:</b><br>'+(d.showPortfolio||[]).map(x=>'• '+x).join('<br>')+
          '<br><br><b>投標應附:</b><br>'+(d.submit||[]).map(x=>'• '+x).join('<br>')+
          '<br><br><b>報價:</b>'+(d.priceSuggestion||'')+'<br><b>切入角度:</b>'+(d.angle||'');
        showModal('💡 接案建議',html);}else alert(j.error||'失敗');}
    catch(e){alert(e.message);}btn.disabled=false;btn.textContent=t;}
  function f(x){document.querySelectorAll('.filters button').forEach(b=>b.classList.toggle('on',b.dataset.f===x));
    cards.forEach(c=>{let s=x==='all'?1:x==='applied'?c.dataset.applied==='1':c.dataset.verdict===x;c.style.display=s?'':'none';});}
  document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>f(b.dataset.f));f('APPLY');
  async function mark(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});
    document.querySelector('input[onchange*="'+id+'"]').closest('.card').dataset.applied=a?'1':'0';}
  async function gen(id,btn){const t=btn.textContent;btn.disabled=true;btn.textContent='產生中…(約30-60秒,看 gstack 視窗)';
    try{const r=await fetch('/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
      const j=await r.json();
      if(j.ok){btn.textContent='✅ 開啟中…';window.open('/analysis?id='+(j.id||id),'_blank');}
      else btn.textContent='❌ '+(j.error||'失敗');}
    catch(e){btn.textContent='❌ '+e.message;}
    setTimeout(()=>{btn.disabled=false;btn.textContent=t;},8000);}
</script></body></html>`;
}

function pageSettings() {
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  const rows = CRIT_ORDER.map((k) => {
    const c = C[k];
    return `<div class="srow">
      <div class="lbl"><b>${c.label}</b><small>${esc(c.desc)}</small></div>
      <input type="range" min="0" max="40" value="${c.weight}" data-k="${k}" oninput="upd()">
      <span class="val"><b class="w" data-k="${k}">${c.weight}</b>%</span>
    </div>`;
  }).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>評分設定</title><style>${CSS}</style></head><body>
<header>
  <h1>⚙️ 評分設定 <span class="sub">調整各維度權重與門檻,存檔後自動重算所有案子</span></h1>
  <nav><a href="/">📋 案子</a><a href="/settings"><b>⚙️ 評分設定</b></a></nav>
</header>
<main>
  <p class="reason">每個案子在 7 個維度各打 0-100 分,依下面權重加權成總分(0-100)。權重不必剛好 100%,系統會自動正規化。</p>
  ${rows}
  <div id="sum" class="sumbar ok">權重合計:<span id="sumv">100</span>%</div>
  <div class="thr">
    <div><label>🟢 APPLY 門檻(總分 ≥ 幾分算「值得投」)</label><input id="thr" type="number" min="0" max="100" value="${cfg.scoring.threshold}"></div>
    <div><label>🟡 MAYBE 門檻(≥ 幾分算「可考慮」)</label><input id="mthr" type="number" min="0" max="100" value="${cfg.scoring.maybeThreshold}"></div>
  </div>
  <button class="save" onclick="save()">💾 儲存並重算所有案子</button>
  <p id="msg" class="reason" style="margin-top:12px"></p>
</main>
<script>
  function upd(){let s=0;document.querySelectorAll('input[type=range]').forEach(r=>{
    document.querySelector('.w[data-k="'+r.dataset.k+'"]').textContent=r.value;s+=+r.value;});
    document.getElementById('sumv').textContent=s;
    document.getElementById('sum').className='sumbar '+(s>0?'ok':'bad');}
  upd();
  async function save(){
    const weights={};document.querySelectorAll('input[type=range]').forEach(r=>weights[r.dataset.k]=+r.value);
    const body={weights,threshold:+document.getElementById('thr').value,maybeThreshold:+document.getElementById('mthr').value};
    document.getElementById('msg').textContent='重算中…';
    const r=await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    document.getElementById('msg').innerHTML=j.ok?('✅ 已儲存並重算!→ <a href="/">回案子列表看新結果</a>'):'❌ 失敗:'+j.error;
  }
</script></body></html>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function navBar(active) {
  const link = (href, label) => `<a href="${href}"${active === href ? ' style="font-weight:700;color:var(--tx)"' : ''}>${label}</a>`;
  return `<nav>${link('/', '📋 案子')}${link('/reply', '💬 客戶回覆')}${link('/profile', '👤 我的檔案')}${link('/settings', '⚙️ 評分設定')}</nav>`;
}

function pageProfile() {
  const p = loadProfile();
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的檔案</title><style>${CSS}
  textarea{width:100%;min-height:480px;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:14px;font:13px/1.6 ui-monospace,Menlo,monospace}</style></head><body>
<header><h1>👤 我的檔案 <span class="sub">所有 AI 功能(求職信/回覆/建議)都讀這份來為你量身</span></h1>${navBar('/profile')}</header>
<main>
  <p class="reason">這是 JSON 格式,已照你之前的資料預填。改完按儲存。技能、作品集(name/type/desc/tech/link)、求職信規則都可調。</p>
  <p class="reason">🤖 <b>Profile Agent</b>:自動抓你的 GitHub(${esc(p.githubUser || 'Harry1667')})歸納「已證明能力」,寫進 provenCapabilities/provenTechs,並讓有真實 repo 證據的案子適配度加成。${p.provenUpdatedAt ? `上次更新:${esc(p.provenUpdatedAt.slice(0, 16).replace('T', ' '))},共 ${(p.provenCapabilities || []).length} 項。` : '尚未執行。'}</p>
  <p><button class="save" onclick="runAgent()">🤖 執行 Profile Agent(抓 GitHub,約 1-2 分)</button> <span id="amsg" class="reason"></span></p>
  <textarea id="p">${esc(JSON.stringify(p, null, 2))}</textarea>
  <p><button class="save" onclick="save()">💾 儲存檔案</button> <span id="msg" class="reason"></span></p>
</main>
<script>
  async function save(){let body;try{body=JSON.parse(document.getElementById('p').value);}catch(e){document.getElementById('msg').textContent='❌ JSON 格式錯誤:'+e.message;return;}
    const r=await fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    document.getElementById('msg').textContent=(await r.json()).ok?'✅ 已儲存':'❌ 失敗';}
  async function runAgent(){const m=document.getElementById('amsg');m.textContent='執行中…抓 GitHub + AI 歸納 + 重算分數(約 1-2 分,勿關閉)';
    try{const r=await fetch('/api/agent/profile',{method:'POST'});const j=await r.json();
      if(j.ok){m.textContent='✅ 完成:'+j.count+' 項已證明能力。重新整理頁面看更新後的檔案。';}
      else m.textContent='❌ '+(j.error||'失敗');}
    catch(e){m.textContent='❌ '+e.message;}}
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
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"找不到此案"}');
      }
      const r = await analyzeJob(job); // 抓取 + ProxyCLI AI + 產 HTML(較久)
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r));
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
      const cfg = loadConfig();
      for (const k of CRIT_ORDER) {
        if (body.weights && body.weights[k] != null) cfg.scoring.criteria[k].weight = Number(body.weights[k]);
      }
      if (body.threshold != null) cfg.scoring.threshold = Number(body.threshold);
      if (body.maybeThreshold != null) cfg.scoring.maybeThreshold = Number(body.maybeThreshold);
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      rescoreAll();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/analysis') { // 檢視已產生的評估網站(雲端用)
      const id = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '');
      const f = path.join(__dirname, '..', `upwork-${id}-analysis.html`);
      if (!id || !existsSync(f)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('找不到評估網站,請先在案件卡片按「產生評估網站」。');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(f, 'utf8'));
    }
    if (url.pathname === '/settings') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageSettings());
    }
    if (url.pathname === '/profile') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageProfile());
    }
    if (url.pathname === '/reply') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(pageReply());
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageJobs());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}).listen(PORT, HOST, () => {
  console.log(`\n🌐 網頁:http://${HOST}:${PORT}   (設定頁:/settings)`);
  console.log(`   登入:${DASH_PASSWORD ? 'ON(需帳密)' : 'OFF(本機開放)'} | ingest 金鑰:${process.env.INGEST_KEY ? 'ON' : 'OFF'}\n   Ctrl+C 關閉。\n`);
});
