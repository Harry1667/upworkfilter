// `npm run web` — 看案子 + 設定評分標準的網頁(讀/寫 jobs.db 與 config.json)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDb, markApplied, allJobs, upsertJob, setAiVerdict, setOutcome, upsertInvite, allInvites, getInvite, setInviteAi, setInviteStatus, addLesson, listLessons, setLessonEnabled, deleteLesson, addApplication, listApplications, getApplication, updateApplication, deleteApplication, applicationStats, addAnchor, listAnchors, setAnchorEnabled, deleteAnchor } from './db.js';

// 📌 loadProfileWithLessons — profile + 啟用中的 lessons + anchors,每個 prompt 都會看到
function loadProfileWithLessons() {
  const p = loadProfile();
  try {
    const db = openDb();
    p.lessons = listLessons(db, true).map((l) => l.content);
    p.anchors = listAnchors(db, true).slice(0, 3); // 最多 3 個範本,避免 prompt 爆
  } catch (e) { p.lessons = []; p.anchors = []; }
  return p;
}
import { scoreJob, parseSpentUsd, connectsDiscipline, isFirstReviewTarget } from './score.js';
import { askAI, analyzeJob } from './analyze.js';
import { loadProfile, saveProfile, coverLetterPrompt, coverLetterRefinePrompt, coverLetterWriterA, coverLetterWriterB, coverLetterWriterC, coverLetterSynthPrompt, advicePrompt, screeningPrompt, replyPrompt, chatPrompt, invitePrompt, extractJson } from './assist.js';
import { detectHallucinations, annotateCitations, skepticCritique, extractLessonCandidates, preflightCheck } from './verify.js';
import { loadTaxonomy, toView } from './taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
// 部署用:可由環境變數設定。本機留預設即可。
try { if (existsSync(path.join(__dirname, '..', '.env'))) process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const db = openDb();

// ── 共用驗證服務 hdw-auth(auth.twloop.com)整合 ──
// 後端打 /auth/login 拿 JWT → 存 HttpOnly cookie → 每次請求用 /auth/verify 驗(加快取省往返)
const AUTH_URL = process.env.AUTH_URL || 'https://auth.twloop.com';
const NO_AUTH = process.env.NO_AUTH === '1'; // 本機開發可關閉登入
const _verifyCache = new Map(); // token -> { user, until }

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}
async function authLogin(identifier, password) {
  const r = await fetch(`${AUTH_URL}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password })
  });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || '登入失敗');
  return b; // { token, user }
}
async function authVerify(token) {
  if (!token) return null;
  const c = _verifyCache.get(token);
  if (c && c.until > Date.now()) return c.user;
  try {
    const r = await fetch(`${AUTH_URL}/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
    });
    const b = await r.json();
    const user = b.valid ? b.user : null;
    if (user) _verifyCache.set(token, { user, until: Date.now() + 5 * 60 * 1000 }); // 快取 5 分
    return user;
  } catch { return null; }
}
async function authLogout(token) {
  _verifyCache.delete(token);
  try { await fetch(`${AUTH_URL}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }); } catch { /* ignore */ }
}
// 設/清 auth cookie(https 才加 Secure;本站目前 http)
function authCookie(req, token) {
  const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
  if (token) return `auth=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 7}${secure}`;
  return `auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
// 守衛:登入才放行。未登入 → 頁面導向 /login、API 回 401
async function requireAuth(req, res, isApi) {
  if (NO_AUTH) return { id: 'dev', email: 'dev', name: 'dev', isAdmin: true };
  const user = await authVerify(getCookie(req, 'auth'));
  if (user) return user;
  if (isApi) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"請先登入"}'); }
  else { res.writeHead(302, { Location: '/login' }); res.end(); }
  return null;
}

// 原始 config(未套用模式)— 寫入時用,避免把模式覆蓋值存回檔案
const loadConfigRaw = () => {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  // provenTechs + capability(分級能力)都來自 profile.json,供評分「能力匹配度」用
  try { const p = loadProfile(); cfg.provenTechs = p.provenTechs || []; cfg.capability = p.capability || null; }
  catch { cfg.provenTechs = []; cfg.capability = null; }
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
// id 安全化:用於 onclick/URL 等 JS 語境,只留安全字元(Upwork job/lesson/application id 本就是英數~-_),擋 XSS
const jid = (s) => String(s ?? '').replace(/[^a-zA-Z0-9_~-]/g, '');

const CRIT_ORDER = ['reward', 'skill', 'client', 'competition', 'longterm', 'clarity', 'risk'];
const COL = { reward: 'score_reward', skill: 'score_skill', client: 'score_client', competition: 'score_competition', longterm: 'score_longterm', clarity: 'score_clarity', risk: 'score_risk' };

// 背景:對剛 ingest 進來、還沒 AI 分數的案自動快篩(便宜 AI),不阻塞 ingest 回應
// 預設開啟;.env 設 AI_TRIAGE_ON_INGEST=0 可關。錯誤只記 log,不影響 ingest。
let _triageBusy = false;
let _scanBusy = false; // 功能地圖掃描同時只跑一輪
async function autoTriageIngested(ids) {
  if (_triageBusy || !ids || ids.length === 0) return; // 同時間只跑一輪,避免疊跑
  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM jobs WHERE ai_score IS NULL AND blocked=0 AND id IN (${placeholders})`).all(...ids);
    if (rows.length === 0) return;
    _triageBusy = true;
    const { triageJobs } = await import('./triage.js');
    console.log(`🤖 自動快篩:${rows.length} 個新案…`);
    const res = await triageJobs(rows, { outcomeNote: outcomeNoteText(computeOutcomeStats()) });
    for (const r of res) setAiVerdict(db, r.id, r.score, r.reason ? `${r.verdict} - ${r.reason}` : r.verdict, r.win, r.tags, r.parent);
    console.log(`🤖 自動快篩完成:${res.length} 案`);
  } catch (e) {
    console.error('自動快篩失敗:' + e.message);
  } finally {
    _triageBusy = false;
  }
}

// 🔁 學習迴路:從已標記 outcome 的案統計「AI 預測勝率 vs 真實結果」
// 正向 = 已回覆/面試中/已錄取(有獲得注意);負向 = 沒回/落選;已投待回 = pending(不列入率)
const _POS_OUTCOMES = new Set(['已回覆', '面試中', '已錄取']);
function computeOutcomeStats() {
  const rows = db.prepare(`SELECT ai_win, outcome, category FROM jobs
    WHERE outcome IS NOT NULL AND outcome != '' AND outcome != '已投待回'`).all();
  const bucketKey = (w) => (w == null ? 'none' : w >= 60 ? 'high' : w >= 40 ? 'mid' : 'low');
  const b = { high: { n: 0, pos: 0 }, mid: { n: 0, pos: 0 }, low: { n: 0, pos: 0 }, none: { n: 0, pos: 0 } };
  const cat = {};
  let won = 0;
  for (const r of rows) {
    const pos = _POS_OUTCOMES.has(r.outcome);
    const k = bucketKey(r.ai_win); b[k].n++; if (pos) b[k].pos++;
    if (r.outcome === '已錄取') won++;
    const c = (r.category || '其他').trim() || '其他';
    (cat[c] = cat[c] || { n: 0, pos: 0 }).n++; if (pos) cat[c].pos++;
  }
  const pending = db.prepare(`SELECT COUNT(*) c FROM jobs WHERE outcome='已投待回'`).get().c;
  return { decided: rows.length, won, pending, buckets: b, cat };
}
// 把實績濃縮成一句餵給 AI 快篩(樣本 <5 不餵,避免噪音誤導)
function outcomeNoteText(s) {
  if (!s || s.decided < 5) return '';
  const rate = (o) => (o.n ? Math.round((o.pos / o.n) * 100) : null);
  const parts = [];
  for (const [k, label] of [['high', '估≥60%'], ['mid', '估40-59%'], ['low', '估<40%']]) {
    const o = s.buckets[k]; if (o.n) parts.push(`${label}的案實際獲回應 ${o.pos}/${o.n}(${rate(o)}%)`);
  }
  const cats = Object.entries(s.cat).filter(([, o]) => o.n >= 2);
  const good = cats.filter(([, o]) => o.pos / o.n >= 0.4).map(([c]) => c);
  const bad = cats.filter(([, o]) => o.pos === 0).map(([c]) => c);
  let line = `【我的真實投標實績(校正用:共 ${s.decided} 案有結果,錄取 ${s.won})】${parts.join(';')}`;
  if (good.length) line += `;實際有回應的領域:${good.join('、')}`;
  if (bad.length) line += `;一直槓龜的領域:${bad.join('、')}(這類 win 要保守)`;
  return line + '。請據此校正 win,別系統性高估或低估。';
}

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
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,"PingFang TC",Segoe UI,sans-serif;display:grid;grid-template-columns:200px 1fr;min-height:100vh}
  body.chat-open #pagecontent{margin-right:420px;transition:margin-right .2s}
  #pagecontent{min-width:0;overflow-x:hidden}
  a{color:var(--ac)}
  header{position:sticky;top:0;background:#0d1117ee;backdrop-filter:blur(8px);border-bottom:1px solid var(--bd);padding:14px max(20px,calc((100% - 920px)/2));z-index:9}
  body.wide header{padding:14px 20px}
  h1{font-size:18px;margin:0;display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
  h1 .sub{color:var(--mut);font-size:13px;font-weight:400}
  /* 📐 左側 sidebar 導覽(grid column 1) */
  aside.sidebar{background:#0a0e14;border-right:1px solid var(--bd);padding:18px 12px;display:flex;flex-direction:column;gap:2px;position:sticky;top:0;height:100vh;overflow-y:auto}
  aside.sidebar .brand{color:var(--tx);font-weight:700;font-size:14px;padding:0 8px 14px;border-bottom:1px solid var(--bd);margin-bottom:10px;display:flex;align-items:center;gap:6px}
  aside.sidebar .brand small{color:var(--mut);font-size:11px;font-weight:400}
  aside.sidebar .group{color:var(--mut);font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:14px 8px 6px;font-weight:600}
  aside.sidebar a{display:block;padding:8px 10px;border-radius:7px;color:var(--mut);text-decoration:none;font-size:13px;transition:.12s;line-height:1.3}
  aside.sidebar a:hover{background:#161b22;color:var(--tx)}
  aside.sidebar a.on{background:var(--ac);color:#fff;font-weight:600}
  aside.sidebar .logout{margin-top:auto;border-top:1px solid var(--bd);padding-top:10px}
  aside.sidebar .logout a{color:#8b949e;font-size:12px}
  aside.sidebar .logout a:hover{color:#f85149;background:transparent}
  @media (max-width: 720px){
    body{display:block}
    aside.sidebar{width:100%;height:auto;position:relative;flex-direction:row;flex-wrap:wrap;padding:8px;gap:4px;border-right:0;border-bottom:1px solid var(--bd)}
    aside.sidebar .brand,aside.sidebar .group{display:none}
    aside.sidebar a{padding:5px 8px;font-size:12px;white-space:nowrap;flex-shrink:0}
    aside.sidebar .logout{margin-top:0;border-top:0;padding-top:0}
  }
  .flowhint{margin-top:10px;font-size:13px;color:var(--mut)}.flowhint b{color:var(--tx)}
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  .filters button{background:var(--card);color:var(--tx);border:1px solid var(--bd);padding:6px 15px;border-radius:20px;cursor:pointer;font-size:13px;transition:.15s}
  .filters button:hover{border-color:var(--ac)}
  .filters button.on{background:var(--ac);border-color:var(--ac);color:#fff;font-weight:600}
  main{max-width:920px;margin:0 auto;padding:22px 20px}
  body.wide main{max-width:1360px;margin:0}
  /* 雙欄:左設定/表單、右參考資訊 */
  .cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:28px;align-items:start}
  .cols .side{position:sticky;top:84px}
  @media (max-width:1080px){.cols{grid-template-columns:1fr}.cols .side{position:static}}
  .card{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:12px;padding:16px;margin-bottom:14px}
  .card.v-APPLY{border-left-color:var(--grn)} .card.v-MAYBE{border-left-color:var(--ylw)} .card.v-SKIP{border-left-color:var(--red);opacity:.7}
  .top{display:flex;align-items:center;gap:10px}
  .score{font-size:24px;font-weight:700;min-width:40px}.score .smax{font-size:13px;color:var(--mut);font-weight:400}
  .aitag{font-size:10px;font-weight:700;background:#2d2150;color:#b392f0;padding:2px 7px;border-radius:5px;border:1px solid #4a3a6a;letter-spacing:.5px}
  .pill{display:inline-block;background:#0d1117;border:1px solid var(--bd);border-radius:14px;padding:3px 11px;font-size:13px;margin:3px 4px 0 0}
  .winbadge{font-size:12px;font-weight:600;background:#0d2818;color:#3fb950;border:1px solid #1f5c38;border-radius:6px;padding:2px 8px}
  .winbadge.win-mid{background:#3a3016;color:#d29922;border-color:#5c4a1f}
  .winbadge.win-lo{background:#3a1d1d;color:#f85149;border-color:#5c2626}
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
  .atags{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 4px}
  .atag{font-size:12px;border-radius:6px;padding:2px 9px;font-weight:500}
  .atag.parent{background:#13233b;color:#79c0ff;border:1px solid #1f3a5f;font-weight:600}
  .atag.need{background:#2d2150;color:#b392f0;border:1px solid #4a3a6a}
  .fit{font-size:12px;border-radius:6px;padding:2px 9px;font-weight:600}
  .fit.hit{background:#0d2818;color:#3fb950;border:1px solid #1f5c38}
  .fit.partial{background:#3a3016;color:#d29922;border:1px solid #5c4a1f}
  .fit.none{background:#21262d;color:#8b949e;border:1px solid var(--bd)}
  details.dim{margin:8px 0 4px}details.dim>summary{cursor:pointer;color:var(--mut);font-size:12px;list-style:none;user-select:none}
  details.dim>summary::before{content:"▸ ";}details.dim[open]>summary::before{content:"▾ ";}
  details.dim>summary:hover{color:var(--ac)}details.dim .grid7{margin-top:8px}
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
  .copied{background:var(--grn)!important;color:#fff!important;border-color:var(--grn)!important}
`;

// 右下角浮動聊天 agent — 注入到每個頁面。client 端自動偵測「目前在哪頁、看哪個案」傳給 /api/chat。
// 注意:此字串內勿用 ${},以免被當模板字面值在 Node 端求值(client JS 一律用字串相加)。
const CHAT_WIDGET = `
<style>
#cwBtn{position:fixed;right:18px;bottom:18px;width:48px;height:48px;border-radius:12px;background:#4493f8;color:#fff;border:0;font-size:22px;cursor:pointer;box-shadow:0 4px 16px #0008;z-index:9999;transition:.15s}
#cwBtn:hover{filter:brightness(1.1);transform:translateY(-2px)}
body.chat-open #cwBtn{display:none}
/* 🆕 IDE 風格右側 panel — 推開主內容,不浮在上面 */
#cwPanel{position:fixed;right:0;top:0;width:420px;height:100vh;background:#161b22;border-left:1px solid #272e3a;display:none;flex-direction:column;z-index:9998;font:14px/1.6 -apple-system,"PingFang TC",Segoe UI,sans-serif;box-shadow:-4px 0 16px #0008}
#cwPanel.open{display:flex}
#cwPanel.big{width:min(720px,50vw)}
body.chat-open #cwPanel.big ~ * #pagecontent,body.chat-open.big-chat #pagecontent{margin-right:720px}
#cwHead{padding:14px 16px;border-bottom:1px solid #272e3a;font-weight:600;color:#e6edf3;display:flex;align-items:center;gap:10px;font-size:15px}
#cwHead .c{color:#8b949e;font-size:12px;font-weight:400}
#cwHead .hbtns{margin-left:auto;display:flex;gap:4px}
#cwHead button{background:0;border:0;color:#8b949e;font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;line-height:1}
#cwHead button:hover{background:#272e3a;color:#e6edf3}
#cwMsgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
#cwMsgs .m{max-width:85%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.65;white-space:pre-wrap;word-wrap:break-word}
#cwMsgs .u{align-self:flex-end;background:#4493f8;color:#fff;border-bottom-right-radius:4px}
#cwMsgs .b{align-self:flex-start;background:#0d1117;border:1px solid #272e3a;color:#e6edf3;border-bottom-left-radius:4px}
#cwMsgs .b strong{color:#79c0ff}
#cwInbar{display:flex;gap:8px;padding:12px;border-top:1px solid #272e3a;background:#13181f;width:100%;box-sizing:border-box}
#cwInbar textarea{flex:1 1 0;width:0;min-width:0;background:#0d1117;color:#e6edf3;border:1px solid #272e3a;border-radius:10px;padding:11px 12px;font:14px/1.5 inherit;resize:none;min-height:44px;max-height:300px;outline:none;transition:border-color .15s;overflow-y:auto}
#cwInbar textarea:focus{border-color:#4493f8}
#cwInbar button{background:#2ea043;color:#fff;border:0;border-radius:10px;padding:0 18px;cursor:pointer;font-size:14px;font-weight:600;transition:filter .15s}
#cwInbar button:hover{filter:brightness(1.1)}
#cwHist{position:absolute;inset:53px 0 0 0;background:#161b22;z-index:2;display:none;flex-direction:column;overflow:hidden}
#cwHist.show{display:flex}
#cwHist .hh{padding:10px 14px;border-bottom:1px solid #272e3a;color:#8b949e;font-size:13px;display:flex;align-items:center;gap:8px}
#cwHist .hh button{margin-left:auto;background:#2ea043;color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:13px}
#cwHist ul{list-style:none;margin:0;padding:6px;overflow-y:auto;flex:1}
#cwHist li{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:8px;cursor:pointer;color:#e6edf3;font-size:14px}
#cwHist li:hover{background:#1f2630}
#cwHist li.cur{background:#13233b;border-left:3px solid #4493f8;padding-left:9px}
#cwHist li .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#cwHist li .ts{color:#8b949e;font-size:11px;flex-shrink:0}
#cwHist li .del{background:0;border:0;color:#8b949e;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px;flex-shrink:0}
#cwHist li .del:hover{background:#3d1e1e;color:#f85149}
#cwHist .empty{color:#8b949e;padding:20px;text-align:center;font-size:13px}
</style>
<button id="cwBtn" title="接案助手">💬</button>
<div id="cwPanel">
  <div id="cwHead">🤖 接案助手 <span class="c" id="cwCtx"></span>
    <span class="hbtns">
      <button id="cwHistBtn" title="歷史對話">☰</button>
      <button id="cwNew" title="新對話">＋</button>
      <button id="cwBig" title="放大/縮小">⛶</button>
      <button id="cwClose" title="關閉">✕</button>
    </span>
  </div>
  <div id="cwMsgs"></div>
  <div id="cwHist"><div class="hh">📚 歷史對話 <button id="cwHistNew">＋ 新對話</button></div><ul id="cwHistList"></ul></div>
  <div id="cwInbar">
    <textarea id="cwTa" placeholder="貼 JD / cover letter / 問策略… (Enter 送、Shift+Enter 換行)"></textarea>
    <button id="cwSend" style="align-self:flex-end">送</button>
  </div>
</div>
<script>
(function(){
  if(window.__cw)return;window.__cw=1;
  var CK='cw_convos',CC='cw_cur',OLD='cw_hist';
  var panel=document.getElementById('cwPanel'),msgs=document.getElementById('cwMsgs'),ta=document.getElementById('cwTa');
  var histPanel=document.getElementById('cwHist'),histList=document.getElementById('cwHistList');
  // 載入對話列表(localStorage 跨 session 保留);舊版 sessionStorage 資料自動遷移成第一筆
  var convos=[];try{convos=JSON.parse(localStorage.getItem(CK)||'[]');}catch(e){}
  if(convos.length===0){try{var old=JSON.parse(sessionStorage.getItem(OLD)||'[]');if(old.length)convos=[{id:String(Date.now()),title:'(舊對話)',ts:Date.now(),msgs:old}];}catch(e){}}
  var curId=localStorage.getItem(CC)||'';
  function curConvo(){return convos.find(function(c){return c.id===curId;});}
  function newConvo(){var c={id:String(Date.now())+Math.random().toString(36).slice(2,5),title:'新對話',ts:Date.now(),msgs:[]};convos.unshift(c);curId=c.id;saveConvos();return c;}
  function saveConvos(){try{localStorage.setItem(CK,JSON.stringify(convos.slice(0,50)));localStorage.setItem(CC,curId);}catch(e){}}
  function titleFrom(m){var t=String(m||'').replace(/\\s+/g,' ').trim();return t.length>22?t.slice(0,22)+'…':(t||'新對話');}
  function fmt(ts){var d=new Date(ts),now=new Date();if(d.toDateString()===now.toDateString())return d.toTimeString().slice(0,5);var diff=(now-d)/86400000;if(diff<7)return Math.floor(diff)+'天前';return (d.getMonth()+1)+'/'+d.getDate();}
  function ctx(){var p=location.pathname,id=(new URLSearchParams(location.search)).get('id')||'';
    var m={'/':'找案子','/job':'評估案件','/proposal':'寫提案','/reply':'回客戶訊息','/invites':'客戶邀請','/invite':'邀請評估','/features':'功能需求地圖','/me':'我的能力','/profile':'我的身分檔','/scoring':'評分設定','/agents':'AI 設定','/assistant':'助手'};
    return {page:(m[p]||p),jobId:id};}
  function setCtx(){var c=ctx();document.getElementById('cwCtx').textContent='在:'+c.page+(c.jobId?' · 看著這案':'');}
  function md(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\`([^\`]+)\`/g,'$1').replace(/^#+\\s*/gm,'').replace(/\\n/g,'<br>');}
  function setText(el,role,text){
    if(role==='user'){
      var s=String(text||'');
      // 🆕 user 長訊息自動摺疊(>300字)
      if(s.length>300){
        var preview=s.slice(0,180).replace(/\\n/g,' ').trim()+'…';
        el.innerHTML='';
        var p=document.createElement('div');p.textContent=preview;p.style.cssText='opacity:.9';el.appendChild(p);
        var b=document.createElement('button');b.textContent='展開全文 ('+s.length+' 字) ▾';b.style.cssText='background:rgba(255,255,255,.18);border:0;color:#fff;font-size:11px;border-radius:6px;padding:4px 9px;margin-top:6px;cursor:pointer';
        var open=false;
        b.onclick=function(){open=!open;p.textContent=open?s:preview;b.textContent=(open?'收合 ▴':'展開全文 ('+s.length+' 字) ▾');};
        el.appendChild(b);
      } else el.textContent=s;
    } else el.innerHTML=md(text);
  }
  function bubble(role,text){var d=document.createElement('div');d.className='m '+(role==='user'?'u':'b');setText(d,role,text);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return d;}
  function render(){msgs.innerHTML='';var c=curConvo();var h=c?c.msgs:[];
    if(h.length===0)bubble('bot','嗨!我是你的接案助手 👋 我知道你現在在哪一頁、看哪個案 — 直接問我這案值不值得投、怎麼報價、幫想切入角度都行。');
    else h.forEach(function(m){bubble(m.role,m.content);});}
  function renderHist(){histList.innerHTML='';if(convos.length===0){histList.innerHTML='<li class="empty">還沒有對話</li>';return;}
    convos.forEach(function(c){var li=document.createElement('li');if(c.id===curId)li.className='cur';
      li.innerHTML='<span class="t"></span><span class="ts"></span><button class="del" title="刪除">🗑</button>';
      li.querySelector('.t').textContent=c.title;li.querySelector('.ts').textContent=fmt(c.ts);
      li.onclick=function(e){if(e.target.classList.contains('del'))return;curId=c.id;saveConvos();render();renderHist();toggleHist(false);};
      li.querySelector('.del').onclick=function(e){e.stopPropagation();if(!confirm('刪除這個對話?'))return;convos=convos.filter(function(x){return x.id!==c.id;});if(curId===c.id)curId=convos[0]?convos[0].id:'';saveConvos();render();renderHist();};
      histList.appendChild(li);});}
  function toggleHist(show){if(show==null)show=!histPanel.classList.contains('show');histPanel.classList.toggle('show',show);if(show)renderHist();}
  function setOpen(open){panel.classList.toggle('open',open);document.body.classList.toggle('chat-open',open);if(open){setCtx();ta.focus();}}
  document.getElementById('cwBtn').onclick=function(){setOpen(!panel.classList.contains('open'));};
  document.getElementById('cwClose').onclick=function(){setOpen(false);};
  document.getElementById('cwBig').onclick=function(){panel.classList.toggle('big');try{localStorage.setItem('cw_big',panel.classList.contains('big')?'1':'0');}catch(e){}};
  try{if(localStorage.getItem('cw_big')==='1')panel.classList.add('big');}catch(e){}
  document.getElementById('cwHistBtn').onclick=function(){toggleHist();};
  function startNew(){newConvo();render();renderHist();toggleHist(false);ta.focus();}
  document.getElementById('cwNew').onclick=startNew;
  document.getElementById('cwHistNew').onclick=startNew;
  document.getElementById('cwSend').onclick=send;
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
  // 🆕 textarea 自動撐高(貼大塊文字也好看)
  ta.addEventListener('input',function(){ta.style.height='44px';ta.style.height=Math.min(ta.scrollHeight,300)+'px';});
  ta.addEventListener('paste',function(){setTimeout(function(){ta.style.height='44px';ta.style.height=Math.min(ta.scrollHeight,300)+'px';},10);});
  function send(){var t=ta.value.trim();if(!t)return;
    var c=curConvo();if(!c){c=newConvo();}
    ta.value='';ta.style.height='44px';bubble('user',t);c.msgs.push({role:'user',content:t});
    if(c.title==='新對話'||!c.title)c.title=titleFrom(t);
    c.ts=Date.now();saveConvos();
    var b=bubble('bot','…');
    fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:c.msgs,context:ctx()})})
      .then(function(r){return r.json();}).then(function(j){if(j.ok){setText(b,'bot',j.reply);c.msgs.push({role:'assistant',content:j.reply});c.ts=Date.now();saveConvos();}else{b.textContent='❌ '+(j.error||'失敗');}})
      .catch(function(e){b.textContent='❌ '+e.message;});}
  // 沒任何對話 → 開一個空的
  if(!curConvo()){if(convos.length)curId=convos[0].id;else newConvo();saveConvos();}
  render();setCtx();
})();
</script>`;

// 送出 HTML 頁面並注入浮動聊天 agent(統一入口)
// 全站共用:複製 Upwork 連結到剪貼簿(跨站點擊拿不到登入,改成複製、使用者自己貼)
const COPY_JS = `<script>
// HTTP(非 HTTPS)下 navigator.clipboard 不可用,故先試它、再用 execCommand 直接複製,最後才 prompt。
window.copyUpwork=function(e,el){if(e)e.preventDefault();
  var u=el.getAttribute('data-url')||el.href||'';
  var done=function(){var o=el.getAttribute('data-label')||el.textContent;el.setAttribute('data-label',o);
    el.textContent='✅ 已複製,貼到網址列開啟';el.classList.add('copied');
    setTimeout(function(){el.textContent=o;el.classList.remove('copied');},1600);};
  var legacy=function(){try{var t=document.createElement('textarea');t.value=u;t.style.position='fixed';t.style.opacity='0';
    document.body.appendChild(t);t.focus();t.select();var ok=document.execCommand('copy');document.body.removeChild(t);
    if(ok){done();return;}}catch(_){}
    window.prompt('複製這個連結貼到網址列:',u);};
  if(navigator.clipboard&&navigator.clipboard.writeText&&window.isSecureContext){navigator.clipboard.writeText(u).then(done,legacy);}
  else{legacy();}
  return false;};
</script>`;

function serveHtml(res, htmlStr) {
  let out = String(htmlStr);
  // 🛡️ Grid 佈局:把 sidebar 從 page 內抽出,放到 body 第一個位置(column 1)
  // page 其餘內容包進 #pagecontent(column 2)
  const m = out.match(/<aside class="sidebar">[\s\S]*?<\/aside>/);
  const sidebar = m ? m[0] : '';
  if (sidebar) out = out.replace(sidebar, '');
  // 偵測頁面是否雙欄(main.wide):雙欄頁靠左對齊、其餘(列表/單欄)頁置中
  const isWide = /<main[^>]*class="[^"]*\bwide\b/.test(out);
  out = out.replace('<body>', `<body${isWide ? ' class="wide"' : ''}>${sidebar}<div id="pagecontent">`);
  out = out.replace('</body>', '</div>' + COPY_JS + CHAT_WIDGET + '</body>');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
  res.end(out);
}

function trackCls(v) { return v < 34 ? 'track low' : v < 67 ? 'track mid' : 'track'; }
// 中標率配色:<40 低(紅,丟了也沒意義)、40-59 中(黃)、≥60 高(綠)
function winCls(w) { return w < 40 ? 'win-lo' : w < 60 ? 'win-mid' : ''; }

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
  // 💀 規則 SKIP(死亡訊號 / 雇用率 0% / 紅線 / blocked) → 蓋過 AI 樂觀判斷
  const ruleSkip = j.verdict === 'SKIP';
  const isDeathSignal = ruleSkip && /💀|死亡訊號|雇用率0%|未付款|紅線/.test(j.reason || '');
  if (j.ai_score != null && j.ai_verdict && !isDeathSignal) {
    return { score: j.ai_score, scoreMax: 10, verdict: aiVerdictShort(j.ai_verdict), note: j.ai_verdict, cls: aiVerdictClass(j.ai_verdict), isAi: true };
  }
  return { score: j.total_score, scoreMax: 100, verdict: j.verdict, note: '', cls: j.verdict, isAi: false };
}

// 登入頁(免登入)— 表單 POST /api/login,成功設 cookie 後進 dashboard
function pageLogin() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登入 — Upwork 接案助手</title><style>${CSS}
  .box{max-width:360px;margin:12vh auto;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:28px}
  .box h1{font-size:20px;margin:0 0 4px;display:block}.box p{color:var(--mut);font-size:13px;margin:0 0 18px}
  .box label{display:block;color:var(--mut);font-size:13px;margin:12px 0 4px}
  .box input{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:11px;font-size:14px}
  .box button{width:100%;margin-top:18px;background:var(--ac);color:#fff;border:0;padding:12px;border-radius:9px;font-size:15px;font-weight:600;cursor:pointer}
  .box .err{color:#f85149;font-size:13px;margin-top:10px;min-height:18px}</style></head><body>
<div class="box">
  <h1>🎯 Upwork 接案助手</h1>
  <p>請登入(共用帳號 · auth.twloop.com)</p>
  <form onsubmit="return go(event)">
    <label>帳號(Email 或名稱)</label>
    <input id="id" autocomplete="username" autofocus>
    <label>密碼</label>
    <input id="pw" type="password" autocomplete="current-password">
    <button type="submit" id="btn">登入</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  async function go(e){e.preventDefault();const btn=document.getElementById('btn'),err=document.getElementById('err');
    err.textContent='';btn.disabled=true;btn.textContent='登入中…';
    try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({identifier:document.getElementById('id').value.trim(),password:document.getElementById('pw').value})});
      const j=await r.json();
      if(j.ok)location.href='/'; else{err.textContent='❌ '+(j.error||'帳號或密碼錯誤');btn.disabled=false;btn.textContent='登入';}}
    catch(ex){err.textContent='❌ '+ex.message;btn.disabled=false;btn.textContent='登入';}
    return false;}
</script></body></html>`;
}

function pageJobs() {
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  // 排序:已投沉到底 → 再依「實際顯示的分數」(AI 分數優先,×10 對齊 0-100,否則規則分)→ 再依最新
  const data = db.prepare(`SELECT * FROM jobs
    ORDER BY applied ASC, COALESCE(ai_score * 10, total_score) DESC, last_seen DESC`).all();
  const counts = data.reduce((a, j) => { const c = effectiveVerdict(j).cls; a[c] = (a[c] || 0) + 1; return a; }, {});
  // 動線提示:今日新案 + 未處理(值得投但還沒投)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayNew = data.filter((j) => (j.first_seen || '').slice(0, 10) === todayStr).length;
  const todo = data.filter((j) => effectiveVerdict(j).cls === 'APPLY' && !j.applied).length;
  const untriaged = data.filter((j) => j.ai_score == null && !j.blocked).length; // 被第二道門擋下的不算待快篩
  const blockedCount = data.filter((j) => j.blocked).length;
  // 收集母類別 + 子功能(給篩選下拉)
  const allParents = [...new Set(data.map((j) => (j.category || '').trim()).filter(Boolean))].sort();
  const allTags = [...new Set(data.flatMap((j) => (j.tags || '').split(',').map((x) => x.trim()).filter(Boolean)))].sort();
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
      // 適配:案子文字命中幾個「有 GitHub 證據」的技術
      const jtext = `${j.title || ''} ${j.description || ''}`.toLowerCase();
      const provenHits = (cfg.provenTechs || []).filter((t) => t && jtext.includes(String(t).toLowerCase())).length;
      const fit = provenHits >= 2 ? { t: '🟢 強項命中', c: 'hit' } : provenHits === 1 ? { t: '🟡 部分符合', c: 'partial' } : { t: '⚪ 需補技能', c: 'none' };
      // 分類標籤(來自功能地圖):母類別 + 子功能
      const parent = (j.category || '').trim();
      const jtags = (j.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
      const parentHtml = parent ? `<span class="atag parent">📂 ${esc(parent)}</span>` : '';
      const childHtml = jtags.map((t) => `<span class="atag need">${esc(t)}</span>`).join('');
      // 排序用衍生數值:
      // pay = 取 fixed_budget 或 hourly_max(誰高用誰);沒值 → -1 沉底
      const pay = Math.max(j.fixed_budget || 0, j.hourly_max || 0) || -1;
      // comp = 把 proposals_bucket 字串轉成「估計提案數中位數」(數字越小越好,沒值給 999 沉底)
      const propStr = String(j.proposals_bucket || '').toLowerCase();
      let compNum = 999;
      if (/fewer than 5|less than 5|0\s*to\s*5|<\s*5/.test(propStr)) compNum = 2;
      else if (/5\s*to\s*10/.test(propStr)) compNum = 7;
      else if (/10\s*to\s*15/.test(propStr)) compNum = 12;
      else if (/15\s*to\s*20/.test(propStr)) compNum = 17;
      else if (/20\s*to\s*50/.test(propStr)) compNum = 35;
      else if (/50\+|over\s*50/.test(propStr)) compNum = 80;
      else { const m = propStr.match(/(\d+)/); if (m) compNum = Number(m[1]); }
      const spent = Number(j.client_spent_usd) || -1;
      const skillScore = Number(j.score_skill) ?? -1;
      const postedAt = j.posted_at || j.last_seen || '';
      const sid = jid(j.id); // XSS 安全化:id 用於 onclick / URL
      const aiWin = Number.isFinite(Number(j.ai_win)) ? Number(j.ai_win) : null; // 防非數值注入
      const sortScore = Number(ev.isAi ? ev.score * 10 : ev.score) || 0;
      return `
      <article class="card v-${ev.cls}" data-verdict="${ev.cls}" data-applied="${j.applied ? 1 : 0}" data-favorited="${j.favorited ? 1 : 0}" data-blocked="${j.blocked ? 1 : 0}" data-fit="${fit.c}" data-parent="${esc(parent)}" data-tags="${esc(jtags.join(','))}" data-win="${aiWin ?? -1}" data-sortscore="${sortScore}" data-seen="${esc(j.last_seen || '')}" data-pay="${Number(pay) || -1}" data-comp="${Number(compNum) || 999}" data-spent="${spent}" data-skill="${Number(skillScore) || -1}" data-posted="${esc(postedAt)}" data-pv="${j.payment_verified ? 1 : 0}">
        <div class="top">
          ${scoreHtml}
          <span class="badge ${ev.cls}">${esc(ev.verdict)}</span>
          ${j.blocked ? '<span class="badge SKIP" title="被第二道門擋下,不進 AI 分析">🚫 超綱</span>' : ''}
          ${aiWin != null ? `<span class="winbadge ${winCls(aiWin)}" title="估計中標機率(太低丟了也沒意義)">🎯 ${aiWin}%</span>` : ''}
          ${firstWinChips(j, cfg)}
          <button class="favbtn ${j.favorited ? 'on' : ''}" onclick="favJob('${sid}',this)" title="收藏" style="background:none;border:0;cursor:pointer;font-size:18px;padding:0 4px">${j.favorited ? '❤️' : '🤍'}</button>
          <label class="applied"><input type="checkbox" ${j.applied ? 'checked' : ''} onchange="mark('${sid}',this.checked)"> 已投</label>
        </div>
        <h2><a href="/job?id=${sid}">${esc(j.title)}</a></h2>
        <p class="reason">${esc(j.reason)}</p>
        <div class="atags"><span class="fit ${fit.c}">${fit.t}</span>${parentHtml}${childHtml}</div>
        <div class="tags">${tags.map((t) => `<span>${t}</span>`).join('')}</div>
        <details class="dim"><summary>展開 7 維評分</summary><div class="grid7">${metrics}</div></details>
        <div class="acts">
          <a class="open primary" href="/job?id=${sid}">② 評估案件 →</a>
          <a class="open" href="/proposal?id=${sid}">③ 寫提案 →</a>
          <a class="open" href="${esc(cleanUrl(j))}" data-url="${esc(cleanUrl(j))}" onclick="return copyUpwork(event,this)" title="複製 Upwork 連結,自己貼到網址列開啟(登入版)">📋 複製 Upwork 連結</a>
        </div>
      </article>`;
    })
    .join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Upwork 案子篩選</title><style>${CSS}</style></head><body>
<header>
  <h1>📋 探索案件 <span class="sub">APPLY ${counts.APPLY || 0} · MAYBE ${counts.MAYBE || 0} · SKIP ${counts.SKIP || 0} · 共 ${data.length} · 門檻 ${cfg.scoring.threshold}</span></h1>
  ${navBar('/')}
  <div class="flowhint">🆕 今日新案 <b>${todayNew}</b> · ⏳ 待處理(值得投未投) <b>${todo}</b> · 🤖 未 AI 快篩 <b>${untriaged}</b> · 🚫 第二道門擋下 <b>${blockedCount}</b>
    <button class="open" id="triageBtn" style="margin-left:10px" onclick="triage(false)">🤖 AI 快篩${untriaged ? ` (${untriaged})` : ''}</button>
    <span id="trmsg" style="color:var(--mut)"></span>
  </div>
  <div class="filters">
    <button data-f="APPLY" class="on">🟢 值得投</button><button data-f="MAYBE">🟡 可考慮</button>
    <button data-f="SKIP">🔴 排除</button><button data-f="blocked">🚫 超綱</button><button data-f="junk" title="低提案+小預算+付款驗證,新手撿漏拿 5★">🦴 撿漏</button><button data-f="favorited" title="❤️ 標記過的案子">❤️ 收藏</button><button data-f="applied">已投</button><button data-f="all">全部</button>
    <select id="parentFilter" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:20px;padding:6px 12px;font-size:13px">
      <option value="">📂 全部大類</option>
      ${allParents.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
    </select>
    <select id="tagFilter" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:20px;padding:6px 12px;font-size:13px">
      <option value="">🔧 全部功能</option>
      ${allTags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
    </select>
    <select id="fitFilter" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:20px;padding:6px 12px;font-size:13px">
      <option value="">🎯 全部適配</option><option value="hit">🟢 強項命中</option><option value="partial">🟡 部分符合</option><option value="none">⚪ 需補技能</option>
    </select>
    <select id="sortBy" style="background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:20px;padding:6px 12px;font-size:13px" title="排序方式">
      <option value="combo">↕ 綜合分數</option>
      <option value="win">🎯 勝率(中標率)</option>
      <option value="cp">💎 CP 值(分數÷競爭)</option>
      <option value="pay">💰 報酬高低</option>
      <option value="comp">🥶 競爭最少</option>
      <option value="spent">🏦 客戶花費</option>
      <option value="skill">📈 能力契合度</option>
      <option value="posted">⏰ 發布最近</option>
      <option value="recent">🆕 最新看到</option>
    </select>
  </div>
</header>
<main>${cards || '<p style="color:var(--mut)">資料庫是空的。擴充套件抓到案子後會出現在這。</p>'}</main>
<script>
  const cards=[...document.querySelectorAll('.card')];
  let verdictF='APPLY';
  function applyFilters(){const par=document.getElementById('parentFilter').value,tag=document.getElementById('tagFilter').value,fit=document.getElementById('fitFilter').value;
    cards.forEach(c=>{
      let okV;
      if(verdictF==='all')okV=1;
      else if(verdictF==='applied')okV=c.dataset.applied==='1';
      else if(verdictF==='blocked')okV=c.dataset.blocked==='1';
      else if(verdictF==='favorited')okV=c.dataset.favorited==='1';
      else if(verdictF==='junk'){
        // 🦴 撿漏:低競爭(≤10 提案) + 付款驗證 + 未投 + (預算 20-200 或未知)
        const comp=+c.dataset.comp,pay=+c.dataset.pay,pv=c.dataset.pv==='1',ap=c.dataset.applied==='1';
        okV=pv&&!ap&&comp<=10&&(pay<0||(pay>=20&&pay<=200));
      }
      else okV=c.dataset.verdict===verdictF;
      let okP=!par||c.dataset.parent===par;
      let okT=!tag||(','+c.dataset.tags+',').indexOf(','+tag+',')>=0;
      let okF=!fit||c.dataset.fit===fit;
      c.style.display=(okV&&okP&&okT&&okF)?'':'none';});}
  function f(x){verdictF=x;document.querySelectorAll('.filters button').forEach(b=>b.classList.toggle('on',b.dataset.f===x));
    // 撿漏模式自動切「競爭最少」排序
    if(x==='junk'){const sel=document.getElementById('sortBy');sel.value='comp';sortCards();}
    applyFilters();}
  document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>f(b.dataset.f));
  document.getElementById('parentFilter').onchange=applyFilters;
  document.getElementById('tagFilter').onchange=applyFilters;
  document.getElementById('fitFilter').onchange=applyFilters;
  // 排序:多種策略。已投一律沉到最底。沒值的(-1 / 999)也自動沉底。
  function sortCards(){const key=document.getElementById('sortBy').value,main=document.querySelector('main');
    cards.slice().sort((a,b)=>{
      const ap=(a.dataset.applied==='1')-(b.dataset.applied==='1');if(ap)return ap;
      if(key==='win')return (+b.dataset.win)-(+a.dataset.win);
      if(key==='recent')return (b.dataset.seen||'').localeCompare(a.dataset.seen||'');
      if(key==='posted')return (b.dataset.posted||'').localeCompare(a.dataset.posted||'');
      if(key==='pay'){const pa=+a.dataset.pay,pb=+b.dataset.pay;if(pa<0&&pb>=0)return 1;if(pb<0&&pa>=0)return -1;return pb-pa;}
      if(key==='spent'){const sa=+a.dataset.spent,sb=+b.dataset.spent;if(sa<0&&sb>=0)return 1;if(sb<0&&sa>=0)return -1;return sb-sa;}
      if(key==='skill'){const sa=+a.dataset.skill,sb=+b.dataset.skill;if(sa<0&&sb>=0)return 1;if(sb<0&&sa>=0)return -1;return sb-sa;}
      if(key==='comp')return (+a.dataset.comp)-(+b.dataset.comp); // 升序(競爭越少越前)
      if(key==='cp'){
        // CP 值 = 綜合分數 ÷ max(競爭, 1) — 競爭少 + 分數高的浮上來
        const ca=(+a.dataset.sortscore)/Math.max(+a.dataset.comp,1);
        const cb=(+b.dataset.sortscore)/Math.max(+b.dataset.comp,1);
        return cb-ca;
      }
      return (+b.dataset.sortscore)-(+a.dataset.sortscore);
    }).forEach(c=>main.appendChild(c));}
  document.getElementById('sortBy').onchange=sortCards;
  // 預設 APPLY,但 URL ?fav=1 來的切到收藏
  f(new URLSearchParams(location.search).get('fav')==='1'?'favorited':'APPLY');
  async function favJob(id,btn){
    var card=btn.closest('.card');var on=card.dataset.favorited==='1';var newVal=on?0:1;
    await fetch('/api/job/favorite?id='+id+'&fav='+newVal,{method:'POST'});
    card.dataset.favorited=String(newVal);btn.textContent=newVal?'❤️':'🤍';btn.classList.toggle('on',!!newVal);
  }
  async function mark(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});
    const card=document.querySelector('input[onchange*="'+id+'"]').closest('.card');
    card.dataset.applied=a?'1':'0';
    if(a)card.parentNode.appendChild(card);} // 已投 → 沉到列表最底
  async function triage(all){const b=document.getElementById('triageBtn'),m=document.getElementById('trmsg');
    b.disabled=true;let s=0;m.textContent=' 快篩中…(便宜 AI 批次,勿關閉) 0s';
    const t=setInterval(()=>{m.textContent=' 快篩中…(便宜 AI 批次,勿關閉) '+(++s)+'s';},1000);
    try{const r=await fetch('/api/triage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({all:!!all})});
      const j=await r.json();clearInterval(t);
      if(j.ok){m.textContent=' ✅ 已快篩 '+j.triaged+' 案,重整中…';setTimeout(()=>location.reload(),800);}
      else m.textContent=' ❌ '+(j.error||'失敗');}
    catch(e){clearInterval(t);m.textContent=' ❌ '+e.message;}b.disabled=false;}
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
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的身分檔</title><style>${CSS}
  .form label{display:block;color:var(--mut);font-size:13px;margin:14px 0 4px}
  .form input,.form textarea{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font:14px/1.6 inherit}
  .form textarea{min-height:80px}.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .port{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin:10px 0}
  .port input{margin-bottom:6px}.port .x{float:right;background:none;border:0;color:#f85149;cursor:pointer;font-size:16px}
  .caps li{margin:8px 0}h2{border-left:3px solid var(--grn);padding-left:10px}</style></head><body>
<header><h1>🪪 我的身分檔 <span class="sub">「我在 Upwork 是誰」— 姓名/作品集/求職信規則,AI 寫所有文案都讀這份。技能等級數值請去 <a href="/me">🎯 我的能力</a> 設定。</span></h1>${navBar('/profile')}</header>
<main class="form wide">
  <div class="cols">
    <div class="colmain">
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
    </div>

    <div class="side">
      <h2>🤖 Profile Agent(已證明能力)</h2>
      <p class="reason">自動抓 GitHub(<b>${esc(p.githubUser || 'Harry1667')}</b>)歸納「已證明能力」,讓有真實 repo 證據的案子適配度加成、求職信引用真實作品。${p.provenUpdatedAt ? `上次更新:${esc(p.provenUpdatedAt.slice(0, 16).replace('T', ' '))},共 ${(p.provenCapabilities || []).length} 項。每週一自動刷新。` : '尚未執行。'}</p>
      <p><button class="save" onclick="runAgent()">🤖 立即執行(約 1-2 分)</button> <span id="amsg" class="reason"></span></p>
      <ul class="caps">${capList}</ul>
    </div>
  </div>
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

// 🎯 我的能力:分級技能清單 + 紅線(不碰)+ 規模上限。評分「能力匹配度」與案件推薦都讀這份。
const LEVEL_LABELS = { 5: '5 精通', 4: '4 熟練', 3: '3 能做', 2: '2 勉強', 1: '1 碰過' };
function pageMe() {
  const p = loadProfile();
  // 線上 profile.json 若還沒有能力資料(剛上線),帶入 profile.example.json 的預設讓你按一次儲存即啟用
  let cap = p.capability;
  if (!cap || !(cap.skills || []).length) {
    try { cap = JSON.parse(readFileSync(path.join(__dirname, '..', 'profile.example.json'), 'utf8')).capability; } catch { /* ignore */ }
    cap = cap || { skills: [], redlines: [], scaleCeiling: '', searchKeywords: [] };
  }
  const v = (x) => esc(x == null ? '' : x);
  const lvOptions = (sel) => [5, 4, 3, 2, 1]
    .map((n) => `<option value="${n}"${Number(sel) === n ? ' selected' : ''}>${LEVEL_LABELS[n]}</option>`).join('');
  const skillRow = (s) => `<div class="cap">
    <button class="x" onclick="this.parentNode.remove()">✕</button>
    <div class="caph"><input class="c_name" placeholder="可交付項目(例:全棧 Web App)" value="${v(s.name)}"><select class="c_lv">${lvOptions(s.level)}</select></div>
    <input class="c_can" placeholder="✅ 能做:具體做得到什麼(例:前後台+DB+金流+部署一手包)" value="${v(s.canDo)}">
    <input class="c_cant" placeholder="🚫 不做:邊界在哪(例:需團隊的大型企業系統、原生 AR)" value="${v(s.cantDo)}">
    <input class="c_kw" placeholder="比對關鍵字(逗號分隔,小寫,供案件比對)" value="${v((s.keywords || []).join(', '))}">
  </div>`;
  const skillRows = (cap.skills || []).map(skillRow).join('');
  const redlines = (cap.redlines || []).join(', ');
  const searchKeywords = (cap.searchKeywords || []).join('\n');
  const searchFilters = (loadConfig().searchFilters) || {};

  // 🎯 最貼合你能力的案件:能力分高、未投、且非超綱
  const recos = db.prepare(`SELECT id,title,total_score,ai_score,score_skill,reason FROM jobs
    WHERE applied=0 ORDER BY score_skill DESC, COALESCE(ai_score*10,total_score) DESC LIMIT 40`).all()
    .filter((j) => !String(j.reason || '').includes('超綱') && (j.score_skill ?? 0) >= 55)
    .slice(0, 8);
  const recoHtml = recos.length
    ? recos.map((j) => `<a class="reco" href="/job?id=${j.id}">
        <span class="rs">${j.score_skill ?? 0}</span>
        <span class="rt">${esc(j.title)}</span>
        <small class="rr">${esc(String(j.reason || '').slice(0, 60))}</small>
      </a>`).join('')
    : '<p class="reason">目前沒有貼合能力的未投案件。先去 ① 找案子 抓案、或調整下方能力清單。</p>';

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>我的能力</title><style>${CSS}
  .form label{display:block;color:var(--mut);font-size:13px;margin:14px 0 4px}
  .form input,.form textarea{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font:14px/1.6 inherit}
  .form textarea{min-height:70px}
  .cap{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin:10px 0;position:relative}
  .cap .caph{display:grid;grid-template-columns:1fr 110px;gap:8px;margin-bottom:6px}
  .cap input,.cap select{display:block;width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:8px;font:14px inherit;margin-bottom:6px}
  .cap .caph input,.cap .caph select{margin-bottom:0}
  .cap .c_name{font-weight:600}
  .cap .x{position:absolute;top:-8px;right:-8px;background:#21262d;border:1px solid var(--bd);color:#f85149;cursor:pointer;font-size:13px;border-radius:50%;width:22px;height:22px;line-height:1}
  h2{border-left:3px solid var(--ac);padding:16px 0 0 12px;font-size:17px;margin:38px 0 10px;border-top:1px solid var(--bd)}
  h2:first-of-type{border-top:0;margin-top:8px;padding-top:0}
  .legend{font-size:12.5px;color:var(--mut);margin:0 0 12px;line-height:1.6;background:#0d1117;border-left:2px solid var(--bd);border-radius:0 6px 6px 0;padding:8px 12px}
  .reco{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin:6px 0;text-decoration:none;color:var(--tx)}
  .reco:hover{border-color:var(--ac)}
  .reco .rs{font-weight:700;font-size:18px;color:var(--grn);min-width:34px;text-align:center}
  .reco .rt{font-weight:600;flex:1}.reco .rr{color:var(--mut);font-size:12px;display:block}
  .save{background:var(--grn);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:14px;cursor:pointer;font-weight:600}
  .gates{display:flex;align-items:stretch;gap:8px;margin:4px 0 18px}
  .gate{flex:1;background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px}
  .gate.ok{border-color:var(--grn)}.gate b{display:block;font-size:14px}.gate small{color:var(--mut);font-size:12px}
  .garr{display:flex;align-items:center;color:var(--mut);font-size:20px}</style></head><body>
<header><h1>🎯 我的能力 <span class="sub">三道門漏斗:① 關鍵字抓源 → ② 能力篩選 → ③ 7維+AI 評分,層層過濾出最適合你的案</span></h1>${navBar('/me')}</header>
<main class="form wide">
  <div class="gates">
    <div class="gate"><b>🚪 一 · 來源</b><small>關鍵字 → Upwork 搜尋網址 → 貼進擴充功能,只抓進你領域的案</small></div>
    <div class="garr">→</div>
    <div class="gate"><b>🎯 二 · 能力</b><small>分級技能 + 紅線,超綱降級標 ⚠️</small></div>
    <div class="garr">→</div>
    <div class="gate"><b>📊 三 · 評分+AI</b><small>7 維加權 → AI 快篩 → AI 大分析,最後判 APPLY/MAYBE/SKIP</small></div>
    <div class="garr">→</div>
    <div class="gate ok"><b>✅ 到你手上</b><small>完全適合你的案</small></div>
  </div>

  <div class="cols">
    <div class="colmain">
      <h2>🚪 第一道門:案子來源關鍵字</h2>
      <p class="legend">一行一個關鍵字(英文,Upwork 搜尋用),系統以 OR 串接。建議只放<b>主力(精通/熟練)</b>領域,別太雜。</p>
      <textarea id="f_kw" style="min-height:150px" oninput="genUrl()">${esc(searchKeywords)}</textarea>
      <p style="margin:8px 0"><button class="save" style="background:#30363d" onclick="suggestKw()">⚙️ 從分級技能自動建議(level ≥ 4)</button></p>
      <label>產生的搜尋字串(q)</label>
      <textarea id="o_q" readonly style="min-height:50px;color:var(--mut)"></textarea>
      <label>Upwork 搜尋網址 — 複製貼到擴充功能的 <b>Search URL</b> 欄</label>
      <input id="o_url" readonly style="color:var(--ac)">
      <p style="margin:8px 0">
        <button class="save" onclick="copyUrl()">📋 複製搜尋網址</button>
        <a class="save" id="openUrl" target="_blank" rel="noopener" style="background:#30363d;text-decoration:none;display:inline-block">↗ 在 Upwork 開啟預覽</a>
        <span id="kwmsg" class="reason"></span>
      </p>

      <h2>🎯 第二道門:可交付能力 + 邊界</h2>
      <p class="legend">每項是「<b>你能交付的具體成果</b>」,不是工具名。填<b>能做/不做</b>把邊界講清楚(框架不等於會做任何事)。<br>level=你在這項的深度:<b>5 精通</b>(通話能辯護每個決策)· <b>4 熟練</b>(獨立交付)· <b>3 能做</b>(需查文件/多點時間)· <b>2 勉強</b>· <b>1 碰過</b>。關鍵字供案件比對(小寫)。</p>
      <div id="caps">${skillRows}</div>
      <button class="save" style="background:#30363d" onclick="addCap()">＋ 新增技能</button>

      <h2>🚫 紅線 / 不碰(逗號分隔)</h2>
      <p class="legend">案子文字命中任一,該案會被標「⚠️超綱」並從 APPLY 降為 MAYBE。例:wordpress、php、solidity、unity。</p>
      <textarea id="f_red">${esc(redlines)}</textarea>

      <h2>📏 能接的專案規模上限</h2>
      <textarea id="f_scale">${v(cap.scaleCeiling)}</textarea>

      <p style="margin-top:18px"><button class="save" onclick="save()">💾 儲存並重算所有案子</button> <span id="msg" class="reason"></span></p>
    </div>

    <div class="side">
      <h2>🎯 最貼合你能力的案件</h2>
      <p class="legend">依「能力匹配度」分數排序的未投案件(已排除超綱)。點進去評估。</p>
      ${recoHtml}
    </div>
  </div>
</main>
<script>
  const BASE=${JSON.stringify(p)};
  const LVOPT=${JSON.stringify(lvOptions(4))};
  const FILTERS=${JSON.stringify(searchFilters)};
  // 第一道門:關鍵字 → q(OR 串接)→ Upwork 搜尋網址(格式對齊本專案 scraper)
  function kwList(){return document.getElementById('f_kw').value.split(/[\\n,]/).map(s=>s.trim()).filter(Boolean);}
  function buildUrl(q){var p=new URLSearchParams();p.set('q',q);
    if(FILTERS.paymentVerifiedOnly)p.set('payment_verified','1');
    if(FILTERS.jobType)p.set('t',FILTERS.jobType);
    if(FILTERS.sort)p.set('sort',FILTERS.sort);
    return 'https://www.upwork.com/nx/search/jobs/?'+p.toString();}
  function genUrl(){var q=kwList().join(' OR ');
    document.getElementById('o_q').value=q;
    var url=q?buildUrl(q):'';
    document.getElementById('o_url').value=url;
    document.getElementById('openUrl').href=url||'#';}
  function copyUrl(){var u=document.getElementById('o_url').value;
    if(!u){document.getElementById('kwmsg').textContent='先填關鍵字';return;}
    navigator.clipboard.writeText(u);document.getElementById('kwmsg').textContent='\\u2705 已複製,貼到擴充功能 Search URL';}
  // 從分級技能(level>=4)自動建議來源關鍵字:名稱是英文就用名稱,否則用第一個關鍵字
  function suggestKw(){var out=[];
    document.querySelectorAll('.cap').forEach(function(c){
      var lv=Number(c.querySelector('.c_lv').value);if(lv<4)return;
      var name=c.querySelector('.c_name').value.trim();
      var kws=c.querySelector('.c_kw').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
      var term=/^[\\x00-\\x7F]+$/.test(name)?name:(kws[0]||'');
      if(term)out.push(term);});
    document.getElementById('f_kw').value=[...new Set(out)].join('\\n');genUrl();}
  function capTpl(){return '<div class="cap"><button class="x" onclick="this.parentNode.remove()">\\u2715</button>'+
    '<div class="caph"><input class="c_name" placeholder="可交付項目(例:全棧 Web App)"><select class="c_lv">'+LVOPT+'</select></div>'+
    '<input class="c_can" placeholder="\\u2705 能做:具體做得到什麼">'+
    '<input class="c_cant" placeholder="\\u{1F6AB} 不做:邊界在哪">'+
    '<input class="c_kw" placeholder="比對關鍵字(逗號分隔,小寫)"></div>';}
  function addCap(){document.getElementById('caps').insertAdjacentHTML('beforeend',capTpl());}
  function save(){
    const skills=[...document.querySelectorAll('.cap')].map(c=>({
      name:c.querySelector('.c_name').value.trim(),
      level:Number(c.querySelector('.c_lv').value)||3,
      canDo:c.querySelector('.c_can').value.trim(),
      cantDo:c.querySelector('.c_cant').value.trim(),
      keywords:c.querySelector('.c_kw').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)
    })).filter(x=>x.name);
    const redlines=document.getElementById('f_red').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    const searchKeywords=kwList();
    const capability=Object.assign({},BASE.capability||{},{skills:skills,redlines:redlines,scaleCeiling:document.getElementById('f_scale').value.trim(),searchKeywords:searchKeywords});
    const body=Object.assign({},BASE,{capability:capability});
    const m=document.getElementById('msg');m.textContent='儲存中…重算所有案子(數秒)';
    fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(r=>r.json()).then(j=>{m.innerHTML=j.ok?'\\u2705 已儲存並重算!→ <a href="/">回列表看新結果</a>':'\\u274c 失敗';
        if(j.ok)setTimeout(()=>location.reload(),900);});
  }
  genUrl();
</script></body></html>`;
}

// 🤖 Agents 中控台:列出所有 agent 的設定資料 + 學到的東西 + 聊天機器人
function pageAgents() {
  const p = loadProfile();
  const cfg = loadConfig();
  const cap = p.capability || {};
  const os = computeOutcomeStats();
  const note = outcomeNoteText(os);
  const rate = (o) => (o.n ? Math.round((o.pos / o.n) * 100) + '%' : '—');

  // 🧠 Profile Agent:已證明能力
  const caps = (p.provenCapabilities || []);
  const capsHtml = caps.length
    ? caps.map((c) => `<li><b>${esc(c.repo)}</b> — ${esc(c.capability)} <small style="color:var(--mut)">[${esc((c.techs || []).join('/'))}]</small></li>`).join('')
    : '<li class="reason">尚未執行 Profile Agent。</li>';

  // 🎯 能力邊界(第二道門)
  const skillsHtml = (cap.skills || []).length
    ? `<table><tr><th>可交付項目</th><th>深度</th><th>✅ 能做</th><th>🚫 不做</th></tr>${(cap.skills || []).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.level)}/5</td><td>${esc(s.canDo) || '<span style="color:var(--mut)">—</span>'}</td><td>${esc(s.cantDo) || '<span style="color:var(--mut)">—</span>'}</td></tr>`).join('')}</table>`
    : '<p class="reason">尚未設定能力。去 <a href="/me">🎯 我的能力</a> 設定。</p>';

  // ⚖️ 評分設定
  const C = cfg.scoring.criteria;
  const weightsHtml = CRIT_ORDER.map((k) => `${C[k].label} ${C[k].weight}%`).join(' · ');

  // 📈 學習迴路:AI 預測勝率 vs 真實結果
  const bRow = (label, o) => `<tr><td>${label}</td><td>${o.n}</td><td>${o.pos}</td><td><b>${rate(o)}</b></td></tr>`;
  const catRows = Object.entries(os.cat).filter(([, o]) => o.n >= 1)
    .sort((a, b) => b[1].n - a[1].n)
    .map(([c, o]) => `<tr><td>${esc(c)}</td><td>${o.n}</td><td>${o.pos}</td><td>${rate(o)}</td></tr>`).join('');
  const learnedHtml = os.decided >= 1
    ? `<p class="reason">共投有結果 <b>${os.decided}</b> 案(待回 ${os.pending} · 錄取 ${os.won})。「獲回應」= 已回覆/面試中/已錄取。</p>
       <table><tr><th>AI 預測勝率組</th><th>投了</th><th>獲回應</th><th>實際命中率</th></tr>
       ${bRow('估 ≥60%', os.buckets.high)}${bRow('估 40-59%', os.buckets.mid)}${bRow('估 <40%', os.buckets.low)}${bRow('未估', os.buckets.none)}</table>
       ${catRows ? `<p class="reason" style="margin-top:12px">依領域:</p><table><tr><th>領域</th><th>投了</th><th>獲回應</th><th>命中率</th></tr>${catRows}</table>` : ''}
       <p class="reason" style="margin-top:12px">${note ? '🔁 餵給 AI 快篩的校正:<br>' + esc(note) : '⚠️ 樣本未達 5 案,還不夠餵給 AI 校正(避免噪音)。多標幾筆結果就會自動啟用。'}</p>`
    : '<p class="reason">還沒有投標結果。投標後到「② 評估案件」頁右上角把結果標起來(已回覆/面試/錄取/落選),這裡就會統計,並回饋給 AI 校正未來勝率估計。</p>';

  const updated = p.provenUpdatedAt ? esc(p.provenUpdatedAt.slice(0, 16).replace('T', ' ')) : '尚未執行';

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 設定總覽</title><style>${CSS}
  .asec{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:14px 0}
  .asec h2{margin-top:0;border-left:3px solid var(--ac);padding-left:10px;font-size:16px}
  .asec table{width:100%;border-collapse:collapse;margin-top:6px}
  .asec td,.asec th{border:1px solid var(--bd);padding:7px 9px;text-align:left;font-size:13px;vertical-align:top}
  .asec th{background:#0d1117;color:var(--mut)}
  .asec ul{margin:6px 0;padding-left:20px}.asec li{margin:5px 0;font-size:14px}
  .chatbox{display:flex;flex-direction:column;height:340px;background:#0d1117;border:1px solid var(--bd);border-radius:10px;overflow:hidden}
  .chatlog{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
  .bub{max-width:85%;padding:8px 12px;border-radius:10px;font-size:14px;white-space:pre-wrap;line-height:1.5}
  .bub.u{align-self:flex-end;background:var(--ac);color:#fff}
  .bub.a{align-self:flex-start;background:var(--card);border:1px solid var(--bd)}
  .chatin{display:flex;gap:8px;padding:10px;border-top:1px solid var(--bd)}
  .chatin input{flex:1;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:9px}
  .chatin button{background:var(--ac);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer}
  .qhint{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  .qhint button{background:var(--card);border:1px solid var(--bd);color:var(--mut);border-radius:14px;padding:4px 11px;font-size:12px;cursor:pointer}
  .qhint button:hover{border-color:var(--ac);color:var(--tx)}</style></head><body>
<header><h1>🤖 AI 設定總覽 <span class="sub">系統裡每個 AI 怎麼設定的、學到了什麼,都彙整在這。要修改請點各區塊的「編輯 →」到對應頁面。</span></h1>${navBar('/agents')}</header>
<main class="wide">
  <div class="cols">
    <div class="colmain">
  <div class="asec">
    <h2>🧠 Profile Agent — 已證明能力</h2>
    <p class="reason">自動抓 GitHub(<b>${esc(p.githubUser || 'Harry1667')}</b>)歸納真實作品能力,供求職信引用、評分加成。上次更新:${updated} · 共 ${caps.length} 項 · ${(p.provenTechs || []).length} 個技術關鍵字。
      <button class="open" onclick="runAgent()" style="margin-left:6px">🔄 立即重跑</button> <span id="amsg" class="reason"></span></p>
    <ul>${capsHtml}</ul>
  </div>

  <div class="asec">
    <h2>🎯 能力邊界(第二道門) <a href="/me" style="font-size:13px;font-weight:400">編輯 →</a></h2>
    ${skillsHtml}
    <p class="reason" style="margin-top:10px">🚫 紅線(不碰):${esc((cap.redlines || []).join('、')) || '—'}</p>
    <p class="reason">📏 規模上限:${esc(cap.scaleCeiling) || '—'}</p>
  </div>

  <div class="asec">
    <h2>🚪 第一道門關鍵字(案子來源) <a href="/me" style="font-size:13px;font-weight:400">編輯 →</a></h2>
    <div class="tags">${(cap.searchKeywords || []).map((k) => `<span class="pill">${esc(k)}</span>`).join('') || '<span class="reason">—</span>'}</div>
  </div>

  <div class="asec">
    <h2>⚖️ 評分設定 <a href="/scoring" style="font-size:13px;font-weight:400">編輯 →</a></h2>
    <p class="reason">模式:<b>${cfg.scoring.mode === 'newbie' ? '🌱 新手' : '⚖️ 標準'}</b> · APPLY 門檻 ≥${cfg.scoring.threshold} · MAYBE ≥${cfg.scoring.maybeThreshold}</p>
    <p class="reason">權重:${weightsHtml}</p>
  </div>

  <div class="asec">
    <h2>📈 學習迴路 — Agent 學到的東西</h2>
    ${learnedHtml}
  </div>
    </div>

    <div class="side">
  <div class="asec">
    <h2>💬 問 Agents</h2>
    <p class="reason">問它任何關於你的設定、能力、實績、某個案子值不值得投。它看得到上面所有資料。</p>
    <div class="qhint">
      <button onclick="ask(this.textContent)">我的能力邊界有哪些?</button>
      <button onclick="ask(this.textContent)">根據我的投標實績,我該調整什麼?</button>
      <button onclick="ask(this.textContent)">現在最值得投的案是哪幾個?</button>
    </div>
    <div class="chatbox">
      <div class="chatlog" id="clog"><div class="bub a">嗨,我是你的接案 Agent。上面的設定與實績我都看得到,問我吧。</div></div>
      <div class="chatin"><input id="cin" placeholder="輸入問題…" onkeydown="if(event.key==='Enter')send()"><button onclick="send()">送出</button></div>
    </div>
  </div>
    </div>
  </div>
</main>
<script>
  const hist=[];
  function bubble(role,text){var d=document.createElement('div');d.className='bub '+(role==='user'?'u':'a');d.textContent=text;
    document.getElementById('clog').appendChild(d);var l=document.getElementById('clog');l.scrollTop=l.scrollHeight;return d;}
  function ask(q){document.getElementById('cin').value=q;send();}
  async function send(){var inp=document.getElementById('cin'),q=inp.value.trim();if(!q)return;inp.value='';
    bubble('user',q);hist.push({role:'user',content:q});
    var ph=bubble('assistant','思考中…');
    try{var r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({messages:hist,context:{page:'AI 設定總覽',scope:'agents'}})});
      var j=await r.json();ph.textContent=j.ok?j.reply:('\\u274c '+(j.error||'失敗'));
      if(j.ok)hist.push({role:'assistant',content:j.reply});}
    catch(e){ph.textContent='\\u274c '+e.message;}}
  async function runAgent(){var m=document.getElementById('amsg');m.textContent='執行中…抓 GitHub + AI 歸納(約 1-2 分,勿關閉)';
    try{var r=await fetch('/api/agent/profile',{method:'POST'});var j=await r.json();
      m.textContent=j.ok?('\\u2705 完成:'+j.count+' 項。重新整理看更新。'):'\\u274c '+(j.error||'失敗');}
    catch(e){m.textContent='\\u274c '+e.message;}}
</script></body></html>`;
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
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>評分設定</title><style>${CSS}
  .modes{display:flex;gap:10px;margin:6px 0 18px}
  .modebtn{flex:1;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:12px;cursor:pointer;text-align:left}
  .modebtn small{display:block;color:var(--mut);font-size:12px;margin-top:3px}
  .modebtn.on{border-color:var(--ac);background:#13233b}</style></head><body>
<header><h1>⚖️ 評分設定 <span class="sub">調整「怎麼判斷一個案子好不好」的規則 — 決定哪些案會被推到你面前（值得投/可考慮/排除）。</span></h1>${navBar('/scoring')}</header>
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
  return `<aside class="sidebar">
    <div class="brand">📋 Upwork Filter <small>v2</small></div>
    <div class="group">接案流程</div>
    ${link('/', '① 找案子', active === '/')}
    ${link('/job' + q, '② 評估案件', active === '/job')}
    ${link('/proposal' + q, '③ 寫提案', active === '/proposal')}
    ${link('/reply', '④ 回客戶訊息', active === '/reply')}
    ${link('/invites', '⑤ 客戶邀請', active === '/invites' || active === '/invite')}
    <div class="group">每日</div>
    ${link('/today', '🌅 今日待辦', active === '/today')}
    ${link('/?fav=1', '❤️ 收藏案件', false)}
    ${link('/applications', '📊 投案追蹤', active === '/applications')}
    <div class="group">我的設定</div>
    ${link('/me', '🎯 我的能力', active === '/me')}
    ${link('/profile', '🪪 我的身分檔', active === '/profile')}
    ${link('/scoring', '⚖️ 評分設定', active === '/scoring')}
    ${link('/features', '🧩 功能需求地圖', active === '/features')}
    ${link('/agents', '🤖 AI 設定', active === '/agents')}
    <div class="group">學習工具</div>
    ${link('/lessons', '📌 AI 糾錯紀錄', active === '/lessons')}
    ${link('/anchors', '⭐ 信件範本', active === '/anchors')}
    ${link('/backup', '💾 備份/還原', active === '/backup')}
    <div class="logout"><a href="/logout">→ 登出</a></div>
  </aside>`;
}

// 📌 Lessons 頁:使用者抓到 AI 錯就存,**所有 AI prompt 自動讀取啟用中的 lessons** 當硬規則
function pageLessons() {
  const db = openDb();
  const rows = listLessons(db, false);
  const list = rows.map((l) => `
    <li data-id="${l.id}" style="padding:14px;border:1px solid var(--bd);border-radius:10px;margin:8px 0;background:${l.enabled ? 'var(--card)' : '#0d1117'};opacity:${l.enabled ? 1 : 0.55}">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <input type="checkbox" ${l.enabled ? 'checked' : ''} onchange="toggleL(${l.id}, this.checked)" style="margin-top:4px;width:18px;height:18px">
        <div style="flex:1">
          <div style="color:var(--tx);line-height:1.55;font-size:14px">${esc(l.content)}</div>
          <div style="color:var(--mut);font-size:12px;margin-top:6px">#${l.id} · ${esc(l.category || 'general')} · 套用 ${l.hit_count || 0} 次 · ${esc((l.created_at || '').slice(0, 10))}</div>
        </div>
        <button onclick="delL(${l.id})" style="background:none;border:0;color:#f85149;cursor:pointer;font-size:18px;padding:0 8px">🗑</button>
      </div>
    </li>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>📌 AI 糾錯紀錄</title><style>${CSS}
  .lesson-form{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:18px}
  .lesson-form textarea{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font:14px/1.55 inherit;resize:vertical;min-height:60px}
  .lesson-form input{background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:8px 10px;font:13px inherit}
  .lesson-form button{background:var(--grn);color:#fff;border:0;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:14px;font-weight:600}
  ul.ls{list-style:none;margin:0;padding:0}
  .empty{color:var(--mut);text-align:center;padding:40px;font-size:14px}
  .help{background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:12px 14px;color:var(--tx);font-size:13px;line-height:1.65;margin-bottom:18px}
  </style></head><body>
<header><h1>📌 AI 糾錯紀錄 <span class="sub">你抓到的 AI 錯誤都記在這（俗稱 Lessons）— 所有 AI 任務會自動讀取,違反 = 嚴重錯誤。</span></h1>${navBar('/lessons')}</header>
<main class="wide">
  <div class="cols">
    <div class="colmain">
      <div class="lesson-form">
        <div style="color:var(--mut);font-size:13px;margin-bottom:6px">✍️ 新增一條 lesson(會強制套用到所有 AI prompt)</div>
        <textarea id="content" placeholder="例如:不要寫 'n8n shipped extensively',我只做過手寫 webhook 自動化"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
          <input id="category" placeholder="分類(可空,如 honesty / tech / location)" style="flex:1">
          <button onclick="addL()">➕ 新增</button>
        </div>
      </div>
      <ul class="ls" id="ls">${list || '<div class="empty">還沒有 lesson。看到 AI 寫錯什麼,就來這裡記一條。</div>'}</ul>
    </div>

    <div class="side">
      <div class="help">
        <b>📖 怎麼用</b><br>
        • 你發現 AI 寫了不該寫的東西(撒謊 / 用錯時區 / 留 placeholder),就在這裡新增一條 lesson<br>
        • <b>勾選 = 啟用</b>,所有 AI(求職信 / 助手 / 評估)都會自動讀<br>
        • 取消勾選 = 暫時不套用,但保留紀錄<br>
        • 🗑 = 永久刪除<br>
        • 「套用 N 次」= 這條被多少次 AI 任務讀到
      </div>
    </div>
  </div>
</main>
<script>
  async function addL(){
    const c=document.getElementById('content').value.trim();
    const cat=document.getElementById('category').value.trim()||'general';
    if(!c){alert('內容不能空');return;}
    const r=await fetch('/api/lessons',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:c,category:cat})});
    const j=await r.json();
    if(j.ok)location.reload();else alert('失敗:'+(j.error||'?'));
  }
  async function toggleL(id,enabled){
    await fetch('/api/lessons/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,enabled})});
    location.reload();
  }
  async function delL(id){
    if(!confirm('確定刪除這條 lesson?'))return;
    await fetch('/api/lessons/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
    location.reload();
  }
</script></body></html>`;
}

// 🌅 每日 Briefing — 開站第一眼看「今天該做什麼」+ 真實成功率
function pageToday() {
  const db = openDb();
  const stats = applicationStats(db);
  const apps = listApplications(db);
  const now = Date.now();
  const daysSince = (d) => d ? Math.floor((now - new Date(d).getTime()) / 86400000) : 999;
  // 待處理:已投 7+ 天還是 sent 狀態(可能被閱了你沒更新,或該標 no_response)
  const pending = apps.filter((a) => a.status === 'sent' && daysSince(a.applied_at) >= 7);
  // 該標沒回:已投 14+ 天還是 sent(預設算 no_response)
  const ghosted = apps.filter((a) => a.status === 'sent' && daysSince(a.applied_at) >= 14);
  // 有回但沒進展:replied 3+ 天沒動
  const stalled = apps.filter((a) => a.status === 'replied' && daysSince(a.status_updated_at) >= 3);
  // 今日新案 + 撿漏單
  const today = new Date().toISOString().slice(0, 10);
  const newToday = db.prepare(`SELECT COUNT(*) as n FROM jobs WHERE substr(first_seen,1,10)=?`).get(today)?.n || 0;
  const junkAvail = db.prepare(`SELECT COUNT(*) as n FROM jobs WHERE applied=0 AND payment_verified=1 AND proposals_bucket IN ('Fewer than 5','5 to 10') AND (fixed_budget BETWEEN 20 AND 200 OR hourly_max BETWEEN 5 AND 20 OR (fixed_budget IS NULL AND hourly_max IS NULL))`).get()?.n || 0;
  // 最近 7 天投案
  const week = db.prepare(`SELECT COUNT(*) as n FROM applications WHERE applied_at >= date('now','-7 days')`).get()?.n || 0;
  const weekResponded = db.prepare(`SELECT COUNT(*) as n FROM applications WHERE applied_at >= date('now','-7 days') AND status NOT IN ('sent','no_response')`).get()?.n || 0;
  // Lessons / Anchors 狀態
  const lessons = listLessons(db, true);
  const anchors = listAnchors(db, true);

  const apList = (rows) => rows.length ? rows.slice(0, 10).map((a) => `
    <li style="padding:10px 12px;border:1px solid var(--bd);border-radius:8px;margin:6px 0;background:#0d1117">
      <div style="display:flex;gap:10px;align-items:center">
        <span style="flex:1"><b style="color:var(--tx)">${esc((a.job_title || '?').slice(0, 70))}</b><br>
        <span style="color:var(--mut);font-size:12px">投了 ${daysSince(a.applied_at)} 天 · ${esc(a.rate || '')}</span></span>
        <a href="/applications" style="color:var(--ac);text-decoration:none;font-size:13px">處理 →</a>
      </div>
    </li>`).join('') : '<div style="color:var(--mut);padding:10px">無</div>';

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>🌅 今日</title><style>${CSS}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px}
  .stat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;text-align:center}
  .stat .n{font-size:24px;font-weight:700}
  .stat .l{color:var(--mut);font-size:12px;margin-top:4px}
  .section{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:14px}
  .section h2{margin:0 0 10px 0;font-size:15px}
  main>h2,.colmain>h2,.side>h2{margin:28px 0 12px;border-top:1px solid var(--bd);padding-top:16px;font-size:16px}
  main>h2:first-of-type,.colmain>h2:first-of-type,.side>h2:first-of-type{border-top:0;margin-top:4px;padding-top:0}
  .cta{display:block;background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:14px;color:var(--tx);text-decoration:none;margin-bottom:10px;font-size:14px}
  .cta:hover{background:#1f2630}
  .cta b{color:var(--ac)}
  .empty{color:var(--mut);padding:10px;font-size:13px}
  </style></head><body>
<header><h1>🌅 今日待辦 <span class="sub">${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', weekday: 'long', month: 'long', day: 'numeric' })} · 每天開站第一眼看這頁,先處理今天該做的事。</span></h1>${navBar('/today')}</header>
<main class="wide">

  <h2 style="margin-top:0">📊 真實數據(取代 AI 猜測)</h2>
  <div class="grid">
    <div class="stat"><div class="n" style="color:var(--ac)">${stats.total}</div><div class="l">總投案</div></div>
    <div class="stat"><div class="n" style="color:#79c0ff">${stats.responseRate}%</div><div class="l">回應率</div></div>
    <div class="stat"><div class="n" style="color:#d29922">${stats.interviewRate}%</div><div class="l">面試率</div></div>
    <div class="stat"><div class="n" style="color:#56d364">${stats.hireRate}%</div><div class="l">中標率</div></div>
    <div class="stat"><div class="n" style="color:#8b949e">${week}</div><div class="l">本週投 (${weekResponded}有回)</div></div>
  </div>

  <div class="cols">
    <div class="colmain">
      <h2>⚡ 今天該做的</h2>
      ${pending.length ? `<div class="section"><h2>📬 待跟進 (投了 7+ 天還在 sent 狀態,${pending.length} 個)</h2><ul style="list-style:none;margin:0;padding:0">${apList(pending)}</ul></div>` : ''}
      ${ghosted.length ? `<div class="section"><h2>🕳 該標沒回 (14+ 天無音訊,${ghosted.length} 個 — 建議改 no_response 釋出心理空間)</h2><ul style="list-style:none;margin:0;padding:0">${apList(ghosted)}</ul></div>` : ''}
      ${stalled.length ? `<div class="section"><h2>💬 有回但卡 3+ 天 (${stalled.length} 個 — 該主動推進對話)</h2><ul style="list-style:none;margin:0;padding:0">${apList(stalled)}</ul></div>` : ''}
      ${(!pending.length && !ghosted.length && !stalled.length) ? '<div class="empty">目前沒有需要跟進的案子 🎉 去找新案或撿漏吧。</div>' : ''}

      <h2>🦴 今日撿漏池</h2>
      <a href="/" class="cta">
        <b>${junkAvail}</b> 個符合撿漏條件(付款驗證 + 提案 < 10 + 預算 $20-200) · 今日新進 <b>${newToday}</b> 個案 →
      </a>
    </div>

    <div class="side">
      <h2>🧠 學習狀態</h2>
      <a href="/lessons" class="cta">📌 啟用中 Lessons:<b>${lessons.length}</b> 條 → ${lessons.length < 5 ? '建議 5 條起跳,每次抓到 AI 寫錯就加' : '繼續累積'}</a>
      <a href="/anchors" class="cta">⭐ 啟用中 Anchors:<b>${anchors.length}</b> 個 → ${anchors.length < 1 ? '寫過順的信去 ③ 寫提案頁點 ⭐ 標為範本' : '繼續累積'}</a>
    </div>
  </div>

  ${stats.total === 0 ? '<div style="background:#13233b;border-left:3px solid #d29922;border-radius:8px;padding:14px;color:var(--tx);font-size:14px;line-height:1.65;margin-top:20px"><b>💡 還沒投過案?</b><br>系統再強,沒投案 = 沒資料 = 沒學習。<br>建議:今天去 <a href="/" style="color:var(--ac)">① 找案子</a> 點 🦴 撿漏 → 投 1-3 個爛單。第一個 5★ 比第 10 個功能重要。</div>' : ''}

</main></body></html>`;
}

// 💾 備份 / 還原頁
function pageBackup() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>💾 備份</title><style>${CSS}
  .section{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:14px}
  .btn{background:var(--grn);color:#fff;border:0;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px;font-weight:600;text-decoration:none;display:inline-block}
  .btn:hover{filter:brightness(1.1)}
  .btn.warn{background:#d29922}
  .help{background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:12px 14px;color:var(--tx);font-size:13px;line-height:1.65;margin-bottom:18px}
  </style></head><body>
<header><h1>💾 備份 / 還原 <span class="sub">DB 壞掉 / 換電腦時的保險</span></h1>${navBar('/backup')}</header>
<main>
  <div class="help">
    <b>📖 內容</b>:lessons + anchors + applications。<br>
    profile.json / jobs 不在這份備份(profile 自己 git 管,jobs 隨時可從擴充功能重抓)。<br>
    <b>還原策略</b>:append(不刪現有),不會覆蓋。
  </div>

  <div class="section">
    <h2>📤 匯出</h2>
    <p style="color:var(--mut);font-size:13px">把所有 lessons / anchors / applications 下載成 JSON 檔。建議每週備份一次。</p>
    <a href="/api/backup/export" class="btn">⬇ 下載備份檔</a>
  </div>

  <div class="section">
    <h2>📥 還原</h2>
    <p style="color:var(--mut);font-size:13px">把備份檔丟回來,會 append 進去(不會清掉現有)。</p>
    <input type="file" id="f" accept=".json" style="background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:8px"><br><br>
    <button class="btn warn" onclick="restore()">📥 還原</button>
    <span id="msg" style="margin-left:10px;color:var(--grn)"></span>
  </div>

</main>
<script>
  async function restore(){
    var f=document.getElementById('f').files[0];if(!f){alert('選個檔');return;}
    var txt=await f.text();
    try{var body=JSON.parse(txt);}catch(e){alert('JSON 解析失敗');return;}
    var r=await fetch('/api/backup/restore',{method:'POST',headers:{'content-type':'application/json'},body:txt});
    var j=await r.json();
    document.getElementById('msg').textContent=j.ok?('✅ 加 lessons '+j.added.lessons+' / anchors '+j.added.anchors+' / applications '+j.added.applications):('❌ '+j.error);
  }
</script></body></html>`;
}

// ⭐ Anchors 頁:你親自審過 OK 的 cover letter 範本,當 voice 校準參考(few-shot 注入)
function pageAnchors() {
  const db = openDb();
  const rows = listAnchors(db, false);
  const list = rows.map((a) => `
    <li data-id="${a.id}" style="padding:14px;border:1px solid var(--bd);border-radius:10px;margin:10px 0;background:${a.enabled ? 'var(--card)' : '#0d1117'};opacity:${a.enabled ? 1 : 0.55}">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="toggleA(${a.id}, this.checked)" style="margin-top:4px;width:18px;height:18px">
        <div style="flex:1">
          <div style="color:var(--ac);font-weight:600;margin-bottom:4px">${esc(a.job_title || '(未命名)')}</div>
          <details style="margin-top:6px"><summary style="color:var(--mut);font-size:12px;cursor:pointer">展開內容 (${(a.cover_letter || '').length} 字)</summary>
          <pre style="background:#0d1117;border:1px solid #272e3a;border-radius:6px;padding:10px;margin-top:6px;color:var(--tx);font:13px/1.55 inherit;white-space:pre-wrap">${esc(a.cover_letter || '')}</pre>
          </details>
          ${a.note ? `<div style="color:var(--mut);font-size:12px;margin-top:6px">📝 ${esc(a.note)}</div>` : ''}
          <div style="color:var(--mut);font-size:12px;margin-top:4px">#${a.id} · ${esc((a.created_at || '').slice(0, 10))}</div>
        </div>
        <button onclick="delA(${a.id})" style="background:none;border:0;color:#f85149;cursor:pointer;font-size:18px">🗑</button>
      </div>
    </li>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⭐ 信件範本</title><style>${CSS}
  .help{background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:12px 14px;color:var(--tx);font-size:13px;line-height:1.65;margin-bottom:18px}
  ul.ls{list-style:none;margin:0;padding:0}
  .empty{color:var(--mut);text-align:center;padding:40px;font-size:14px}
  </style></head><body>
<header><h1>⭐ 信件範本 <span class="sub">你親自審過、覺得寫得好的求職信（俗稱 Anchors）— 存成範本後,AI 寫新信會對齊這些的語氣與寫法。</span></h1>${navBar('/anchors')}</header>
<main>
  <div class="help">
    <b>📖 怎麼用</b><br>
    • 在 ③ 寫提案頁產出 cover letter,你覺得這封寫得真的好 → 點 <b>⭐ 標為範本</b><br>
    • 啟用的範本(打勾的)會被注入到 <b>所有未來</b> AI 寫信任務當參考<br>
    • 最多保留 3 個最新的當 anchor(避免 prompt 太長)<br>
    • 取消勾選 = 暫停,🗑 = 刪除<br>
    • <b>新手前 5 案不用急著加</b>,等寫過幾封順的再挑來標,品質才會好
  </div>
  <ul class="ls" id="ls">${list || '<div class="empty">還沒有 anchor。在 ③ 寫提案頁產生 cover letter 後,挑寫得好的點⭐ 標為範本。</div>'}</ul>
</main>
<script>
  async function toggleA(id,enabled){
    await fetch('/api/anchors/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,enabled})});
    location.reload();
  }
  async function delA(id){
    if(!confirm('刪除這個 anchor?'))return;
    await fetch('/api/anchors/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
    location.reload();
  }
</script></body></html>`;
}

// 📊 投案追蹤頁:每案狀態 (sent → viewed → replied → interview → hired/rejected)、回應率統計
function pageApplications() {
  const db = openDb();
  const apps = listApplications(db);
  const stats = applicationStats(db);
  const statusOpts = ['sent', 'viewed', 'replied', 'interview', 'hired', 'rejected', 'no_response'];
  const statusLabel = { sent: '✉️ 已投', viewed: '👁 已閱', replied: '💬 有回', interview: '🎤 面試', hired: '🎉 中標', rejected: '❌ 拒絕', no_response: '🕳 沒回' };
  const statusColor = { sent: '#8b949e', viewed: '#79c0ff', replied: '#3fb950', interview: '#d29922', hired: '#56d364', rejected: '#f85149', no_response: '#6e7681' };
  const rows = apps.map((a) => {
    const opts = statusOpts.map((s) => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${statusLabel[s]}</option>`).join('');
    const fmtDate = (d) => (d || '').slice(0, 16).replace('T', ' ');
    return `
    <tr data-id="${a.id}">
      <td style="white-space:nowrap">${esc(fmtDate(a.applied_at))}</td>
      <td><div style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.job_title || a.job_id || '?')}</div></td>
      <td>${esc(a.rate || '')}</td>
      <td style="text-align:center">${a.connects_used || 0}</td>
      <td><select onchange="upd(${a.id},'status',this.value,this)" style="background:#0d1117;color:${statusColor[a.status] || '#8b949e'};border:1px solid #272e3a;border-radius:6px;padding:5px 8px;font-weight:600">${opts}</select></td>
      <td>${esc(fmtDate(a.response_at))}</td>
      <td><input id="n${a.id}" type="text" value="${esc(a.notes || '')}" onblur="upd(${a.id},'notes',this.value)" style="background:#0d1117;color:var(--tx);border:1px solid #272e3a;border-radius:6px;padding:5px 8px;width:160px"></td>
      <td>
        <button onclick="suggestL(${a.id})" title="從備註萃取 Lesson" style="background:none;border:0;color:#d29922;cursor:pointer;font-size:16px">🧠</button>
        <button onclick="delA(${a.id})" style="background:none;border:0;color:#f85149;cursor:pointer;font-size:16px">🗑</button>
      </td>
    </tr>`;
  }).join('');
  const byStatus = (s) => stats.by[s] || 0;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>📊 投案追蹤</title><style>${CSS}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:18px}
  .stat{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;text-align:center}
  .stat .n{font-size:22px;font-weight:700;color:var(--ac)}
  .stat .l{color:var(--mut);font-size:12px;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:var(--card);border-radius:10px;overflow:hidden}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #272e3a;font-size:13px;vertical-align:middle}
  th{background:#0d1117;color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase}
  tr:hover{background:#0d1117}
  .empty{color:var(--mut);text-align:center;padding:40px}
  .help{background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:12px 14px;color:var(--tx);font-size:13px;line-height:1.65;margin-bottom:18px}
  </style></head><body>
<header><h1>📊 投案追蹤 <span class="sub">每案狀態、回應率、Connects 燒了多少 — 練手後看哪些 pattern 有效</span></h1>${navBar('/applications')}</header>
<main>
  <div class="help">
    <b>📖 怎麼用</b><br>
    • 投出去後在 ③ 寫提案頁按「✅ 我投了」會自動建紀錄,或來這手動加<br>
    • 之前在列表頁勾過「☑️ 已投」的案子? 點下方紅色按鈕一鍵匯入<br>
    • 收到客戶回覆 → 點下拉改 <b>💬 有回</b>;進面試 → 改 <b>🎤 面試</b>;成交 → <b>🎉 中標</b><br>
    • Notes 欄寫「為什麼這案沒中?」→ 點 🧠 一鍵萃取 Lesson
    <div style="margin-top:10px"><button onclick="importApplied()" style="background:#f85149;color:#fff;border:0;border-radius:8px;padding:8px 16px;cursor:pointer;font-size:13px;font-weight:600">🔄 從『已投』案件匯入</button> <span id="impmsg" style="color:var(--grn);font-size:13px;margin-left:8px"></span></div>
  </div>
  <div class="grid">
    <div class="stat"><div class="n">${stats.total}</div><div class="l">總投案</div></div>
    <div class="stat"><div class="n" style="color:#79c0ff">${byStatus('viewed') + byStatus('replied') + byStatus('interview') + byStatus('hired') + byStatus('rejected')}</div><div class="l">有反應 (${stats.responseRate}%)</div></div>
    <div class="stat"><div class="n" style="color:#d29922">${byStatus('interview') + byStatus('hired')}</div><div class="l">面試 (${stats.interviewRate}%)</div></div>
    <div class="stat"><div class="n" style="color:#56d364">${byStatus('hired')}</div><div class="l">中標 (${stats.hireRate}%)</div></div>
    <div class="stat"><div class="n" style="color:#f85149">${byStatus('rejected') + byStatus('no_response')}</div><div class="l">拒絕/沒回</div></div>
    <div class="stat"><div class="n" style="color:#8b949e">${stats.totalConnects}</div><div class="l">Connects 燒</div></div>
  </div>
  ${apps.length ? `<table>
    <thead><tr><th>投案日</th><th>案名</th><th>報價</th><th style="text-align:center">Conn</th><th>狀態</th><th>回應日</th><th>備註</th><th></th></tr></thead>
    <tbody id="tb">${rows}</tbody>
  </table>` : '<div class="empty">還沒投過案。投完一個案來這加一筆紀錄。</div>'}
</main>
<script>
  async function upd(id,field,value,el){
    const r=await fetch('/api/applications/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,[field]:value})});
    if(r.ok&&el)el.style.outline='2px solid #3fb950',setTimeout(function(){el.style.outline='';},800);
  }
  async function delA(id){
    if(!confirm('刪除這筆投案紀錄?'))return;
    await fetch('/api/applications/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});
    location.reload();
  }
  async function importApplied(){
    var m=document.getElementById('impmsg');m.textContent='匯入中…';
    var r=await fetch('/api/applications/import-applied',{method:'POST'});
    var j=await r.json();
    if(j.ok){m.textContent='✅ 匯入 '+j.added+' 筆 (略過 '+j.skipped+' 筆已存在的)';setTimeout(function(){location.reload();},1000);}
    else m.textContent='❌ 失敗';
  }
  async function suggestL(id){
    var notes=document.getElementById('n'+id).value.trim();
    if(notes.length<10){alert('Notes 太短(<10字),先寫一下「為什麼這案沒中/沒回」');return;}
    var btn=event.target;btn.textContent='⏳';
    try{
      var r=await fetch('/api/lessons/suggest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({notes:notes})});
      var j=await r.json();btn.textContent='🧠';
      if(!j.ok||!j.candidates.length){alert('沒抽到 lesson 候選(可能 notes 太具體或已存過類似的)');return;}
      var msg='AI 從這條 notes 抽出以下 Lesson 候選:\\n\\n';
      j.candidates.forEach(function(c,i){msg+=(i+1)+'. ['+c.category+'] '+c.content+'\\n\\n';});
      msg+='全部存進 Lessons?';
      if(!confirm(msg))return;
      for(var i=0;i<j.candidates.length;i++){
        await fetch('/api/lessons',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(j.candidates[i])});
      }
      alert('✅ 已存 '+j.candidates.length+' 條 lessons,去 📌 Lessons 看');
    }catch(e){btn.textContent='🧠';alert('❌ '+e.message);}
  }
</script></body></html>`;
}

// 🧩 功能地圖:把同類案子彙整成「大類 → 小功能(含難度/工具/頻率/相依)」
// 不開發,只記錄這類案子通常需要哪些功能。資料來自 npm run features 掃描。
function pageFeatures() {
  const tax = loadTaxonomy();
  const view = toView(tax);
  const dCls = { 低: 'ok', 中: 'mid', 高: 'bad' };
  const updated = tax.updatedAt ? esc(tax.updatedAt.slice(0, 16).replace('T', ' ')) : '尚未掃描';

  // 溯源用:jobId → {標題,網址}(來自掃描時記下的 sources)
  const srcMap = {};
  for (const s of tax.sources || []) srcMap[s.jobId] = { title: s.title, url: s.url };
  // 由 jobId 重建「登入後可用」的 Upwork 原案網址(nx 詳情路徑,同 cleanUrl)。
  // sources.url 常被 ingest 汙染(含 span/highlight markup)或是登出版,一律用 jobId 重建。
  const upworkUrl = (id) => `https://www.upwork.com/jobs/~${String(id).replace(/[^\w]/g, '')}`;
  // 把一組 jobId 渲染成清單:標題 → 站內 ②評估;另給「📋 複製 Upwork」(自己貼開登入版詳情頁)
  const jobLinks = (ids) => (ids || []).map((id) => {
    const j = srcMap[id] || {};
    const url = upworkUrl(id);
    const title = j.title || id;
    return `<li><a href="/job?id=${esc(id)}">${esc(title)}</a> <a href="${esc(url)}" data-url="${esc(url)}" class="ev" onclick="return copyUpwork(event,this)" title="複製 Upwork 連結">📋複製</a></li>`;
  }).join('') || '<li class="reason">(無紀錄)</li>';

  const cats = view.map((c) => {
    // 該大類所有來源案子(去重)
    const catJobIds = [...new Set((tax.sources || []).filter((s) => s.category === c.id).map((s) => s.jobId))];
    const rows = c.features.map((f) => {
      // 工具分兩類:📋 案子點名(忠於描述) vs 💡 AI 建議(典型技術棧)。相容舊資料的 f.tools。
      const inJob = f.toolsInJob || f.tools || [];
      const suggested = f.toolsSuggested || [];
      const tj = inJob.map((t) => `<span class="tj">${esc(t)}</span>`).join('');
      const ts = suggested.map((t) => `<span class="ts">${esc(t)}</span>`).join('');
      const toolsCell =
        (tj ? `<div class="tools"><span class="tlbl">📋 案子點名</span><span class="tags">${tj}</span></div>` : '') +
        (ts ? `<div class="tools"><span class="tlbl sg">💡 AI 建議</span><span class="tags">${ts}</span></div>` : '') ||
        '<span class="reason">—</span>';
      const deps = (f.depends || []).length ? `<div class="dep">↳ 需先:${(f.depends).map(esc).join('、')}</div>` : '';
      // 功能層級溯源:點開看「哪些案子需要這功能」
      const src = (f.jobIds || []).length
        ? `<details class="src"><summary>📄 來源 ${f.jobIds.length} 案</summary><ul>${jobLinks(f.jobIds)}</ul></details>`
        : '';
      return `<tr>
        <td><b>${esc(f.name)}</b>${f.note ? `<div class="reason">${esc(f.note)}</div>` : ''}${deps}${src}</td>
        <td class="${dCls[f.difficulty] || ''}" style="text-align:center;white-space:nowrap">${esc(f.difficulty)}</td>
        <td style="text-align:center"><b>${f.frequency}</b></td>
        <td>${toolsCell}</td>
      </tr>`;
    }).join('');
    // 大類層級溯源
    const catSrc = catJobIds.length
      ? `<details class="src catsrc"><summary>📄 此大類來源案子(${catJobIds.length})</summary><ul>${jobLinks(catJobIds)}</ul></details>`
      : '';
    return `<details class="catbox" open>
      <summary><span class="cn">${esc(c.name)}</span> <span class="reason">${c.jobCount || 0} 個案 · ${c.features.length} 個功能</span></summary>
      <table class="ftab">
        <tr><th>小功能</th><th>難度</th><th>需求案數</th><th>工具 / 技術棧</th></tr>
        ${rows || '<tr><td colspan="4" class="reason">尚無功能</td></tr>'}
      </table>
      ${catSrc}
    </details>`;
  }).join('');

  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>功能需求地圖</title><style>${CSS}
  .scan{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 16px}
  .scan input{flex:1;min-width:200px;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;font-size:14px}
  .catbox{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:8px 16px 14px;margin-bottom:14px}
  .catbox summary{cursor:pointer;font-size:16px;padding:8px 0;list-style:none}
  .catbox summary .cn{font-weight:700}
  .ftab{width:100%;border-collapse:collapse;margin-top:6px}
  .ftab th,.ftab td{border:1px solid var(--bd);padding:8px 10px;text-align:left;font-size:13px;vertical-align:top}
  .ftab th{background:#0d1117;color:var(--mut);font-weight:600}
  .ftab .tags{margin:0;display:inline-flex;flex-wrap:wrap;gap:5px}.dep{font-size:12px;color:var(--ac);margin-top:3px}
  .tools{display:flex;align-items:flex-start;gap:8px;margin:2px 0}
  .tlbl{flex:0 0 72px;font-size:11px;color:#3fb950;padding-top:3px;white-space:nowrap}.tlbl.sg{color:var(--mut)}
  .ftab .tj{background:#0d2a18;border-color:#1f6f3f;color:#7ee2a8}
  .ftab .ts{opacity:.75;font-style:italic}
  .src{margin-top:5px}.src summary{cursor:pointer;font-size:12px;color:var(--ac);list-style:none}
  .src ul{margin:5px 0 2px;padding-left:18px}.src li{margin:2px 0;font-size:12px}
  .src .ev{font-size:11px;color:var(--mut);margin-left:6px}
  .catsrc{margin-top:10px;padding-top:8px;border-top:1px solid var(--bd)}.catsrc summary{font-size:13px}
  .ok{color:#3fb950}.mid{color:#d29922}.bad{color:#f85149}</style></head><body>
<header><h1>🧩 功能需求地圖 <span class="sub">同一類型的案子,客戶通常會要求哪些功能 · 更新:${updated}</span></h1>${navBar('/features')}</header>
<main class="wide">
  <div class="cols">
    <div class="colmain">
      ${cats || '<p class="reason">還沒有資料。在右側輸入工作類型按「掃描功能」,或在終端機跑 <code>npm run features -- "chatbot"</code>。</p>'}
    </div>

    <div class="side">
      <div class="lesson-form" style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="color:var(--mut);font-size:13px;margin-bottom:8px">🔍 掃描某類工作的功能需求</div>
        <input id="q" placeholder="例如:chatbot, voice assistant" style="width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:9px 12px;font-size:14px;box-sizing:border-box">
        <button class="save" id="go" onclick="scan()" style="margin-top:10px">🔍 掃描功能</button>
        <p id="st" class="reason" style="margin-top:8px"></p>
      </div>
      <div class="help" style="background:#13233b;border-left:3px solid var(--ac);border-radius:8px;padding:12px 14px;color:var(--tx);font-size:13px;line-height:1.65">
        輸入工作類型(關鍵字),系統從同類案子用 AI 歸納出「這類案子通常需要哪些小功能」並標難度/工具/出現頻率。<b>只記錄功能,不開發</b>。一次可輸入多個,用逗號分隔。<br><br>工具分兩類:<b style="color:#7ee2a8">📋 案子點名</b>=描述裡真的出現的;<b style="color:var(--mut)">💡 AI 建議</b>=這功能通常會用到的典型技術(AI 推測,非客戶要求)。
      </div>
    </div>
  </div>
</main>
<script>
  async function scan(){
    const q=document.getElementById('q').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(!q.length){alert('請先輸入工作類型關鍵字');return;}
    const btn=document.getElementById('go'),st=document.getElementById('st');
    btn.disabled=true;st.textContent='送出中…';
    try{const r=await fetch('/api/scan-features',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({queries:q})});
      const j=await r.json();
      if(j.ok&&j.started){st.innerHTML='✅ 已開始背景掃描 '+j.queries+' 個關鍵字(每個約 1-3 分)。完成後<a href="/features"> 重新整理</a> 看結果,不用一直等。';}
      else st.textContent='❌ '+(j.error||'失敗');}
    catch(e){st.textContent='❌ '+e.message;}
    btn.disabled=false;}
</script></body></html>`;
}

// 🤖 助手:跟 AI 對話(像聊天),帶入你的檔案 + 案件清單當上下文
function pageAssistant() {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接案助手</title><style>${CSS}
  .chat{display:flex;flex-direction:column;height:calc(100vh - 150px);max-width:860px;margin:0 auto}
  .msgs{flex:1;overflow-y:auto;padding:8px 0}
  .msg{margin:10px 0;display:flex}.msg .b{max-width:80%;padding:11px 15px;border-radius:14px;white-space:pre-wrap;line-height:1.6;font-size:14px}
  .msg.user{justify-content:flex-end}.msg.user .b{background:var(--ac);color:#fff;border-bottom-right-radius:4px}
  .msg.bot .b{background:var(--card);border:1px solid var(--bd);border-bottom-left-radius:4px}
  .inbar{display:flex;gap:8px;padding:10px 0;border-top:1px solid var(--bd)}
  .inbar textarea{flex:1;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:10px;padding:11px;font:14px/1.5 inherit;resize:none;min-height:46px;max-height:140px}
  .hint{color:var(--mut);font-size:12px;margin:4px 0}</style></head><body>
<header><h1>🤖 接案助手 <span class="sub">問我任何事:這案值不值得投、怎麼報價、幫想策略…我看得到你的檔案和案件清單</span></h1>${navBar('/assistant')}</header>
<main>
  <div class="chat">
    <div class="msgs" id="msgs">
      <div class="msg bot"><div class="b">嗨!我是你的接案助手 👋 我看得到你的檔案和目前的案件清單。可以問我例如:\n• 今天哪幾個案最值得投?\n• 這個案我該報多少?\n• 幫我想這案的切入角度\n• 客戶這樣回我該怎麼接?</div></div>
    </div>
    <div class="hint" id="hint"></div>
    <div class="inbar">
      <textarea id="in" placeholder="輸入問題… (Enter 送出,Shift+Enter 換行)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send();}"></textarea>
      <button class="save" id="sendBtn" onclick="send()">送出</button>
    </div>
  </div>
</main>
<script>
  const history=[];
  const msgs=document.getElementById('msgs');
  function add(role,text){const d=document.createElement('div');d.className='msg '+(role==='user'?'user':'bot');
    const b=document.createElement('div');b.className='b';b.textContent=text;d.appendChild(b);msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;return b;}
  async function send(){const ta=document.getElementById('in'),btn=document.getElementById('sendBtn'),hint=document.getElementById('hint');
    const text=ta.value.trim();if(!text)return;ta.value='';add('user',text);history.push({role:'user',content:text});
    btn.disabled=true;hint.textContent='助手思考中…';const bubble=add('bot','…');
    try{const r=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages:history})});
      const j=await r.json();
      if(j.ok){bubble.textContent=j.reply;history.push({role:'assistant',content:j.reply});}
      else bubble.textContent='❌ '+(j.error||'失敗');}
    catch(e){bubble.textContent='❌ '+e.message;}
    hint.textContent='';btn.disabled=false;ta.focus();}
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

// ⑤ 邀請列表 — 客戶主動邀請(invites from clients),跟 jobs 分流
function pageInvites() {
  const invites = allInvites(db);
  const recBadge = (rec) => {
    if (!rec) return '<span class="reason">未分析</span>';
    if (rec.includes('認真')) return '<span style="color:var(--grn);font-weight:600">🟢 ' + esc(rec) + '</span>';
    if (rec.includes('可投')) return '<span style="color:var(--ylw);font-weight:600">🟡 ' + esc(rec) + '</span>';
    if (rec.includes('decline')) return '<span style="color:#ff9580;font-weight:600">🟠 ' + esc(rec) + '</span>';
    return '<span style="color:#f85149;font-weight:600">🔴 ' + esc(rec) + '</span>';
  };
  const rows = invites.length === 0
    ? `<tr><td colspan="6" style="text-align:center;color:var(--mut);padding:32px">尚無邀請。把 Upwork 邀請貼進右側「手動新增」表單即可分析。</td></tr>`
    : invites.map((i) => {
        const archived = i.status === 'archived';
        return `<tr${archived ? ' style="opacity:.5"' : ''}>
          <td>${i.received_text ? esc(i.received_text) : (i.received_at ? esc(i.received_at.slice(0, 16).replace('T', ' ')) : '-')}</td>
          <td><a href="/invite?id=${esc(i.id)}">${esc((i.title || '(未命名)').slice(0, 70))}</a></td>
          <td>${i.client_spent_text ? esc(i.client_spent_text) : '-'} ${i.client_payment_verified ? '✅' : ''}</td>
          <td>${i.client_hires != null ? esc(String(i.client_hires)) + ' hires' : '-'}</td>
          <td>${i.ai_score != null ? '<b>' + i.ai_score + '</b>/10' : '-'}<br>${recBadge(i.ai_recommendation)}</td>
          <td><a class="open" href="/invite?id=${esc(i.id)}">查看 →</a></td>
        </tr>`;
      }).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⑤ 客戶邀請</title><style>${CSS}
  table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:10px;border-bottom:1px solid var(--bd);text-align:left;vertical-align:top}th{color:var(--mut);font-weight:500}
  .layout{display:grid;grid-template-columns:1fr 380px;gap:20px}@media(max-width:1000px){.layout{grid-template-columns:1fr}}
  textarea,input{width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:13px;box-sizing:border-box}
  textarea{min-height:140px;font-family:inherit}
  label{display:block;color:var(--mut);font-size:12px;margin:10px 0 4px}
  .panel{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px}
  </style></head><body>
<header><h1>⑤ 客戶邀請 <span class="sub">客戶主動發來邀請你投標的案子 — 系統會套用你的能力邊界,幫你判斷值不值得花時間寫提案。</span></h1>${navBar('/invites')}</header>
<main>
  <div class="layout">
    <div>
      <table>
        <thead><tr><th>收到</th><th>標題</th><th>客戶花費</th><th>Hires</th><th>AI 評分</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="panel">
      <h3 style="margin:0 0 8px">➕ 手動新增邀請</h3>
      <p class="reason" style="margin:0 0 12px">把 Upwork 邀請的標題、案件描述、客戶數據貼進來。AI 會套你的 capability 紅線給三層評判。</p>
      <label>案件標題</label>
      <input id="iv_title" placeholder="例:Taiwanese Mandarin & Hokkien Speakers Needed">
      <label>案件 URL(選填)</label>
      <input id="iv_url" placeholder="https://www.upwork.com/jobs/~xxx">
      <label>客戶花費(選填,例 $59K spent)</label>
      <input id="iv_spent" placeholder="$59K spent">
      <label>客戶 Hires(選填,只填數字)</label>
      <input id="iv_hires" type="number" placeholder="4722">
      <label>付款已驗證?</label>
      <select id="iv_pv" style="width:100%;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px">
        <option value="">未知</option><option value="1">是</option><option value="0">否</option>
      </select>
      <label>邀請/案件原文(必填)</label>
      <textarea id="iv_raw" placeholder="貼整段案件描述 + 邀請訊息(越完整越準)…"></textarea>
      <p style="margin-top:14px"><button class="save" onclick="add()">✨ 新增並立刻分析</button> <span id="st" class="reason"></span></p>
    </div>
  </div>
</main>
<script>
async function add(){
  const raw=document.getElementById('iv_raw').value.trim();
  if(!raw){alert('請貼上邀請/案件原文');return;}
  const body={
    title:document.getElementById('iv_title').value.trim(),
    url:document.getElementById('iv_url').value.trim(),
    client_spent_text:document.getElementById('iv_spent').value.trim(),
    client_hires:document.getElementById('iv_hires').value?Number(document.getElementById('iv_hires').value):null,
    client_payment_verified:document.getElementById('iv_pv').value===''?null:document.getElementById('iv_pv').value==='1',
    raw_text:raw
  };
  document.getElementById('st').textContent='新增中…';
  try{
    const r=await fetch('/api/invites/ingest',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(!j.ok){document.getElementById('st').textContent='❌ '+(j.error||'失敗');return;}
    document.getElementById('st').textContent='✅ 已新增,跳轉中…';
    location.href='/invite?id='+encodeURIComponent(j.id)+'&autoanalyze=1';
  }catch(e){document.getElementById('st').textContent='❌ '+e.message;}
}
</script></body></html>`;
}

// ⑤b 邀請評估(單筆) — 顯示原文 + 客戶資訊 + AI 三層評判
function pageInvite(id) {
  const inv = id ? getInvite(db, id) : null;
  if (!inv) {
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>邀請評估</title><style>${CSS}</style></head><body>
<header><h1>⑤ 邀請評估</h1>${navBar('/invite')}</header>
<main><div class="panel" style="background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:20px">
  <p>找不到這筆邀請。<a href="/invites">← 回邀請列表</a></p>
</div></main></body></html>`;
  }
  let parsed = null;
  try { parsed = inv.ai_analysis_json ? JSON.parse(inv.ai_analysis_json) : null; } catch { parsed = null; }
  const verdictBlock = (label, obj) => obj
    ? `<div class="vbox"><div class="vlabel">${label}</div><div class="vval">${esc(obj.verdict || '-')}</div><div class="vnote">${esc(obj.note || '')}</div></div>`
    : '';
  const analysisHtml = parsed ? `
    <div class="grid3">
      ${verdictBlock('🟢 客戶品質', parsed.clientQuality)}
      ${verdictBlock('🟡 案子契合度', parsed.fitness)}
      ${verdictBlock('🔴 邀請真實性', parsed.authenticity)}
    </div>
    ${parsed.redFlags && parsed.redFlags.length ? `<div class="warn"><b>🚩 紅旗:</b><ul style="margin:6px 0 0 18px">${parsed.redFlags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
    <div class="action"><b>👉 建議行動:</b> ${esc(parsed.action || '')}</div>
    ${parsed.declineMessage ? `<div class="dmsg"><b>📋 可直接貼的 decline 訊息(英文):</b><br><pre>${esc(parsed.declineMessage)}</pre><button class="save" style="padding:4px 10px;font-size:12px" onclick="navigator.clipboard.writeText(${JSON.stringify(parsed.declineMessage)});this.textContent='✅ 已複製'">📋 複製</button></div>` : ''}
  ` : `<p class="reason">尚未分析。按下方「✨ 立刻分析」。</p>`;
  const scoreColor = parsed?.score >= 8 ? 'var(--grn)' : parsed?.score >= 5 ? 'var(--ylw)' : '#f85149';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⑤ 邀請評估</title><style>${CSS}
  .panel{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:14px}
  .meta{display:flex;flex-wrap:wrap;gap:14px;color:var(--mut);font-size:13px;margin:8px 0}
  .meta b{color:var(--tx)}
  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}@media(max-width:800px){.grid3{grid-template-columns:1fr}}
  .vbox{background:#0d1117;border:1px solid var(--bd);border-radius:8px;padding:12px}
  .vlabel{color:var(--mut);font-size:12px;margin-bottom:6px}
  .vval{font-size:18px;font-weight:600;margin-bottom:6px}
  .vnote{color:var(--mut);font-size:13px;line-height:1.5}
  .warn{background:rgba(248,81,73,.08);border:1px solid #f8514955;border-radius:8px;padding:12px;margin:12px 0;color:#ffb4ad;font-size:13px}
  .action{background:rgba(63,185,80,.08);border:1px solid #3fb95055;border-radius:8px;padding:14px;margin:12px 0;font-size:14px;line-height:1.6}
  .dmsg{background:#0d1117;border:1px solid var(--bd);border-radius:8px;padding:14px;margin:12px 0}
  .dmsg pre{white-space:pre-wrap;margin:8px 0;font-family:inherit;color:var(--tx)}
  .raw{background:#0d1117;border:1px solid var(--bd);border-radius:8px;padding:14px;white-space:pre-wrap;max-height:400px;overflow:auto;font-size:13px;color:var(--mut)}
  .bigscore{display:inline-block;font-size:42px;font-weight:700;color:${scoreColor}}
  </style></head><body>
<header><h1>⑤ 邀請評估 <span class="sub"><a href="/invites">← 回邀請列表</a></span></h1>${navBar('/invite')}</header>
<main>
  <div class="panel">
    <h2 style="margin:0 0 4px">${esc(inv.title || '(未命名)')}</h2>
    <div class="meta">
      ${inv.received_text ? `<span>📅 <b>${esc(inv.received_text)}</b></span>` : ''}
      ${inv.client_spent_text ? `<span>💰 客戶花費 <b>${esc(inv.client_spent_text)}</b></span>` : ''}
      ${inv.client_hires != null ? `<span>👥 <b>${esc(String(inv.client_hires))}</b> hires</span>` : ''}
      ${inv.client_payment_verified ? `<span>✅ 付款已驗證</span>` : ''}
      ${inv.url ? `<span><a href="#" data-url="${esc(inv.url)}" onclick="return copyUpwork(event,this)">🔗 複製 Upwork 連結</a></span>` : ''}
    </div>
    <p style="margin-top:10px">
      <button class="save" onclick="analyze()" id="anbtn">${parsed ? '🔁 重新分析' : '✨ 立刻分析'}</button>
      <button class="save" style="background:#444" onclick="archiveIt()">📦 Archive</button>
      <span id="st" class="reason"></span>
    </p>
  </div>

  ${parsed ? `<div class="panel"><div style="display:flex;align-items:center;gap:20px"><div><div class="vlabel" style="color:var(--mut);font-size:12px">綜合評分</div><span class="bigscore">${parsed.score ?? '-'}</span><span style="color:var(--mut)">/10</span></div><div style="font-size:20px;font-weight:600">${esc(parsed.recommendation || '')}</div></div></div>` : ''}

  <div class="panel">
    <h3 style="margin:0 0 10px">📊 三層評判</h3>
    ${analysisHtml}
  </div>

  <div class="panel">
    <h3 style="margin:0 0 10px">📄 邀請/案件原文</h3>
    <div class="raw">${esc(inv.raw_text || '(未填)')}</div>
  </div>
</main>
<script>
${COPY_JS.replace(/<\/?script>/g, '')}
async function analyze(){
  const btn=document.getElementById('anbtn');btn.disabled=true;
  document.getElementById('st').textContent='分析中…(約 20 秒)';
  try{
    const r=await fetch('/api/invites/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(inv.id)}})});
    const j=await r.json();
    if(j.ok){location.reload();}
    else{document.getElementById('st').textContent='❌ '+(j.error||'失敗');btn.disabled=false;}
  }catch(e){document.getElementById('st').textContent='❌ '+e.message;btn.disabled=false;}
}
async function archiveIt(){
  if(!confirm('確定 archive 這筆邀請?'))return;
  try{
    const r=await fetch('/api/invites/archive',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:${JSON.stringify(inv.id)}})});
    const j=await r.json();
    if(j.ok){location.href='/invites';}
    else{alert('失敗:'+(j.error||''));}
  }catch(e){alert('❌ '+e.message);}
}
// 從列表跳來時 ?autoanalyze=1 自動跑一次
if(new URLSearchParams(location.search).get('autoanalyze')==='1'&&!${parsed ? 'true' : 'false'}){setTimeout(analyze,400);}
</script></body></html>`;
}

// 勝率估計 — 有 AI 中標機率(ai_win)就用它,否則用規則粗估
// 第一單 / Connects 紀律 chip(卡片頂部精簡標籤)— 接 score.js 的 can-win 判斷
function firstWinChips(job, cfg) {
  const chip = (txt, bg, fg, title) => `<span title="${esc(title || '')}" style="font-size:11px;padding:2px 7px;border-radius:10px;background:${bg};color:${fg};font-weight:600;white-space:nowrap">${txt}</span>`;
  const chips = [];
  let firstTarget = false;
  try { firstTarget = isFirstReviewTarget(job, cfg); } catch { /* 缺欄位就略過 */ }
  const cd = connectsDiscipline(job, cfg?.scoring?.connectsHot ?? 16);
  if (firstTarget) chips.push(chip('🎯 第一單目標', '#16321c', '#7ee787', '小而明確、好客戶、低競爭 — 適合衝第一個評價'));
  if (cd.avoidApply) chips.push(chip('🔴 別投', '#3d1e1e', '#f85149', cd.reasons.join('；')));
  else if (cd.noBoost) chips.push(chip('🚫 不要 boost', '#3a2e15', '#e3b341', cd.reasons.join('；')));
  // 技術可但難贏:能力高但勝率低(新帳號搶不到)
  const skill = job.score_skill ?? 0;
  const winPct = job.ai_win != null ? job.ai_win : winRateHint(job).pct;
  if (skill >= 70 && winPct < 40 && !firstTarget && !cd.avoidApply) {
    chips.push(chip('🟡 技術可但難贏', '#3a2e15', '#e3b341', '能力夠但新帳號勝率低,別期待太高'));
  }
  return chips.join('');
}

function winRateHint(job) {
  if (job.ai_win != null) {
    const pct = job.ai_win;
    const level = pct >= 70 ? '高' : pct >= 45 ? '中' : '低';
    const color = pct >= 70 ? 'var(--grn)' : pct >= 45 ? 'var(--ylw)' : '#f85149';
    return { pct, level, color, note: 'AI 估計(綜合競爭/契合/客戶意願)', isAi: true };
  }
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
  return { pct, level, color, note: bits.join('、') || '條件中性', isAi: false };
}

// 勝率深入解析:為什麼這個數字 + 值不值得投 + 怎麼脫穎而出(規則式,免額外 AI)
// 兩軸獨立:quality(案子好不好,0-10) 與 win(接不接得到,0-100)。勝率「不」計入總分。
function winRateAnalysis(job, ev) {
  const win = winRateHint(job);
  const quality = ev?.isAi ? ev.score : (job.total_score ?? 0) / 10; // 正規化到 0-10
  const goodJob = quality >= 6.5;
  const lowWin = win.pct < 45;

  // 為什麼:把可得的訊號拆出來(競爭/契合/客戶),讓數字有依據
  const factors = [];
  const prop = job.proposals_bucket || '';
  if (prop) {
    const heavy = /20|50|\+/.test(prop);
    factors.push({ label: '競爭', detail: `提案 ${prop}${heavy ? '(偏多,晚投更吃虧)' : ''}`, good: !heavy });
  }
  const skill = job.score_skill ?? 0;
  factors.push({ label: '能力契合', detail: skill >= 80 ? '高度吻合(有作品證據)' : skill >= 50 ? '中等' : '偏弱', good: skill >= 70 });
  const cli = job.score_client ?? 0;
  factors.push({ label: '客戶', detail: cli >= 60 ? '條件佳' : '普通', good: cli >= 60 });
  if (job.client_hire_rate != null) factors.push({ label: '雇用率', detail: job.client_hire_rate + '%' + (job.client_hire_rate < 40 ? '(常發案少聘)' : ''), good: job.client_hire_rate >= 50 });

  // 值不值得投(Connects 紀律框架,接 score.js can-win):新帳號別「賭一把」,把 Connects 留給搶得到的小案
  let cfgFW = null; try { cfgFW = loadConfig(); } catch { /* ignore */ }
  const cd = connectsDiscipline(job, cfgFW?.scoring?.connectsHot ?? 16);
  const firstTarget = cfgFW ? (() => { try { return isFirstReviewTarget(job, cfgFW); } catch { return false; } })() : false;
  let worth, worthCls;
  if (cd.avoidApply || win.pct < 30) {
    worth = `🔴 不要 boost — ${cd.reasons[0] || '勝率過低'}。除非你能用「已完成的 demo」差異化,否則跳過,把 Connects 留給好案。`;
    worthCls = 'bad';
  } else if (firstTarget) {
    worth = '🎯 第一單目標 — 小而明確的好案,可投。但「不要 boost」(或只小額),提案點出客戶痛點 + 提議小額試做降低風險。';
    worthCls = 'ok';
  } else if (goodJob && !lowWin) {
    worth = '🟢 首選 — 案子好、又搶得到,優先投,提案做紮實即可。' + (cd.noBoost ? '(此案不建議 boost)' : '');
    worthCls = 'ok';
  } else if (goodJob && lowWin) {
    worth = '🟡 好案但競爭激烈 — 可投但「不要 boost」,提案必須用真實作品差異化,否則別投。';
    worthCls = 'mid';
  } else if (!goodJob && !lowWin) {
    worth = '🟡 容易接但案子普通 — 適合衝第一個評價/練手,別期待高報酬。';
    worthCls = 'mid';
  } else {
    worth = '🔴 又難搶又普通 — 大機率浪費 Connects,建議略過,把 Connects 留給好案。';
    worthCls = 'bad';
  }

  // 怎麼脫穎而出(低勝率時的具體戰術)
  const tips = [
    '開頭 3 行直接點出客戶的痛點與你的解法,別用通用模板(AI 一看就知道)',
    '附「最相關」的真實作品連結/截圖 — 去 ③ 寫提案 看系統建議主打哪個',
    /20|50|\+/.test(prop) ? '此案提案已多 → 越早投越好,並在開頭證明你已讀懂需求(問一個聰明問題)' : '提早投、客製化開場',
    '報價用「價值定位」而非殺價;新手可給明確里程碑與快速交付承諾降低客戶風險'
  ];

  return { ...win, quality: quality.toFixed(1), goodJob, lowWin, factors, worth, worthCls, tips };
}

// 共用:單一案頂部資訊列(評估/提案頁共用)
function jobBarHtml(job, active) {
  const sid = jid(job.id); // XSS 安全化
  const back = active === '/proposal' ? `<a href="/job?id=${sid}">← 回評估</a>` : `<a href="/">← 回列表</a>`;
  const outcomes = ['', '已投待回', '已回覆', '面試中', '已錄取', '沒回/落選'];
  const opts = outcomes.map((o) => `<option value="${esc(o)}"${(job.outcome || '') === o ? ' selected' : ''}>${o || '— 投標結果 —'}</option>`).join('');
  return `<div class="jobbar">
    ${back}
    <a href="${esc(cleanUrl(job))}" data-url="${esc(cleanUrl(job))}" onclick="return copyUpwork(event,this)" title="複製 Upwork 連結,自己貼到網址列開啟(登入版)">📋 複製 Upwork 連結</a>
    <label class="applied"><input type="checkbox" ${job.applied ? 'checked' : ''} onchange="markJob('${sid}',this.checked)"> 標記已投</label>
    <button id="favBtn" onclick="favThis('${sid}')" title="收藏案件" style="background:none;border:1px solid var(--bd);border-radius:6px;padding:4px 12px;font-size:14px;cursor:pointer">${job.favorited ? '❤️ 已收藏' : '🤍 收藏'}</button>
    <button onclick="markPrivate('${sid}')" title="點進去發現 Access denied / 私案 / 已 hire?點這個直接 SKIP" style="background:#3d1e1e;color:#f85149;border:1px solid #f85149;border-radius:6px;padding:4px 10px;font-size:13px;cursor:pointer">🔒 標為私案 / 已關閉</button>
    <select onchange="setOutcome('${sid}',this.value)" style="background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:4px 8px;font-size:13px">${opts}</select>
  </div>
  <script>
    function setOutcome(id,v){fetch('/api/outcome?id='+id+'&outcome='+encodeURIComponent(v),{method:'POST'});}
    async function markPrivate(id){
      if(!confirm('確認標為「私案/已關閉」?\\n會直接 SKIP,不計入提案。'))return;
      await fetch('/api/job/mark-private?id='+id,{method:'POST'});
      location.href='/';
    }
    async function favThis(id){
      var b=document.getElementById('favBtn');var on=b.textContent.indexOf('❤️')>=0;var newVal=on?0:1;
      await fetch('/api/job/favorite?id='+id+'&fav='+newVal,{method:'POST'});
      b.textContent=newVal?'❤️ 已收藏':'🤍 收藏';
    }
  </script>`;
}
const notFoundPage = (title, active, id) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>
<header><h1>${title}</h1>${navBar(active)}</header>
<main><p class="reason">${id ? '找不到這個案(可能已從資料庫移除)。' : '請從 <a href="/">① 找案子</a> 挑一個案。'}</p></main></body></html>`;

// ② 評估:純判斷 — 核心數據 + 7維評分 + 勝率 + 工作內容。不產文案(去 ③ 提案)
function pageJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return notFoundPage('② 評估案件', '/job', id);
  const cfg = loadConfig();
  const C = cfg.scoring.criteria;
  const ev = effectiveVerdict(job);
  const wr = winRateAnalysis(job, ev);
  const verdictLine = ev.isAi
    ? `AI 判斷 ${ev.score}/10 · ${esc(ev.verdict)}　|　規則快篩 ${job.total_score}/100`
    : `規則快篩 ${job.total_score}/100 · ${job.verdict}`;
  const aid = String(id).replace(/[^\w-]/g, '');
  const hasAnalysis = existsSync(path.join(__dirname, '..', `upwork-${aid}-analysis.html`));
  const age = ageInfo(job.last_seen);
  const core = [
    ['預算', job.budget_text], ['類型', job.budget_type],
    [age.stale ? '提案數(抓取時·恐已增)' : '提案數(抓取時)', job.proposals_bucket],
    ['付款驗證', job.payment_verified ? '✅ 是' : '❌ 否'], ['客戶花費', job.client_spent_text],
    ['雇用率', job.client_hire_rate != null ? job.client_hire_rate + '%' : null],
    ['客戶評分', job.client_rating != null ? '★ ' + job.client_rating : null], ['發布', formatPosted(job)],
    ['資料抓取', age.text]
  ].filter(([, v]) => v != null && v !== '' && v !== '未知');
  const coreCards = core.map(([l, v]) => `<div class="c"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('');
  const metrics = CRIT_ORDER.map((k) => {
    const v = job[COL[k]] ?? 0;
    return `<div class="m"><b>${C[k].label}</b> ${v}<div class="${trackCls(v)}"><i style="width:${v}%"></i></div></div>`;
  }).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>評估案件:${esc(job.title)}</title><style>${CSS}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:8px}
  .cards .c{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 12px}.c .l{color:var(--mut);font-size:12px}.c .v{font-size:15px;font-weight:600;margin-top:2px}
  .winbox{display:flex;align-items:center;gap:16px;background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:8px 0}
  .winpct{font-size:34px;font-weight:800;min-width:78px}.desc{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:14px 16px;white-space:pre-wrap;font-size:14px;line-height:1.7;max-height:340px;overflow:auto}
  .winwhy{margin:8px 0}.winwhy .wk{font-size:12px;color:var(--mut);margin-bottom:5px}
  .facs{display:flex;flex-wrap:wrap;gap:6px}
  .fac{font-size:12px;padding:3px 9px;border-radius:14px;border:1px solid var(--bd)}
  .fac.g{background:#0d2a18;border-color:#1f6f3f;color:#7ee2a8}.fac.b{background:#2a1416;border-color:#6e2b30;color:#f0a0a4}
  .worth{padding:11px 14px;border-radius:10px;margin:8px 0;font-size:14px;font-weight:600}
  .worth.ok{background:#1a3a26;color:#7ee2a8}.worth.mid{background:#3a3016;color:#e8c477}.worth.bad{background:#3a1a1a;color:#f0a0a4}
  .howwin{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;margin:8px 0}
  .howwin summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--ac)}
  .howwin ul{margin:10px 0 4px;padding-left:20px}.howwin li{margin:5px 0;font-size:13px}
  .jobbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.jobbar a,.jobbar label{font-size:13px}
  .cta{display:inline-block;background:var(--ac);color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;margin:6px 0}
  #anframe{width:100%;height:600px;border:1px solid var(--bd);border-radius:12px;background:#0d1117}</style></head><body>
<header>
  <h1>② 評估案件 <span class="sub">${verdictLine}</span></h1>
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

  <h2>核心數據 <button class="save" style="background:#30363d;padding:5px 12px;font-size:12px;font-weight:400" onclick="refreshLive()">🔄 抓即時數據</button> <span id="rfmsg" class="reason"></span></h2>
  ${age.stale ? `<div class="worth bad">📸 競爭數據是「${age.text}抓的快照」。提案數/面試數會隨時間暴增(尤其熱門案)— <b>投標前務必到 Upwork 看即時 Proposals / Interviewing</b>,別只信這裡的「${esc(job.proposals_bucket || '?')}」。客戶花費/評分/預算等則穩定可信。</div>` : ''}
  <div class="cards">${coreCards}</div>

  <h2>勝率估計(接不接得到)</h2>
  <div class="winbox">
    <div class="winpct" style="color:${wr.color}">${wr.pct}%</div>
    <div>
      <b style="color:${wr.color}">${wr.level}勝率</b> <span class="reason">${esc(wr.note)}</span><br>
      <span class="reason">總分 <b style="color:var(--tx)">${wr.quality}/10</b> = 案子好不好　·　勝率 <b style="color:${wr.color}">${wr.pct}%</b> = 你接不接得到。<b>兩軸獨立,勝率不計入總分</b> — 好案子常常難搶。</span>
    </div>
  </div>
  <div class="winwhy">
    <div class="wk">為什麼是這個數字</div>
    <div class="facs">${wr.factors.map((f) => `<span class="fac ${f.good ? 'g' : 'b'}">${esc(f.label)}:${esc(f.detail)}</span>`).join('')}</div>
  </div>
  <div class="worth ${wr.worthCls}">${esc(wr.worth)}</div>
  <details class="howwin"${wr.lowWin ? ' open' : ''}>
    <summary>🏆 就算勝率低,怎麼脫穎而出 / 值不值得花 connects</summary>
    <ul>${wr.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <p class="reason">想要這個案子的「客製化中標策略 + 求職信」→ <a href="/proposal?id=${jid(job.id)}">去 ③ 寫提案</a>(AI 會針對此案給差異化打法)。</p>
  </details>

  <h2>7 維評分(規則式)</h2>
  <div class="grid7" style="margin-bottom:8px">${metrics}</div>

  <h2>工作內容</h2>
  <div class="desc">${esc(job.description || '(擴充套件未帶描述)')}</div>

  <p style="margin-top:18px"><a class="cta" href="/proposal?id=${jid(job.id)}">③ 決定投了 → 去寫提案</a></p>
</main>
<script>
  const ID=${JSON.stringify(jid(job.id))}, AID=${JSON.stringify(aid)};
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
  async function refreshLive(){var m=document.getElementById('rfmsg');m.textContent='抓即時數據中…';
    try{var r=await fetch('/api/refresh-job',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:ID})});
      var j=await r.json();
      if(j.ok){m.textContent='✅ 已更新,重整中…';setTimeout(function(){location.reload();},600);}
      else if(j.needLocal){m.innerHTML='⚠️ '+j.msg;}
      else m.textContent='❌ '+(j.error||'失敗');}
    catch(e){m.textContent='❌ '+e.message;}}
</script></body></html>`;
}

// ③ 提案:生產 — 求職信 + 主打作品 + 建議附截圖 + 投標項 + 報價(AI,只在這裡花 token)
function pageProposal(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return notFoundPage('③ 寫提案', '/proposal', id);
  // Connects 紀律橫幅(接 score.js can-win)— 產提案前先提醒別亂投/別 boost
  let cfgP = null; try { cfgP = loadConfig(); } catch { /* ignore */ }
  const cdP = connectsDiscipline(job, cfgP?.scoring?.connectsHot ?? 16);
  let firstP = false; try { firstP = cfgP ? isFirstReviewTarget(job, cfgP) : false; } catch { /* ignore */ }
  let warnBanner = '';
  if (cdP.avoidApply) {
    warnBanner = `<p class="reason" style="background:#3d1e1e;border:1px solid #f85149;border-radius:8px;padding:10px 12px;color:#f85149">🔴 <b>建議別投這案</b> — ${esc(cdP.reasons.join('；'))}。投了多半石沉大海,把 Connects 留給搶得到的小案;要投也<b>絕不要 boost</b>。</p>`;
  } else if (cdP.noBoost) {
    warnBanner = `<p class="reason" style="background:#3a2e15;border:1px solid #e3b341;border-radius:8px;padding:10px 12px;color:#e3b341">🚫 <b>可投,但不要 boost</b> — ${esc(cdP.reasons.join('；'))}。boost 的 Connects 會白燒,提案用真實作品差異化即可。</p>`;
  } else if (firstP) {
    warnBanner = `<p class="reason" style="background:#16321c;border:1px solid #3fb950;border-radius:8px;padding:10px 12px;color:#7ee787">🎯 <b>第一單目標</b> — 小而明確的好案,適合衝第一個評價。提案點出客戶痛點 + 提議小額試做降風險,不要 boost。</p>`;
  }
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>寫提案:${esc(job.title)}</title><style>${CSS}
  .sect{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:16px;margin:14px 0}
  .sect h2{margin:0 0 10px;border:0;padding:0}.out{white-space:pre-wrap;font-size:14px;line-height:1.7;margin-top:10px}
  .jobbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}.jobbar a,.jobbar label{font-size:13px}</style></head><body>
<header>
  <h1>③ 寫提案 <span class="sub">${esc(job.budget_text || '')} · 提案 ${esc(job.proposals_bucket || '?')}</span></h1>
  ${navBar('/proposal', job.id)}
  ${jobBarHtml(job, '/proposal')}
</header>
<main>
  <h2 style="margin-top:4px">${esc(job.title)}</h2>
  <p class="reason">按下方按鈕一次產生:求職信 + 投標策略 + 特殊要求 + 🎯 篩選問題作戰區(逐題答案 + 判斷符不符合)。約 30-60 秒。<b>篩選問題只在提案表單頁</b>,記得把那段一起貼進下方「完整職缺內容」才抓得到。</p>
  <p class="reason" style="background:#13233b;border:1px solid var(--ac);border-radius:8px;padding:10px 12px">💬 <b>想要更自然、能來回修改、且自動列出「這個 apply 每一欄要填什麼」的求職信?</b> 點右下角 💬 助手,把 Upwork 投標頁內容貼進去,說「幫我投這個案」—— 它會列出每個欄位 + 各寫一份草稿,你不滿意就叫它改。(下面這個是一次性版本,適合快速參考)</p>
  <details style="margin:8px 0"><summary style="cursor:pointer;color:var(--mut);font-size:13px">▸ 貼上完整職缺內容(選填,強烈建議)— 抓到影片題/指定專案/篩選問題</summary>
    <textarea id="descOv" placeholder="從 Upwork 投標頁把完整職缺描述(含 To Apply / 影片題 / 指定專案那段)複製貼進來,提案會更完整準確" style="width:100%;min-height:120px;margin-top:8px;background:#0d1117;color:var(--tx);border:1px solid var(--bd);border-radius:8px;padding:10px;font:13px/1.5 inherit"></textarea>
  </details>
  ${warnBanner}
  <p>
    <button class="save" id="go" onclick="gen()">✨ 產生提案</button>
    <button class="save" style="background:#6e7681;margin-left:6px" onclick="gen('consensus')" title="3 個 AI 各寫一版求職信,把差異標出來。多花約 30 秒,但能看出 AI 哪邊不確定">🤝 三 AI 比對版</button>
    <span id="st" class="reason"></span>
  </p>

  <div class="sect" id="reqsect" style="display:none;border-color:#bb8009;background:#3a30160d">
    <h2>⚠️ 這案的特殊投標要求(別漏!)</h2>
    <div class="out" id="reqout"></div>
  </div>

  <div class="sect" id="scrsect" style="display:none;border-color:#b392f0">
    <h2>🎯 篩選問題作戰區 <span class="sub" style="font-size:13px;color:var(--mut);font-weight:400">逐題答案 + 硬門檻判斷你符不符合(要準,記得上面貼完整 JD)</span></h2>
    <div id="scroverall" style="margin-bottom:8px"></div>
    <div class="out" id="scrout"></div>
  </div>

  <div class="sect" id="clsect" style="display:none">
    <div id="consensusbox" style="display:none;margin-bottom:14px;background:#0d1117;border:1px solid #9d7cd8;border-radius:10px;padding:14px">
      <div style="margin-bottom:10px"><b style="color:#9d7cd8">🤝 多模型共識</b><span style="color:var(--mut);font-size:13px;margin-left:8px">3 個 AI 各跑一版,看哪邊有共識/分歧</span></div>
      <div id="consensusList"></div>
    </div>
    <h2>✍️ 求職信(英文,可複製)</h2>
    <button class="save" style="background:var(--grn);padding:6px 12px;font-size:13px" onclick="navigator.clipboard.writeText(window._cl||'');this.textContent='✅ 已複製'">📋 複製</button>
    <button class="save" style="background:#d29922;padding:6px 12px;font-size:13px;margin-left:6px" onclick="markSent()">✅ 我投了(建追蹤)</button>
    <button class="save" style="background:#9d7cd8;padding:6px 12px;font-size:13px;margin-left:6px" onclick="markAnchor()" title="把這封信存為範本,AI 寫新信會對齊這封 voice">⭐ 標為範本</button>
    <span id="sentmsg" style="color:var(--grn);font-size:13px;margin-left:8px"></span>
    <div class="out" id="clout"></div>
    <div id="vstatus" style="display:none;margin-top:10px;color:var(--mut);font-size:13px"></div>
    <div id="verifybox" style="display:none;margin-top:14px;background:#0d1117;border:1px solid #272e3a;border-radius:10px;padding:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="color:var(--ac)">🔍 幻覺偵測 · 事實核查</b><span id="verifysum" style="color:var(--mut);font-size:13px;flex:1"></span></div>
      <div id="verifylist" style="font-size:13px;line-height:1.7"></div>
      <div style="margin-top:10px;color:var(--mut);font-size:12px">💡 ⚠️ 不代表錯,可能是 AI 自由發揮 — 自行確認是否屬實。🚨 是 profile 沒列、可能幻覺,建議改掉。</div>
    </div>
    <div id="pfbox" style="display:none;margin-top:14px;background:#0d1117;border:1px solid #3fb950;border-radius:10px;padding:14px">
      <div style="margin-bottom:10px"><b style="color:#3fb950">✅ 規則檢核 · Pre-flight Checklist</b><span id="pfsum" style="color:var(--mut);font-size:13px;margin-left:8px"></span></div>
      <div id="pflist" style="font-size:13px;line-height:1.65"></div>
    </div>
    <div id="skbox" style="display:none;margin-top:14px;background:#0d1117;border:1px solid #f85149;border-radius:10px;padding:14px">
      <div style="margin-bottom:10px"><b style="color:#f85149">😈 Skeptic · 魔鬼代言人挑刺</b><span id="skverdict" style="color:var(--mut);font-size:13px;margin-left:8px"></span></div>
      <div id="sklist" style="font-size:13px;line-height:1.65"></div>
    </div>
    <div id="citebox" style="display:none;margin-top:14px;background:#0d1117;border:1px solid #272e3a;border-radius:10px;padding:14px">
      <div style="margin-bottom:10px"><b style="color:var(--ac)">📚 Citation · 句句標來源</b><span style="color:var(--mut);font-size:12px;margin-left:8px">每個 claim 的引用來源 — 看 [N] / [?] / [!] 標記找 profile 對應段</span></div>
      <div id="citeAnno" style="background:#161b22;border:1px solid #272e3a;border-radius:8px;padding:10px;font:13px/1.7 inherit;white-space:pre-wrap;color:var(--tx);margin-bottom:10px"></div>
      <div id="citeList" style="font-size:13px;line-height:1.7"></div>
    </div>
  </div>

  <div class="sect" id="exsect" style="display:none">
    <h2>📝 近期相似經驗(英文 · Upwork『Describe your recent experience』可直接貼)</h2>
    <button class="save" style="background:var(--grn);padding:6px 12px;font-size:13px" onclick="navigator.clipboard.writeText(window._ex||'');this.textContent='✅ 已複製'">📋 複製</button>
    <div class="out" id="exout"></div>
  </div>

  <div class="sect" id="adsect" style="display:none">
    <h2>💡 投標策略(報價 / 作品 / Profile highlights)</h2>
    <div class="out" id="adout"></div>
  </div>
</main>
<script>
  const ID=${JSON.stringify(jid(job.id))};
  async function markJob(id,a){await fetch('/api/mark?id='+id+'&applied='+(a?1:0),{method:'POST'});}
  // 🎯 篩選問題作戰區渲染(用 DOM textContent,避免轉義/XSS 問題)
  function renderScreening(d){
    if(!d||!d.hasQuestions){var s=document.getElementById('scrsect');s.style.display='block';
      document.getElementById('scroverall').textContent='';document.getElementById('scrout').innerHTML='<span class="reason">'+((d&&d.overallNote)||'此 JD 沒抓到篩選問題(把提案表單那段也貼進上面的「完整職缺內容」會更準)')+'</span>';return;}
    var ov=document.getElementById('scroverall');ov.innerHTML='';
    var color=(d.overall||'').indexOf('不建議')>=0?'#f85149':(d.overall||'').indexOf('謹慎')>=0?'#d29922':'#3fb950';
    var h=document.createElement('div');h.style.cssText='font-size:16px;font-weight:700;color:'+color;h.textContent='➤ '+(d.overall||'');ov.appendChild(h);
    var n=document.createElement('div');n.className='reason';n.textContent=d.overallNote||'';ov.appendChild(n);
    var out=document.getElementById('scrout');out.innerHTML='';
    (d.questions||[]).forEach(function(q,i){
      var box=document.createElement('div');box.style.cssText='border:1px solid var(--bd);border-radius:8px;padding:10px;margin:8px 0';
      var qt=document.createElement('div');qt.style.fontWeight='600';qt.textContent=(i+1)+'. '+(q.q||'')+(q.hard?'  [硬門檻]':'');box.appendChild(qt);
      var mc=q.meet==='不符合'?'#f85149':q.meet==='勉強符合'?'#d29922':'#3fb950';
      var meet=document.createElement('div');meet.style.margin='5px 0';
      var ms=document.createElement('span');ms.style.cssText='color:'+mc+';font-weight:600';ms.textContent=q.meet||'';meet.appendChild(ms);
      var note=document.createElement('span');note.className='reason';note.textContent='  '+(q.note||'');meet.appendChild(note);box.appendChild(meet);
      var ans=document.createElement('div');ans.style.cssText='background:#0d1117;border:1px solid var(--bd);border-radius:6px;padding:8px;white-space:pre-wrap;font-size:13px;margin-top:4px';ans.textContent=q.answer||'';box.appendChild(ans);
      var btn=document.createElement('button');btn.className='save';btn.style.cssText='background:var(--grn);padding:4px 10px;font-size:12px;margin-top:6px';btn.textContent='📋 複製答案';btn.onclick=function(){navigator.clipboard.writeText(ans.innerText);btn.textContent='✅ 已複製';};box.appendChild(btn);
      out.appendChild(box);
    });
    document.getElementById('scrsect').style.display='block';
  }
  async function gen(mode){const btn=document.getElementById('go'),st=document.getElementById('st');
    const descOverride=(document.getElementById('descOv').value||'').trim();
    btn.disabled=true;st.textContent='產生中…('+(mode==='consensus'?'🤝 3 模型共識,約 60-90 秒':'求職信 + 策略 + 篩選問題作戰區,約30-60秒')+')';
    const body=JSON.stringify({id:ID,descOverride:descOverride});
    const clUrl='/api/cover-letter'+(mode?'?mode='+mode:'?skipverify=1');
    const cover=fetch(clUrl,{method:'POST',headers:{'content-type':'application/json'},body:body}).then(r=>r.json());
    const adv=fetch('/api/advice',{method:'POST',headers:{'content-type':'application/json'},body:body}).then(r=>r.json());
    const scr=fetch('/api/screening',{method:'POST',headers:{'content-type':'application/json'},body:body}).then(r=>r.json()).catch(function(){return{ok:false};});
    try{
      const [c,a,sc]=await Promise.all([cover,adv,scr]);
      if(sc&&sc.ok&&sc.data)renderScreening(sc.data);
      if(c.ok){window._cl=c.text;document.getElementById('clout').textContent=c.text;document.getElementById('clsect').style.display='block';
        // 🤝 渲染共識(若有)
        if(c.consensus&&(c.consensus.outputs||[]).length){
          var cb=document.getElementById('consensusbox'),cl=document.getElementById('consensusList');
          cl.innerHTML=c.consensus.outputs.map(function(o){
            return '<details style="background:#161b22;border:1px solid #272e3a;border-radius:8px;padding:10px;margin:6px 0"><summary style="cursor:pointer;color:'+(o.ok?'#3fb950':'#f85149')+';font-weight:600">'+(o.ok?'✅':'❌')+' '+o.provider.toUpperCase()+' ('+(o.text||'').length+' 字)</summary><pre style="margin-top:8px;color:var(--tx);white-space:pre-wrap;font:13px/1.6 inherit">'+(o.text||'').replace(/</g,'&lt;')+'</pre></details>';
          }).join('');
          cb.style.display='block';
        }
        renderVerify(c);
      }
      if(a.ok){const d=a.data;
        if((d.applyRequirements||[]).length){
          var reqHtml=(d.applyRequirements).map(function(x){return '• '+x;}).join('<br>');
          if((d.videoScripts||[]).length){
            reqHtml+='<br><br><b>🎥 影片講稿大綱(SOP 3 題模板):</b><br>'+
              (d.videoScripts).map(function(s,i){return '<div style="background:#0d1117;border:1px solid #272e3a;border-radius:8px;padding:10px;margin:6px 0;font-size:13px;line-height:1.55"><b>Q'+(i+1)+'</b><br>'+s+'</div>';}).join('');
          }
          if(d.requiredProjectAnswer){
            reqHtml+='<br><b>📋 Required Project 答案建議:</b><br><div style="background:#0d1117;border:1px solid #272e3a;border-radius:8px;padding:10px;margin-top:6px;font-size:13px">'+d.requiredProjectAnswer+'</div>';
          }
          reqHtml+='<br><br><span style="color:var(--mut)">需要進一步客製化?點右下角 💬 助手,告訴它要哪一題。</span>';
          document.getElementById('reqout').innerHTML=reqHtml;
          document.getElementById('reqsect').style.display='block';
        }
        if(d.recentExperience){window._ex=d.recentExperience;document.getElementById('exout').textContent=d.recentExperience;document.getElementById('exsect').style.display='block';}
        const hl=(d.profileHighlights||[]).map(x=>'<span class="pill">'+x+'</span>').join(' ');
        document.getElementById('adout').innerHTML=
          (d.visibility?'<div style="background:#1f2630;border-left:3px solid #d29922;padding:10px 12px;border-radius:6px;margin-bottom:14px"><b>🚦 能見度 (新手關鍵):</b> '+d.visibility+'</div>':'')+
          '<b>💲 報價:</b>'+(d.bid||d.priceSuggestion||'')+
          (d.connectsBid?'<br><br><b>🎯 Connects 競標:</b>'+d.connectsBid:'')+
          '<br><br><b>🔗 GitHub:</b>'+(d.githubLink?'<a href=\"'+d.githubLink+'\" target=\"_blank\">'+d.githubLink+'</a>':'(未設)')+
          '<br><br><b>📌 Profile highlights(挑這4個,第1個最強最相關):</b><br>'+(hl||'—')+
          '<br><br><b>🖼️ 該主打作品(優先有 live URL 的):</b><br>'+(d.showPortfolio||[]).map(x=>'• '+x).join('<br>')+
          (d.screenshot?'<br><b>建議附截圖:</b>'+d.screenshot:'')+
          '<br><br><b>📎 投標應附:</b><br>'+(d.submit||[]).map(x=>'• '+x).join('<br>')+
          '<br><br><b>🎯 切入角度:</b>'+(d.angle||'')+
          (d.winStrategy?'<br><br><b>🏆 勝率策略:</b>'+d.winStrategy:'');
        document.getElementById('adsect').style.display='block';}
      st.textContent=(c.ok||a.ok)?'✅ 完成':'❌ '+((c.error||a.error)||'失敗');
      // 🔍 草稿已出 → 背景補跑驗證(ensemble 才有;consensus 跳過驗證、用 3 模型比對代替)
      if(c.ok&&window._cl&&mode!=='consensus')fetchVerify(ID,window._cl);
    }catch(e){st.textContent='❌ '+e.message;}
    btn.disabled=false;}
  // 🔍 渲染 4 路驗證(幻覺/引用/skeptic/preflight)— 主流程與背景補跑共用
  function renderVerify(c){
    if(c.verify&&(c.verify.claims||[]).length){
      var v=c.verify,box=document.getElementById('verifybox'),list=document.getElementById('verifylist'),sum=document.getElementById('verifysum');
      var ic={verified:'✅',unverified:'⚠️',contradicted:'🚨'},cc={verified:'#3fb950',unverified:'#d29922',contradicted:'#f85149'};
      var nV=0,nU=0,nC=0;
      list.innerHTML=v.claims.map(function(x){
        var s=x.status||'unverified';if(s==='verified')nV++;else if(s==='contradicted')nC++;else nU++;
        return '<div style="padding:6px 0;border-bottom:1px dashed #272e3a"><span style="color:'+cc[s]+'">'+(ic[s]||'?')+'</span> '+
          '<span style="color:var(--tx)">'+(x.text||'').replace(/</g,'&lt;')+'</span><br>'+
          '<span style="color:var(--mut);font-size:12px;margin-left:24px">'+(x.evidence||'').replace(/</g,'&lt;')+'</span></div>';
      }).join('');
      sum.textContent='✅'+nV+' ⚠️'+nU+' 🚨'+nC+(v.summary?' · '+v.summary:'');
      box.style.display='block';
    }
    if(c.citations&&c.citations.annotated){
      var ct=c.citations,anno=document.getElementById('citeAnno'),lst=document.getElementById('citeList');
      var html=ct.annotated.replace(/</g,'&lt;').replace(/\[\^(\d+|\?|!)\]/g,function(_,n){
        var col=n==='!'?'#f85149':n==='?'?'#d29922':'#3fb950';
        return '<sup style="color:'+col+';font-weight:700;background:#0d1117;padding:0 4px;border-radius:3px;margin:0 1px">['+n+']</sup>';
      });
      anno.innerHTML=html;
      var cic={verified:'✅',unverified:'⚠️',contradicted:'🚨'},ccc={verified:'#3fb950',unverified:'#d29922',contradicted:'#f85149'};
      lst.innerHTML=(ct.sources||[]).map(function(s){
        var col=ccc[s.status]||'#8b949e';
        return '<div style="padding:5px 0;border-bottom:1px dashed #272e3a">'+
          '<span style="color:'+col+';font-weight:700">['+s.n+']</span> '+
          '<span style="color:var(--tx)">'+(s.claim||'').replace(/</g,'&lt;')+'</span> '+
          '<span style="color:var(--mut);font-size:12px">→ '+(s.source||'').replace(/</g,'&lt;')+(s.note?' · '+s.note.replace(/</g,'&lt;'):'')+'</span></div>';
      }).join('');
      document.getElementById('citebox').style.display='block';
    }
    if(c.skeptic&&(c.skeptic.issues||[]).length){
      var sk=c.skeptic,sklist=document.getElementById('sklist');
      var skSev={high:'#f85149',medium:'#d29922',low:'#79c0ff'};
      sklist.innerHTML=sk.issues.map(function(x){
        var col=skSev[x.severity]||'#8b949e';
        return '<div style="padding:8px 0;border-bottom:1px dashed #272e3a">'+
          '<span style="color:'+col+';font-weight:700;text-transform:uppercase;font-size:11px;background:#0d1117;padding:2px 6px;border-radius:3px">'+(x.severity||'med')+'</span> '+
          '<span style="color:var(--tx);margin-left:6px">'+(x.problem||'').replace(/</g,'&lt;')+'</span>'+
          (x.quote?'<div style="margin-left:6px;margin-top:4px;color:#8b949e;font-size:12px;font-style:italic">「'+x.quote.replace(/</g,'&lt;')+'」</div>':'')+
          (x.suggestion?'<div style="margin-left:6px;margin-top:4px;color:#3fb950;font-size:12px">→ '+x.suggestion.replace(/</g,'&lt;')+'</div>':'')+
          '</div>';
      }).join('');
      document.getElementById('skverdict').textContent=sk.verdict||'';
      document.getElementById('skbox').style.display='block';
    }
    if(c.preflight&&(c.preflight.rules||[]).length){
      var pf=c.preflight,pflist=document.getElementById('pflist'),pfsum=document.getElementById('pfsum');
      var nO=0,nB=0,nN=0;
      pflist.innerHTML=pf.rules.map(function(r){
        var pic=r.status==='followed'?'✅':r.status==='broken'?'❌':'⚪',col=r.status==='followed'?'#3fb950':r.status==='broken'?'#f85149':'#8b949e';
        if(r.status==='followed')nO++;else if(r.status==='broken')nB++;else nN++;
        return '<div style="padding:5px 0;border-bottom:1px dashed #272e3a">'+
          '<span style="color:'+col+'">'+pic+'</span> <span style="color:var(--mut);font-size:11px">'+(r.id||'')+'</span> '+
          '<span style="color:var(--tx)">'+(r.desc||'').replace(/</g,'&lt;')+'</span>'+
          (r.status==='broken'&&r.quote?'<div style="margin-left:24px;margin-top:3px;color:#8b949e;font-size:12px;font-style:italic">原文:「'+r.quote.replace(/</g,'&lt;')+'」</div>':'')+
          (r.status==='broken'&&r.fix?'<div style="margin-left:24px;margin-top:3px;color:#3fb950;font-size:12px">→ '+r.fix.replace(/</g,'&lt;')+'</div>':'')+
          '</div>';
      }).join('');
      pfsum.textContent='✅'+nO+' ❌'+nB+' ⚪'+nN+(pf.summary?' · '+pf.summary:'');
      document.getElementById('pfbox').style.display='block';
    }
  }
  // 🔍 草稿出來後背景補跑驗證(獨立請求,不阻塞草稿顯示)
  async function fetchVerify(id,text){
    var vs=document.getElementById('vstatus');
    if(vs){vs.style.display='block';vs.textContent='🔍 背景驗證中(幻覺/引用/skeptic/preflight,約 1-3 分鐘)…';}
    try{
      var r=await fetch('/api/verify-cover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,text:text})});
      var c=await r.json();
      if(c&&c.ok){renderVerify(c);if(vs){vs.textContent='✅ 驗證完成';setTimeout(function(){vs.style.display='none';},4000);}}
      else if(vs){vs.textContent='⚠️ 背景驗證失敗:'+((c&&c.error)||'未知');}
    }catch(e){if(vs)vs.textContent='⚠️ 背景驗證失敗:'+e.message;}
  }
  // ✅ 一鍵建追蹤紀錄 — cover letter / 案標題自動帶入,使用者只要填 rate + connects
  async function markSent(){
    var cl=window._cl||document.getElementById('clout').textContent||'';
    var title=document.querySelector('h1 a')?document.querySelector('h1 a').textContent:(document.title||'');
    var rate=prompt('報價? (例 $25/hr 或 $5500 fixed)','');if(rate===null)return;
    var conn=prompt('總共燒了幾個 Connects? (含 boost,例 21 或 33)','21');if(conn===null)return;
    var r=await fetch('/api/applications',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({job_id:ID,job_title:title,cover_letter:cl,rate:rate.trim(),connects_used:parseInt(conn)||0})});
    var j=await r.json();
    document.getElementById('sentmsg').textContent=j.ok?'✅ 已加進投案追蹤,可以到 📊 追蹤頁看':'❌ 失敗';
  }
  async function markAnchor(){
    var cl=window._cl||document.getElementById('clout').textContent||'';
    if(cl.length<30){alert('沒有 cover letter 內容');return;}
    var title=document.querySelector('h1 a')?document.querySelector('h1 a').textContent:'';
    var note=prompt('這封信好在哪?(可空,但寫一句 voice/結構為什麼好,以後比較好挑)','');if(note===null)return;
    var r=await fetch('/api/anchors',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({job_title:title,cover_letter:cl,note:note.trim()})});
    var j=await r.json();
    document.getElementById('sentmsg').textContent=j.ok?'⭐ 已標為範本,以後 AI 寫信會對齊這個 voice':'❌ 失敗';
  }
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

// 職缺連結 → /jobs/~ID(實證:貼到網址列會登入並直接進該案完整詳情頁:About the client/評分/hire rate/Connects)。
// 跨站「點擊」跳轉拿不到 Upwork 登入(SameSite/referrer),故 UI 一律「複製連結、自己貼」。
// id 優先用乾淨的 j.id(數字密文),退回從 url 抓 ~id。
function jobIdOf(j) {
  return (String(j.id || '').match(/[0-9a-f]{6,}/i) || [])[0]
      || (String(j.url || '').match(ID_RE) || [])[1] || '';
}
function cleanUrl(j) {
  const id = jobIdOf(j);
  if (!id) return j.url || '';
  return `https://www.upwork.com/jobs/~${id}`;
}

// 🤖 把一筆 job 整理成「CLI AI 友善」的精簡 JSON(/api/agent/read/* 用)。verdict 以 AI 為準。
function agentJobView(j) {
  const ev = effectiveVerdict(j);
  return {
    id: j.id,
    title: j.title,
    url: cleanUrl(j),
    verdict: ev.verdict,            // APPLY/MAYBE/SKIP(有 AI 分數就以 AI 為準)
    score: ev.isAi ? ev.score : (j.total_score != null ? Math.round(j.total_score / 10 * 10) / 10 : null),
    total_score: j.total_score,
    ai_score: j.ai_score,
    ai_win: j.ai_win,
    reason: j.reason,
    budget: j.budget_text,
    proposals: j.proposals_bucket,
    payment_verified: !!j.payment_verified,
    client: { spent: j.client_spent_text, hire_rate: j.client_hire_rate, rating: j.client_rating, jobs_posted: j.client_jobs_posted },
    experience_level: j.experience_level,
    connects_required: j.connects_required,
    posted_at: j.posted_at,
    tags: String(j.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    category: j.category,
    blocked: !!j.blocked,
    applied: !!j.applied,
    favorited: !!j.favorited
  };
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
    description: String(desc).slice(0, 8000), // 放寬:長描述的「To Apply/影片題」常在後段,別切掉
    posted_text: pick(raw, 'datePosted', 'posted', 'postedOn', 'publishedDate', 'createdAt') || null, // 原始相對字串(僅參考,會過期)
    posted_at: normalizePostedAt(raw), // 絕對時間戳(ISO)— 顯示一律用這個重算,才不會過期

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

// 從 ingest payload 取「發布絕對時間戳」(ISO)。優先用擴充功能算好的 postedAtIso / postedAtMs,
// 都沒有才從相對字串(Posted N minutes ago)以 scrapedAt(或現在)為錨點回推。
function normalizePostedAt(raw) {
  const iso = pick(raw, 'postedAtIso', 'postedAtISO', 'postedAtISOString');
  if (iso && !isNaN(Date.parse(iso))) return new Date(iso).toISOString();
  const ms = Number(pick(raw, 'postedAtMs', 'postedAtMS'));
  if (ms > 0) return new Date(ms).toISOString();
  const rel = pick(raw, 'datePosted', 'posted', 'postedOn');
  const anchorRaw = pick(raw, 'scrapedAt', 'scraped_at');
  const anchor = anchorRaw && !isNaN(Date.parse(anchorRaw)) ? new Date(anchorRaw).getTime() : Date.now();
  return parseRelativePosted(rel, anchor);
}

// 把「Posted 8 minutes ago / yesterday / 3 days ago」以錨點時間回推成 ISO
function parseRelativePosted(str, anchorMs) {
  if (!str) return null;
  const s = String(str).toLowerCase();
  if (/just now|seconds? ago|moments? ago/.test(s)) return new Date(anchorMs).toISOString();
  if (/yesterday/.test(s)) return new Date(anchorMs - 86400000).toISOString();
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2]];
  return new Date(anchorMs - n * unit).toISOString();
}

// 資料新鮮度:距 last_seen(最後一次抓到)多久。超過 3 小時 → 提案/競爭數據可能已過時。
function ageInfo(iso) {
  if (!iso || isNaN(Date.parse(iso))) return { text: '未知', stale: true };
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  const text = min < 60 ? `${min} 分鐘前` : min < 1440 ? `${Math.round(min / 60)} 小時前` : `${Math.round(min / 1440)} 天前`;
  return { text, stale: min >= 180 };
}

// 顯示用:把絕對時間戳依「現在」算成「X 前(台北時間 M/D HH:mm)」;沒有時退回原始字串
function formatPosted(job) {
  const iso = job.posted_at;
  if (!iso || isNaN(Date.parse(iso))) return job.posted_text || '未知';
  const t = new Date(iso).getTime();
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  const rel = min < 1 ? '剛剛' : min < 60 ? `${min} 分鐘前` : min < 1440 ? `${Math.round(min / 60)} 小時前` : `${Math.round(min / 1440)} 天前`;
  const abs = new Date(t).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${rel}(${abs})`;
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
  try {
    // ── 公開端點(免登入)──
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageLogin()); }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      try {
        const { identifier, password } = JSON.parse(await readBody(req));
        const { token } = await authLogin(identifier, password);
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': authCookie(req, token) });
        return res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message || '登入失敗' }));
      }
    }
    if (url.pathname === '/logout') {
      await authLogout(getCookie(req, 'auth'));
      res.writeHead(302, { Location: '/login', 'set-cookie': authCookie(req, '') });
      return res.end();
    }
    // /api/ingest 用 INGEST_KEY(擴充套件);其餘頁面/API 一律要登入(hdw-auth JWT cookie)
    // /api/refresh-job 帶正確 key 時(本機 gstack 腳本用)免 cookie 驗證,比照 ingest
    const refreshWithKey = url.pathname === '/api/refresh-job' && process.env.INGEST_KEY && url.searchParams.get('key') === process.env.INGEST_KEY;
    // 擴充功能也可以用 INGEST_KEY 直接 push invites(不用登入)
    const inviteIngestWithKey = url.pathname === '/api/invites/ingest' && req.method === 'POST' && process.env.INGEST_KEY && (url.searchParams.get('key') === process.env.INGEST_KEY || req.headers['x-ingest-key'] === process.env.INGEST_KEY);
    // 🤖 CLI AI 唯讀通道:/api/agent/read/* 帶正確 AGENT_KEY 免登入(只讀,不改任何東西)
    const agentRead = url.pathname.startsWith('/api/agent/read/') && req.method === 'GET'
      && process.env.AGENT_KEY && (url.searchParams.get('key') === process.env.AGENT_KEY || req.headers['x-agent-key'] === process.env.AGENT_KEY);
    if (url.pathname !== '/api/ingest' && !refreshWithKey && !inviteIngestWithKey && !agentRead) {
      const user = await requireAuth(req, res, url.pathname.startsWith('/api/'));
      if (!user) return;
    }

    // 🤖 CLI AI 唯讀通道(需 AGENT_KEY,只讀不改)。讓終端機的 AI agent 直接讀網站的案+評分。
    if (url.pathname === '/api/agent/read/summary') {
      const rows = db.prepare('SELECT * FROM jobs').all();
      const counts = {};
      for (const j of rows) { const v = effectiveVerdict(j).verdict; counts[v] = (counts[v] || 0) + 1; }
      const topApply = rows
        .filter((j) => effectiveVerdict(j).verdict === 'APPLY' && !j.applied && !j.blocked)
        .sort((a, b) => (b.ai_score ?? (b.total_score || 0) / 10) - (a.ai_score ?? (a.total_score || 0) / 10))
        .slice(0, 15).map(agentJobView);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, total: rows.length, counts, top_apply_unapplied: topApply }, null, 2));
    }
    if (url.pathname === '/api/agent/read/jobs') {
      const want = (url.searchParams.get('verdict') || '').toUpperCase();
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      let rows = db.prepare('SELECT * FROM jobs ORDER BY COALESCE(ai_score * 10, total_score) DESC, last_seen DESC').all();
      if (want) rows = rows.filter((j) => effectiveVerdict(j).verdict === want);
      if (url.searchParams.get('unapplied') === '1') rows = rows.filter((j) => !j.applied);
      if (url.searchParams.get('exclude_blocked') === '1') rows = rows.filter((j) => !j.blocked);
      const jobs = rows.slice(0, limit).map(agentJobView);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, count: jobs.length, jobs }, null, 2));
    }
    if (url.pathname === '/api/agent/read/job') {
      const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(url.searchParams.get('id'));
      if (!j) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"not found"}'); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, job: { ...agentJobView(j), description: j.description } }, null, 2));
    }

    if (url.pathname === '/api/mark') {
      markApplied(db, url.searchParams.get('id'), url.searchParams.get('applied') === '1');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/outcome') { // 學習迴路:記投標結果
      setOutcome(db, url.searchParams.get('id'), url.searchParams.get('outcome') || null);
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
      res.end(JSON.stringify({ ok: true, ingested: results.length, results }));
      // 先回應擴充套件,再「背景」對新進、還沒 AI 分數的案自動快篩(不阻塞 ingest)
      if (process.env.AI_TRIAGE_ON_INGEST !== '0') autoTriageIngested(results.map((r) => r.id));
      return;
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
    // 📌 Lessons CRUD
    if (url.pathname === '/api/lessons' && req.method === 'GET') {
      const dbi = openDb();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, lessons: listLessons(dbi, false) }));
    }
    if (url.pathname === '/api/lessons' && req.method === 'POST') {
      const { content, category } = JSON.parse(await readBody(req));
      if (!content || !String(content).trim()) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"content 不能空"}');
      }
      const dbi = openDb();
      addLesson(dbi, content, category || 'general');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (url.pathname === '/api/lessons/toggle' && req.method === 'POST') {
      const { id, enabled } = JSON.parse(await readBody(req));
      const dbi = openDb();
      setLessonEnabled(dbi, id, !!enabled);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/lessons/delete' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const dbi = openDb();
      deleteLesson(dbi, id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // 📊 Applications CRUD
    if (url.pathname === '/api/applications' && req.method === 'GET') {
      const dbi = openDb();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, applications: listApplications(dbi), stats: applicationStats(dbi) }));
    }
    if (url.pathname === '/api/applications' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const dbi = openDb();
      addApplication(dbi, body);
      // 同步把 jobs.applied = 1
      if (body.job_id) try { markApplied(dbi, body.job_id, 1); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/applications/update' && req.method === 'POST') {
      const { id, ...patch } = JSON.parse(await readBody(req));
      const dbi = openDb();
      updateApplication(dbi, id, patch);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // ⭐ Anchors CRUD
    if (url.pathname === '/api/anchors' && req.method === 'GET') {
      const dbi = openDb();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, anchors: listAnchors(dbi, false) }));
    }
    if (url.pathname === '/api/anchors' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.cover_letter || String(body.cover_letter).trim().length < 30) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"cover_letter 至少 30 字"}');
      }
      const dbi = openDb();
      addAnchor(dbi, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/anchors/toggle' && req.method === 'POST') {
      const { id, enabled } = JSON.parse(await readBody(req));
      const dbi = openDb();
      setAnchorEnabled(dbi, id, !!enabled);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/anchors/delete' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const dbi = openDb();
      deleteAnchor(dbi, id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // 🧠 從投案 notes 萃取 lesson 候選
    if (url.pathname === '/api/lessons/suggest' && req.method === 'POST') {
      const { notes } = JSON.parse(await readBody(req));
      const dbi = openDb();
      const existing = listLessons(dbi, false).map((l) => l.content);
      const result = await extractLessonCandidates(notes, existing);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, candidates: result.candidates || [] }));
    }
    // 💾 備份匯出 — 下載所有 lessons/anchors/applications 為 JSON
    if (url.pathname === '/api/backup/export' && req.method === 'GET') {
      const dbi = openDb();
      const data = {
        version: 1,
        exported_at: new Date().toISOString(),
        lessons: listLessons(dbi, false),
        anchors: listAnchors(dbi, false),
        applications: listApplications(dbi),
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="upworkfilter-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify(data, null, 2));
    }
    // 💾 還原備份(策略:append 不刪,避免覆蓋掉現有資料;用 ON CONFLICT 跳過重複)
    if (url.pathname === '/api/backup/restore' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const dbi = openDb();
      let added = { lessons: 0, anchors: 0, applications: 0 };
      try {
        for (const l of (body.lessons || [])) {
          addLesson(dbi, l.content, l.category || 'general'); added.lessons++;
        }
        for (const a of (body.anchors || [])) {
          if (a.cover_letter && a.cover_letter.length >= 30) {
            addAnchor(dbi, { job_title: a.job_title, cover_letter: a.cover_letter, note: a.note });
            added.anchors++;
          }
        }
        for (const ap of (body.applications || [])) {
          addApplication(dbi, ap); added.applications++;
        }
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message, added }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, added }));
    }
    // ❤️ 切換收藏狀態
    if (url.pathname === '/api/job/favorite' && req.method === 'POST') {
      const id = url.searchParams.get('id');
      const fav = url.searchParams.get('fav') === '1' ? 1 : 0;
      if (!id) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
      const dbi = openDb();
      dbi.prepare('UPDATE jobs SET favorited=? WHERE id=?').run(fav, id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // 🔒 標為私案 / 已關閉 — 點進去發現 Access denied 直接 SKIP
    if (url.pathname === '/api/job/mark-private' && req.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"缺 id"}'); }
      const dbi = openDb();
      dbi.prepare("UPDATE jobs SET verdict='SKIP', reason='🔒 私案/已關閉 — Access denied', blocked=1, ai_verdict='略過 — 私案/已關閉' WHERE id=?").run(id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    // 🔄 從 jobs.applied=1 匯入 — 把列表頁勾過「已投」但 applications 表還沒紀錄的案子補上
    if (url.pathname === '/api/applications/import-applied' && req.method === 'POST') {
      const dbi = openDb();
      const applied = dbi.prepare('SELECT * FROM jobs WHERE applied=1').all();
      const existing = new Set(dbi.prepare('SELECT job_id FROM applications WHERE job_id IS NOT NULL').all().map((r) => r.job_id));
      let added = 0;
      for (const j of applied) {
        if (existing.has(j.id)) continue;
        addApplication(dbi, {
          job_id: j.id,
          job_title: j.title || '',
          applied_at: j.last_seen || new Date().toISOString(),
          rate: j.budget_text || '',
          connects_used: 0,
          notes: '從列表頁「已投」匯入',
        });
        added++;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, added, skipped: applied.length - added }));
    }
    if (url.pathname === '/api/applications/delete' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const dbi = openDb();
      deleteApplication(dbi, id);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/cover-letter' && req.method === 'POST') {
      const { id, descOverride } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      if (descOverride && descOverride.trim()) job.description = descOverride.slice(0, 8000); // 用使用者貼的完整描述
      const prof = loadProfileWithLessons();
      // 🤝 多 agent 合議:
      // mode=single → 單 prompt 快版
      // mode=ensemble(預設) → 3 writer + 1 總編
      // mode=consensus → 3 個 provider(claude/openai/gemini)各自跑完整 ensemble,共識比對
      const mode = url.searchParams.get('mode') || 'ensemble';
      let text = '';
      let consensus = null;
      if (mode === 'single') {
        text = await askAI(coverLetterPrompt(job, prof));
      } else if (mode === 'consensus') {
        // 3 個 provider 平行各自跑單版 cover letter,差異越大 = 越不確定 = 風險
        const providers = ['claude', 'openai', 'gemini'];
        const results = await Promise.allSettled(providers.map(p => askAI(coverLetterPrompt(job, prof), { provider: p })));
        const outputs = results.map((r, i) => ({ provider: providers[i], text: r.status === 'fulfilled' ? r.value.trim() : `(${providers[i]} 失敗)`, ok: r.status === 'fulfilled' }));
        // 預設用 claude 版做主稿,其他 2 個當共識參考
        text = outputs.find(o => o.provider === 'claude' && o.ok)?.text || outputs.find(o => o.ok)?.text || '';
        consensus = { outputs };
      } else {
        // 3 個 writer 平行(失敗的不算)
        const [a, b, c] = await Promise.allSettled([
          askAI(coverLetterWriterA(job, prof)),
          askAI(coverLetterWriterB(job, prof)),
          askAI(coverLetterWriterC(job, prof)),
        ]);
        const drafts = {
          a: a.status === 'fulfilled' ? a.value : '',
          b: b.status === 'fulfilled' ? b.value : '',
          c: c.status === 'fulfilled' ? c.value : '',
        };
        const okCount = [drafts.a, drafts.b, drafts.c].filter(Boolean).length;
        if (okCount === 0) {
          // 全 fail 退回單 prompt
          text = await askAI(coverLetterPrompt(job, prof));
        } else if (okCount === 1) {
          // 只 1 個成功直接用,不用合成
          text = drafts.a || drafts.b || drafts.c;
        } else {
          // 合成
          try {
            text = await askAI(coverLetterSynthPrompt(drafts, job, prof));
          } catch (e) {
            console.error('合成失敗,用 Writer C(JD 鏡像):' + e.message);
            text = drafts.c || drafts.a || drafts.b;
          }
        }
      }
      const finalText = String(text || '').trim();
      // 🔍 verify + ⑥ citations + ⑩ skeptic + ② preflight 四路平行
      // 共識模式 / 跳過驗證模式 → 跳掉(避免 10 個 AI call 並發爆 nginx timeout)
      let verify = null, citations = null, skeptic = null, preflight = null;
      const skipVerify = url.searchParams.get('skipverify') === '1' || mode === 'consensus';
      if (!skipVerify) {
        const [verifyR, citeR, skR, pfR] = await Promise.allSettled([
          detectHallucinations(finalText, prof),
          annotateCitations(finalText, prof),
          skepticCritique(finalText, job, prof),
          preflightCheck(finalText, prof, prof.lessons || [], job),
        ]);
        verify = verifyR.status === 'fulfilled' ? verifyR.value : null;
        citations = citeR.status === 'fulfilled' ? citeR.value : null;
        skeptic = skR.status === 'fulfilled' ? skR.value : null;
        preflight = pfR.status === 'fulfilled' ? pfR.value : null;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, text: finalText, verify, citations, skeptic, preflight, consensus }));
    }
    if (url.pathname === '/api/verify-cover' && req.method === 'POST') {
      // 🔍 背景驗證:cover letter 主流程(skipverify)先回草稿,前端再單獨補跑這 4 路驗證,
      // 避免一次同步等 ~5 分鐘(writers+synth ~110s,這裡 verify 另算 ~180s)。
      const { id, text } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      const finalText = String(text || '').trim();
      if (!finalText) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"缺少求職信內容"}'); }
      const prof = loadProfileWithLessons();
      const [verifyR, citeR, skR, pfR] = await Promise.allSettled([
        detectHallucinations(finalText, prof),
        annotateCitations(finalText, prof),
        skepticCritique(finalText, job, prof),
        preflightCheck(finalText, prof, prof.lessons || [], job),
      ]);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        verify: verifyR.status === 'fulfilled' ? verifyR.value : null,
        citations: citeR.status === 'fulfilled' ? citeR.value : null,
        skeptic: skR.status === 'fulfilled' ? skR.value : null,
        preflight: pfR.status === 'fulfilled' ? pfR.value : null,
      }));
    }
    if (url.pathname === '/api/advice' && req.method === 'POST') {
      const { id, descOverride } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      if (descOverride && descOverride.trim()) job.description = descOverride.slice(0, 8000); // 用使用者貼的完整描述 → 抓影片題/指定專案
      const data = extractJson(await askAI(advicePrompt(job, loadProfileWithLessons())));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === '/api/refresh-job' && req.method === 'POST') {
      // 🔄 即時重抓單案會變動的數據(提案/面試/客戶),合併後重算。
      // live 由本機 gstack 腳本帶入;沒帶 live(網站按鈕)→ 試 API,沒 API 則回 needLocal。
      const { id, live } = JSON.parse(await readBody(req));
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!row) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      let fresh = live && Object.keys(live).length ? live : null;
      if (!fresh) {
        // TODO(API 啟用後):用官方 API detail 抓即時 totalApplicants。目前 API 未過 → 引導本機重抓。
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, needLocal: true, msg: `雲端目前無法直接抓即時數據(需官方 API 或本機 gstack)。請在本機跑:npm run refresh -- ${id}` }));
      }
      const job = { ...row, payment_verified: !!row.payment_verified, enriched: !!row.enriched };
      for (const k of ['proposals_bucket', 'client_hire_rate', 'client_rating', 'client_reviews', 'client_jobs_posted', 'client_spent_text', 'client_spent_usd', 'posted_at', 'experience_level', 'connects_required']) {
        if (live[k] != null && live[k] !== '') job[k] = live[k];
      }
      Object.assign(job, scoreJob(job, loadConfig()));
      upsertJob(db, job); // last_seen 自動更新 → 資料新鮮度重置
      // 重抓後補跑該案 AI 快篩,讓 AI 分數/勝率也吃到最新競爭(blocked 的不浪費 AI)
      let aiScore = null, aiWin = null;
      if (!job.blocked) {
        try {
          const fresh = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
          const { triageJobs } = await import('./triage.js');
          const r = (await triageJobs([fresh], { outcomeNote: outcomeNoteText(computeOutcomeStats()) }))[0];
          if (r) { setAiVerdict(db, id, r.score, r.reason ? `${r.verdict} - ${r.reason}` : r.verdict, r.win, r.tags, r.parent); aiScore = r.score; aiWin = r.win; }
        } catch (e) { console.error('refresh 後快篩失敗:' + e.message); }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, verdict: job.verdict, competition: job.scores?.competition, proposals_bucket: job.proposals_bucket, blocked: job.blocked, ai_score: aiScore, ai_win: aiWin }));
    }
    if (url.pathname === '/api/screening' && req.method === 'POST') {
      // 🎯 篩選問題作戰區:抽 screening questions → 逐題答案 + 硬門檻判斷要不要投
      const { id, descOverride } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      if (descOverride && descOverride.trim()) job.description = descOverride.slice(0, 8000);
      const data = extractJson(await askAI(screeningPrompt(job, loadProfileWithLessons())));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const { messages, context } = JSON.parse(await readBody(req));
      // 省 token:只送最近 10 則對話 + 前 15 筆案件當上下文
      const recentMsgs = (messages || []).slice(-10);
      const jobs = db.prepare(`SELECT id,title,budget_text,proposals_bucket,total_score,verdict,ai_score,ai_verdict FROM jobs
        ORDER BY COALESCE(ai_score*10, total_score) DESC LIMIT 15`).all();
      // 知道使用者此刻在哪個頁面、看哪個案 → 讓 agent 針對情境回答
      let note = '';
      if (context && context.page) note += `頁面:${context.page}。`;
      if (context && context.jobId) {
        const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(context.jobId);
        if (j) {
          const ev = effectiveVerdict(j);
          note += `\n目前正在看這個案:「${j.title}」 | 評分 ${ev.isAi ? ev.score + '/10 ' + ev.verdict : ev.score + '/100 ' + ev.verdict} | 預算 ${j.budget_text || '?'} | 提案 ${j.proposals_bucket || '?'} | 客戶花費 ${j.client_spent_text || '?'}\n描述:${String(j.description || '').slice(0, 1200)}`;
        }
      }
      // Agents 中控台的聊天:額外帶入評分設定、第一道門關鍵字、投標實績校正(能力邊界已在 profile 裡)
      if (context && context.scope === 'agents') {
        const cfg = loadConfig(); const pp = loadProfile();
        note += `\n\n【Agents 設定與學到的東西】\n` +
          `評分模式:${cfg.scoring.mode};APPLY 門檻≥${cfg.scoring.threshold}、MAYBE≥${cfg.scoring.maybeThreshold}\n` +
          `第一道門搜尋關鍵字:${(pp.capability?.searchKeywords || []).join(', ') || '(未設)'}\n` +
          (outcomeNoteText(computeOutcomeStats()) || '投標實績:樣本不足(<5),還沒學到校正資料');
      }
      // 🛠️ Tool-use ReAct loop:AI 可呼叫工具,執行後丟回去讓它寫人話答覆
      const { TOOL_DOCS, executeTool, extractToolCalls, stripToolTags } = await import('./tools.js');
      const prof = loadProfileWithLessons();
      let firstReply = await askAI(chatPrompt(recentMsgs, prof, jobs, note, TOOL_DOCS));
      const calls = extractToolCalls(firstReply);
      if (calls.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, reply: stripToolTags(firstReply) }));
      }
      // 執行(最多 5 個,防失控)
      const results = [];
      for (const c of calls.slice(0, 5)) {
        const r = executeTool(db, c);
        results.push({ tool: c.name, args: c.args, result: r });
      }
      // 把結果丟回給 AI 寫最終答覆
      const followUp = [
        ...recentMsgs,
        { role: 'assistant', content: stripToolTags(firstReply) },
        { role: 'user', content: `【tool 執行結果】\n${JSON.stringify(results, null, 2).slice(0, 4000)}\n\n用人話總結結果給使用者,不要印 raw JSON,不要再呼叫工具。` },
      ];
      const finalReply = await askAI(chatPrompt(followUp, prof, jobs, note, ''));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reply: stripToolTags(finalReply), toolCalls: results }));
    }
    if (url.pathname === '/api/reply' && req.method === 'POST') {
      const { message, id, tone } = JSON.parse(await readBody(req));
      const job = id ? db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) : null;
      const data = extractJson(await askAI(replyPrompt(message, job, loadProfileWithLessons(), tone)));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      saveProfile(body);
      // 第一道門:把能力頁的搜尋關鍵字同步寫進 config.searchQueries(本專案 scraper/api-fetch 也用)
      try {
        const kws = (body.capability?.searchKeywords || []).filter(Boolean);
        if (kws.length) {
          const cfg = loadConfigRaw(); delete cfg.provenTechs; delete cfg.capability;
          cfg.searchQueries = [kws.join(' OR ')];
          writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
        }
      } catch (e) { console.error('同步 searchQueries 失敗:' + e.message); }
      rescoreAll(); // 能力(capability)會影響評分,存檔後重算所有案
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
      delete cfg.provenTechs; delete cfg.capability; // 不要把衍生欄位寫進檔案
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
      rescoreAll();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
      if (!job) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此案"}'); }
      // 第二道門擋下的案不建議花錢做 AI 大分析(?force=1 可強制)
      if (job.blocked && url.searchParams.get('force') !== '1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, blocked: true, error: '此案被第二道門擋下(紅線/能力圈外),不建議花 AI 分析。如確定要分析,加 ?force=1。' }));
      }
      const r = await analyzeJob(job); // 抓取(雲端用 DB 描述)+ ProxyCLI AI + 產 HTML
      // 以 AI 判斷為準:把 AI 的總分/verdict 存進 DB,卡片/評估頁優先顯示
      if (r.totalScore != null) setAiVerdict(db, id, Number(r.totalScore), r.verdict);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r));
    }
    if (url.pathname === '/api/triage' && req.method === 'POST') {
      // AI 快篩:便宜模型批次粗評,重排序。預設只篩「還沒 AI 分數」的案;?all=1 重篩全部。
      const body = JSON.parse((await readBody(req)) || '{}');
      // 第二道門擋下的案(blocked=1)不浪費 AI 快篩
      const rows = body.all
        ? db.prepare('SELECT * FROM jobs WHERE blocked=0').all()
        : db.prepare('SELECT * FROM jobs WHERE ai_score IS NULL AND blocked=0').all();
      if (rows.length === 0) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"ok":true,"triaged":0,"msg":"沒有待快篩的案"}');
      }
      const { triageJobs } = await import('./triage.js');
      const results = await triageJobs(rows, { outcomeNote: outcomeNoteText(computeOutcomeStats()) });
      for (const r of results) setAiVerdict(db, r.id, r.score, r.reason ? `${r.verdict} - ${r.reason}` : r.verdict, r.win, r.tags, r.parent);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, triaged: results.length, candidates: rows.length }));
    }
    if (url.pathname === '/analysis') { // 提供已產生的 AI 詳細分析 HTML(評估頁 iframe 內嵌)
      const aid = (url.searchParams.get('id') || '').replace(/[^\w-]/g, '');
      const f = path.join(__dirname, '..', `upwork-${aid}-analysis.html`);
      if (!aid || !existsSync(f)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('尚未產生 AI 詳細分析。');
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(f, 'utf8'));
    }
    if (url.pathname === '/job') { // ② 評估(判斷 + AI 詳細分析)
      return serveHtml(res, pageJob((url.searchParams.get('id') || '').replace(/[^\w-]/g, '')));
    }
    if (url.pathname === '/proposal') { // ③ 提案(生產)
      return serveHtml(res, pageProposal((url.searchParams.get('id') || '').replace(/[^\w-]/g, '')));
    }
    if (url.pathname === '/profile') {
      return serveHtml(res, pageProfile());
    }
    if (url.pathname === '/me') {
      return serveHtml(res, pageMe());
    }
    if (url.pathname === '/agents') {
      return serveHtml(res, pageAgents());
    }
    if (url.pathname === '/lessons') {
      return serveHtml(res, pageLessons());
    }
    if (url.pathname === '/applications') {
      return serveHtml(res, pageApplications());
    }
    if (url.pathname === '/anchors') {
      return serveHtml(res, pageAnchors());
    }
    if (url.pathname === '/today') {
      return serveHtml(res, pageToday());
    }
    if (url.pathname === '/backup') {
      return serveHtml(res, pageBackup());
    }
    if (url.pathname === '/scoring' || url.pathname === '/settings' || url.pathname === '/setup') {
      return serveHtml(res, pageScoring()); // /settings、/setup 舊路由導向(back-compat)
    }
    if (url.pathname === '/reply') {
      return serveHtml(res, pageReply());
    }
    // ⑤ 邀請 — 列表頁、單筆頁
    if (url.pathname === '/invites') {
      return serveHtml(res, pageInvites());
    }
    if (url.pathname === '/invite') {
      return serveHtml(res, pageInvite((url.searchParams.get('id') || '').replace(/[^\w-]/g, '')));
    }
    // 手動新增邀請(登入用戶用 /invites 頁的表單)
    if (url.pathname === '/api/invites/ingest' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.raw_text || !String(body.raw_text).trim()) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"ok":false,"error":"raw_text 必填"}');
      }
      // 若沒給 id,從原文+標題雜湊一個短 id(避免重複貼相同邀請)
      const idIn = body.id || ('inv-' + Buffer.from(String(body.title || '') + '|' + String(body.raw_text).slice(0, 200)).toString('base64url').slice(0, 20));
      const usd = body.client_spent_text ? parseSpentUsd(body.client_spent_text) : null;
      upsertInvite(db, {
        id: idIn,
        title: body.title || null,
        url: body.url || null,
        job_id: body.job_id || null,
        received_at: body.received_at || new Date().toISOString(),
        received_text: body.received_text || null,
        client_spent_text: body.client_spent_text || null,
        client_spent_usd: usd,
        client_hires: body.client_hires ?? null,
        client_payment_verified: body.client_payment_verified,
        client_invites_sent: body.client_invites_sent ?? null,
        raw_text: body.raw_text,
        status: 'new'
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: idIn }));
    }
    // 對單筆邀請跑 AI 三層評判
    if (url.pathname === '/api/invites/analyze' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const inv = getInvite(db, id);
      if (!inv) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"找不到此邀請"}'); }
      const raw = await askAI(invitePrompt(inv, loadProfile()));
      const data = extractJson(raw);
      if (!data || typeof data !== 'object') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'AI 回傳格式有問題', raw }));
      }
      setInviteAi(db, id, Number(data.score) || null, data.recommendation || null, data.recommendation || null, JSON.stringify(data));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, data }));
    }
    // Archive 一筆邀請(從列表隱藏,但保留資料)
    if (url.pathname === '/api/invites/archive' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const ok = setInviteStatus(db, id, 'archived');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    }
    if (url.pathname === '/assistant') {
      return serveHtml(res, pageAssistant());
    }
    if (url.pathname === '/features') {
      return serveHtml(res, pageFeatures());
    }
    if (url.pathname === '/api/scan-features' && req.method === 'POST') {
      const { queries } = JSON.parse(await readBody(req));
      const list = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q || '').trim()).filter(Boolean);
      if (!list.length) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"請提供關鍵字"}'); }
      if (_scanBusy) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"已有掃描在進行中,請等它完成"}'); }
      // 背景掃描(多關鍵字會跑很久,同步會 nginx 超時 → 立即回應、背景跑、完成後重整看結果)
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, started: true, queries: list.length }));
      _scanBusy = true;
      import('./scan-features.js')
        .then(({ scanFeatures }) => scanFeatures(list))
        .then(() => console.log(`🧩 功能掃描完成:${list.join(', ')}`))
        .catch((e) => console.error('功能掃描失敗:' + e.message))
        .finally(() => { _scanBusy = false; });
      return;
    }
    return serveHtml(res, pageJobs());
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}).listen(PORT, HOST, () => {
  console.log(`\n🌐 網頁:http://${HOST}:${PORT}   (① 列表 / ② 評估 / ③ 提案 / ④ 溝通 / ⑤ 邀請 ｜ 檔案 · 評分)`);
  console.log(`   登入:${NO_AUTH ? 'OFF(NO_AUTH)' : 'hdw-auth ' + AUTH_URL} | ingest 金鑰:${process.env.INGEST_KEY ? 'ON' : 'OFF'}\n   Ctrl+C 關閉。\n`);
});
