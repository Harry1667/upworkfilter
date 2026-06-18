// SQLite 資料層 — 使用 Node 25 內建的 node:sqlite(免裝原生套件)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'jobs.db');

const SCORE_COLS = ['score_reward', 'score_skill', 'score_client', 'score_competition', 'score_longterm', 'score_clarity', 'score_risk'];

// 🤝 協商手冊種子 — 萃自 Move On Removals 案(2026-06,$450 全額、漂亮收尾)的實戰句型。
// 首次建表時注入,之後使用者可自行增刪;phrasing 是客戶回覆用的英文,note 是繁中判斷。
const NEGOTIATION_SEED = [
  {
    situation: '一堆功能塞進低價 milestone',
    note: '把「多功能=多個獨立軟體」講死,擋住壓價',
    phrasing: `Let me be clear so we don't set the wrong expectation: $X can't cover a production-ready version of all of these. They're separate modules — built properly, each is its own piece of software. The honest path is one feature done properly now, the rest scoped and quoted on their own later.`,
  },
  {
    situation: '開工前鎖範圍(每個 milestone 必做)',
    note: '白紙黑字鎖範圍=全身而退的護身符,最後凹免費時靠它',
    phrasing: `In scope — these items only: [list]. Not in scope for this milestone (separate, properly budgeted later): [list]. When these are done, the milestone is complete. Could you confirm you're happy with this scope?`,
  },
  {
    situation: '客戶用模糊形容詞要你猜(intuitive/像舊系統)',
    note: '把不可交付的「感覺」逼成具體參照;拿不出=問題在他期望',
    phrasing: `I understand the feeling, but words like 'intuitive' and 'effortless' aren't instructions I can build from. Send me 2–3 screenshots or a short recording of the exact screens your team uses most, so I can match the target instead of guessing at adjectives.`,
  },
  {
    situation: '你自己改出副作用 / bug',
    note: '免費修你弄壞那塊買回信任,同時守住新功能要收費',
    phrasing: `Honest breakdown: (1) root cause — this predates my milestone; (2) where my change made it worse — that side effect I'll fix for free; (3) what's genuinely new — true [feature] never existed and is a new, paid feature.`,
  },
  {
    situation: '客戶想凹免費重做已交付/已付款的工作',
    note: '把爭論從感覺拉回白紙黑字的記錄;事實不可辯駁',
    phrasing: `Every milestone was written down, agreed, approved and paid by you before release — it's all in our message history. What you're describing now is a separate project I never quoted and you never paid for. I'll happily do it as its own milestone, scoped and priced separately.`,
  },
  {
    situation: '客戶貶低你的貢獻(說大部分他自己設計)',
    note: '不卑不亢分開「出主意」與「工程化」;承認他也不讓他抹掉你',
    phrasing: `You defined the requirements — that's your job, and you did it well. I engineered them into a working system — that's the job you hired me for and approved at every step. Telling me what you want and building it are two different things.`,
  },
  {
    situation: '⭐同一不滿重複出現(第2-3次)→ 早攤牌',
    note: '重複抱怨=隱性驗收標準=期望/預算鴻溝;早攤牌保護雙方,別逐項拖到爆',
    phrasing: `I'm hearing the same thing again, so let me be direct rather than open another milestone. What you're describing is a full redesign — a project worth $X over a longer timeline that can't fit this budget. Let's decide that openly now, instead of going milestone by milestone while the gap quietly grows.`,
  },
  {
    situation: '收尾(客戶結案或你決定退出)',
    note: '不爭最後一口氣;大方收尾保住評價、名聲、氣度(互惠才是要好評最有效的方式)',
    phrasing: `I respect the decision. It's been a genuine pleasure — the foundation and improvements are all live and yours to build on. You've got a clear vision and deserve someone who matches it exactly. No hard feelings; my door's open if you ever want help down the track. All the best.`,
  },
];

export function openDb() {
  const db = new DatabaseSync(DB_PATH);
  // 並發處理:WAL 允許「多讀 + 單寫」,busy_timeout 讓連線遇到鎖時等待而非直接報錯
  // (修「database is locked」:web 進程與快篩/重算腳本同時存取 jobs.db)
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* ignore */ }
  try { db.exec('PRAGMA busy_timeout = 8000'); } catch { /* ignore */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id                TEXT PRIMARY KEY,
      title             TEXT,
      url               TEXT,
      posted_text       TEXT,
      budget_type       TEXT,
      budget_text       TEXT,
      hourly_min        REAL,
      hourly_max        REAL,
      fixed_budget      REAL,
      proposals_bucket  TEXT,
      payment_verified  INTEGER,
      client_spent_text TEXT,
      client_spent_usd  REAL,
      client_hire_rate  INTEGER,
      client_rating     REAL,
      client_reviews    INTEGER,
      client_jobs_posted INTEGER,
      description       TEXT,
      matched_skills    TEXT,
      score_reward      INTEGER,
      score_skill       INTEGER,
      score_client      INTEGER,
      score_competition INTEGER,
      score_longterm    INTEGER,
      score_clarity     INTEGER,
      score_risk        INTEGER,
      total_score       INTEGER,
      verdict           TEXT,
      reason            TEXT,
      ai_score          REAL,
      ai_verdict        TEXT,
      enriched          INTEGER DEFAULT 0,
      applied           INTEGER DEFAULT 0,
      first_seen        TEXT,
      last_seen         TEXT
    );
  `);
  // 遷移:舊資料庫補上缺少的欄位(忽略已存在的錯誤)
  for (const col of [...SCORE_COLS]) {
    try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col} INTEGER`); } catch { /* 已存在 */ }
  }
  // AI 判斷(0-10 + verdict + 中標機率),產生分析/快篩後寫入;規則重算不會覆蓋
  try { db.exec('ALTER TABLE jobs ADD COLUMN ai_score REAL'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN ai_verdict TEXT'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN ai_win INTEGER'); } catch { /* 已存在 */ }
  // 分類標籤(來自功能地圖):category=母類別(大類,1個)、tags=子功能(小類,逗號分隔)
  try { db.exec('ALTER TABLE jobs ADD COLUMN category TEXT'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN tags TEXT'); } catch { /* 已存在 */ }
  // 學習迴路:投標結果(applied→ 已回/面試/錄取/未回),供日後校正評分
  try { db.exec('ALTER TABLE jobs ADD COLUMN outcome TEXT'); } catch { /* 已存在 */ }
  // 🚪 第二道門(能力)硬攔截旗標:1=紅線/能力圈外被擋,AI 快篩/分析會跳過(省成本)
  try { db.exec('ALTER TABLE jobs ADD COLUMN blocked INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
  // 🗑️ 使用者 skip 掉的案:記 id(墓碑),刪掉 jobs 列 + 之後重抓不再寫回(見 upsertJob 守門)
  try { db.exec('CREATE TABLE IF NOT EXISTS dismissed_jobs (id TEXT PRIMARY KEY, ts TEXT)'); } catch { /* 已存在 */ }
  // 發布時間「絕對時間戳」(ISO):擴充功能算好的 postedAtIso。posted_text 是會過期的相對字串,顯示一律用這個重算。
  try { db.exec('ALTER TABLE jobs ADD COLUMN posted_at TEXT'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN favorited INTEGER DEFAULT 0'); } catch { /* 已存在 */ }
  // 🥊 新手競爭可行性訊號(can-win,非客戶品質):詳情頁抓得到才填,沒抓到=null(不誤判)
  // experience_level=Upwork 經驗等級(Entry/Intermediate/Expert);connects_required=投這案要幾個 Connects(超熱門度)
  try { db.exec('ALTER TABLE jobs ADD COLUMN experience_level TEXT'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN connects_required INTEGER'); } catch { /* 已存在 */ }

  // ── ⑤ 邀請(Invites from clients)— 客戶主動邀請,跟 jobs 分開存(欄位、流程都不同) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id                TEXT PRIMARY KEY,
      title             TEXT,
      url               TEXT,
      job_id            TEXT,
      received_at       TEXT,
      received_text     TEXT,
      client_spent_text TEXT,
      client_spent_usd  REAL,
      client_hires      INTEGER,
      client_payment_verified INTEGER,
      client_invites_sent INTEGER,
      raw_text          TEXT,
      ai_score          REAL,
      ai_verdict        TEXT,
      ai_recommendation TEXT,
      ai_analysis_json  TEXT,
      status            TEXT DEFAULT 'new',
      first_seen        TEXT,
      last_seen         TEXT
    );
  `);

  // ── ⑧ Anchors(已驗證 cover letter 範本)— Few-shot 注入,確保 AI 不偏離你的 voice ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS anchors (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      job_title    TEXT,
      cover_letter TEXT,
      note         TEXT,
      created_at   TEXT,
      enabled      INTEGER DEFAULT 1
    );
  `);

  // ── 案件追蹤(applications)— 投案後狀態追蹤、回應率學習 ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          TEXT,
      job_title       TEXT,
      applied_at      TEXT,
      cover_letter    TEXT,
      rate            TEXT,
      connects_used   INTEGER DEFAULT 0,
      boost_connects  INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'sent',
      status_updated_at TEXT,
      response_at     TEXT,
      hired_at        TEXT,
      lessons_learned TEXT,
      notes           TEXT
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_app_job ON applications(job_id)'); } catch {}

  // ── ④ Lessons(學習日誌)— 使用者抓到 AI 錯就存,自動注入未來 prompt ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      content      TEXT NOT NULL,
      category     TEXT,
      created_at   TEXT,
      enabled      INTEGER DEFAULT 1,
      hit_count    INTEGER DEFAULT 0
    );
  `);

  // ── 🌱 經驗存摺(track_record)— 做完的項目 = Upwork 實戰戰績。
  //    跟 applications(投案漏斗)不同:這記「已交付完成」的案,回填當 proven 證據注入提案 AI。
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_record (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,      -- 項目名稱
      client          TEXT,               -- 客戶/平台名
      skills          TEXT,               -- 證明了哪些技能(逗號分隔)
      summary         TEXT,               -- 一句話:做了什麼(會注入提案 AI)
      rating          REAL,               -- 客戶評價星數 0-5
      review_text     TEXT,               -- 客戶評語原文
      earned_usd      REAL,               -- 賺多少 USD
      hours           REAL,               -- 花多少時數
      deliverable_url TEXT,               -- 成品/repo 連結
      source          TEXT DEFAULT 'upwork', -- 來源平台(upwork/外部)
      app_id          INTEGER,            -- 若由 applications 標記完成而來,記原 id
      completed_at    TEXT,               -- 完成日期
      notes           TEXT,
      created_at      TEXT,
      enabled         INTEGER DEFAULT 1   -- 0 = 暫不注入提案(保留紀錄)
    );
  `);

  // ── 🤝 協商手冊(negotiation_playbooks)— 守範圍/議價/範圍變動的實戰句型,只注入 replyPrompt ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS negotiation_playbooks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      situation    TEXT NOT NULL,   -- 情境標籤
      phrasing     TEXT NOT NULL,   -- 久經驗證的英文措辭(客戶回覆用)
      note         TEXT,            -- 何時用 / 為什麼有效(繁中)
      created_at   TEXT,
      enabled      INTEGER DEFAULT 1,
      hit_count    INTEGER DEFAULT 0
    );
  `);
  // 首次建立時 seed 八條;已有資料(含使用者後來新增/刪除)就不再動,避免覆蓋
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM negotiation_playbooks').get().n;
    if (!n) {
      const now = new Date().toISOString();
      const seed = db.prepare('INSERT INTO negotiation_playbooks (situation, phrasing, note, created_at) VALUES (?, ?, ?, ?)');
      for (const pb of NEGOTIATION_SEED) seed.run(pb.situation, pb.phrasing, pb.note, now);
    }
  } catch { /* ignore */ }

  return db;
}

// ── lessons helpers ──
export function addLesson(db, content, category = 'general') {
  return db.prepare('INSERT INTO lessons (content, category, created_at) VALUES (?, ?, ?)').run(
    String(content || '').trim().slice(0, 500),
    category,
    new Date().toISOString(),
  );
}
export function listLessons(db, onlyEnabled = false) {
  const q = onlyEnabled ? 'SELECT * FROM lessons WHERE enabled=1 ORDER BY id DESC' : 'SELECT * FROM lessons ORDER BY id DESC';
  return db.prepare(q).all();
}
export function setLessonEnabled(db, id, enabled) {
  db.prepare('UPDATE lessons SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
}
export function deleteLesson(db, id) {
  db.prepare('DELETE FROM lessons WHERE id=?').run(id);
}
// ── 🤝 negotiation_playbooks helpers(協商手冊)──
export function addNegotiationPlay(db, pb) {
  return db.prepare('INSERT INTO negotiation_playbooks (situation, phrasing, note, created_at) VALUES (?, ?, ?, ?)').run(
    String(pb.situation || '').trim().slice(0, 200),
    String(pb.phrasing || '').trim().slice(0, 1500),
    String(pb.note || '').trim().slice(0, 500),
    new Date().toISOString(),
  );
}
export function listNegotiationPlays(db, onlyEnabled = false) {
  // ASC:讓 seed 的 8 條照邏輯順序(投案→鎖範圍→…→收尾)出現
  const q = onlyEnabled ? 'SELECT * FROM negotiation_playbooks WHERE enabled=1 ORDER BY id ASC' : 'SELECT * FROM negotiation_playbooks ORDER BY id ASC';
  return db.prepare(q).all();
}
export function setNegotiationPlayEnabled(db, id, enabled) {
  db.prepare('UPDATE negotiation_playbooks SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
}
export function deleteNegotiationPlay(db, id) {
  db.prepare('DELETE FROM negotiation_playbooks WHERE id=?').run(id);
}
// ── anchors helpers ──
export function addAnchor(db, a) {
  return db.prepare('INSERT INTO anchors (job_title, cover_letter, note, created_at) VALUES (?, ?, ?, ?)').run(
    a.job_title || '',
    String(a.cover_letter || '').slice(0, 5000),
    a.note || '',
    new Date().toISOString(),
  );
}
export function listAnchors(db, onlyEnabled = false) {
  const q = onlyEnabled ? 'SELECT * FROM anchors WHERE enabled=1 ORDER BY id DESC' : 'SELECT * FROM anchors ORDER BY id DESC';
  return db.prepare(q).all();
}
export function setAnchorEnabled(db, id, enabled) {
  db.prepare('UPDATE anchors SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
}
export function deleteAnchor(db, id) {
  db.prepare('DELETE FROM anchors WHERE id=?').run(id);
}

// ── applications helpers ──
export function addApplication(db, a) {
  const now = new Date().toISOString();
  return db.prepare(`INSERT INTO applications
    (job_id, job_title, applied_at, cover_letter, rate, connects_used, boost_connects, status, status_updated_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?)`).run(
    a.job_id || null,
    a.job_title || '',
    a.applied_at || now,
    a.cover_letter || '',
    a.rate || '',
    a.connects_used || 0,
    a.boost_connects || 0,
    now,
    a.notes || '',
  );
}
export function listApplications(db) {
  return db.prepare('SELECT * FROM applications ORDER BY applied_at DESC').all();
}
export function getApplication(db, id) {
  return db.prepare('SELECT * FROM applications WHERE id=?').get(id);
}
export function updateApplication(db, id, patch) {
  const now = new Date().toISOString();
  const fields = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (['status', 'response_at', 'hired_at', 'lessons_learned', 'notes', 'rate'].includes(k)) {
      fields.push(`${k}=?`);
      vals.push(v);
    }
  }
  if (patch.status) {
    fields.push('status_updated_at=?');
    vals.push(now);
    // 自動補 response_at / hired_at
    if (['replied', 'interview', 'hired'].includes(patch.status) && !patch.response_at) {
      const cur = getApplication(db, id);
      if (cur && !cur.response_at) {
        fields.push('response_at=?'); vals.push(now);
      }
    }
    if (patch.status === 'hired' && !patch.hired_at) {
      fields.push('hired_at=?'); vals.push(now);
    }
  }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE applications SET ${fields.join(', ')} WHERE id=?`).run(...vals);
}
export function deleteApplication(db, id) {
  db.prepare('DELETE FROM applications WHERE id=?').run(id);
}
export function applicationStats(db) {
  const rows = db.prepare('SELECT status, COUNT(*) as n FROM applications GROUP BY status').all();
  const total = db.prepare('SELECT COUNT(*) as n FROM applications').get().n || 0;
  const by = {};
  for (const r of rows) by[r.status] = r.n;
  const responded = (by.viewed || 0) + (by.replied || 0) + (by.interview || 0) + (by.hired || 0) + (by.rejected || 0);
  const interview = (by.interview || 0) + (by.hired || 0);
  const hired = by.hired || 0;
  return {
    total, by,
    responseRate: total ? (responded / total * 100).toFixed(1) : '0',
    interviewRate: total ? (interview / total * 100).toFixed(1) : '0',
    hireRate: total ? (hired / total * 100).toFixed(1) : '0',
    totalConnects: db.prepare('SELECT COALESCE(SUM(connects_used),0) as n FROM applications').get().n || 0,
  };
}

// ── 🌱 track_record helpers(經驗存摺)──
export function addTrackRecord(db, t) {
  const now = new Date().toISOString();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  return db.prepare(`INSERT INTO track_record
    (title, client, skills, summary, rating, review_text, earned_usd, hours, deliverable_url, source, app_id, completed_at, notes, created_at, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
    String(t.title || '').trim().slice(0, 300),
    t.client || '',
    Array.isArray(t.skills) ? t.skills.join(', ') : (t.skills || ''),
    String(t.summary || '').slice(0, 600),
    num(t.rating),
    String(t.review_text || '').slice(0, 2000),
    num(t.earned_usd),
    num(t.hours),
    t.deliverable_url || '',
    t.source || 'upwork',
    t.app_id ?? null,
    t.completed_at || now.slice(0, 10),
    t.notes || '',
    now,
  );
}
export function listTrackRecord(db, onlyEnabled = false) {
  const q = onlyEnabled
    ? 'SELECT * FROM track_record WHERE enabled=1 ORDER BY COALESCE(completed_at, created_at) DESC'
    : 'SELECT * FROM track_record ORDER BY COALESCE(completed_at, created_at) DESC';
  return db.prepare(q).all();
}
export function getTrackRecord(db, id) {
  return db.prepare('SELECT * FROM track_record WHERE id=?').get(id);
}
export function updateTrackRecord(db, id, patch) {
  const allowed = ['title', 'client', 'skills', 'summary', 'rating', 'review_text', 'earned_usd', 'hours', 'deliverable_url', 'source', 'completed_at', 'notes', 'enabled'];
  const fields = [], vals = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) continue;
    fields.push(`${k}=?`);
    vals.push(k === 'skills' && Array.isArray(v) ? v.join(', ') : (k === 'enabled' ? (v ? 1 : 0) : v));
  }
  if (!fields.length) return;
  vals.push(id);
  db.prepare(`UPDATE track_record SET ${fields.join(', ')} WHERE id=?`).run(...vals);
}
export function deleteTrackRecord(db, id) {
  db.prepare('DELETE FROM track_record WHERE id=?').run(id);
}
export function trackRecordStats(db) {
  const rows = db.prepare('SELECT * FROM track_record').all();
  const total = rows.length;
  const fiveStars = rows.filter((r) => Number(r.rating) >= 5).length;
  const rated = rows.filter((r) => Number(r.rating) > 0);
  const avgRating = rated.length ? (rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length).toFixed(2) : '0';
  const earned = rows.reduce((s, r) => s + (Number(r.earned_usd) || 0), 0);
  const hours = rows.reduce((s, r) => s + (Number(r.hours) || 0), 0);
  const skills = [...new Set(rows.flatMap((r) => String(r.skills || '').split(',').map((x) => x.trim()).filter(Boolean)))];
  return { total, fiveStars, avgRating, earned, hours, skills };
}

export function incrementLessonHit(db, ids) {
  if (!ids || !ids.length) return;
  const stmt = db.prepare('UPDATE lessons SET hit_count=hit_count+1 WHERE id=?');
  for (const id of ids) stmt.run(id);
}

// ── invites helpers ──
export function upsertInvite(db, inv) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT status, first_seen FROM invites WHERE id = ?').get(inv.id);
  db.prepare(`
    INSERT INTO invites (
      id, title, url, job_id, received_at, received_text,
      client_spent_text, client_spent_usd, client_hires, client_payment_verified, client_invites_sent,
      raw_text, status, first_seen, last_seen
    ) VALUES (
      $id, $title, $url, $job_id, $received_at, $received_text,
      $client_spent_text, $client_spent_usd, $client_hires, $client_payment_verified, $client_invites_sent,
      $raw_text, $status, $first_seen, $last_seen
    )
    ON CONFLICT(id) DO UPDATE SET
      title=COALESCE($title, title),
      url=COALESCE($url, url),
      job_id=COALESCE($job_id, job_id),
      received_at=COALESCE($received_at, received_at),
      received_text=COALESCE($received_text, received_text),
      client_spent_text=COALESCE($client_spent_text, client_spent_text),
      client_spent_usd=COALESCE($client_spent_usd, client_spent_usd),
      client_hires=COALESCE($client_hires, client_hires),
      client_payment_verified=COALESCE($client_payment_verified, client_payment_verified),
      client_invites_sent=COALESCE($client_invites_sent, client_invites_sent),
      raw_text=COALESCE($raw_text, raw_text),
      last_seen=$last_seen
  `).run({
    $id: inv.id,
    $title: inv.title ?? null,
    $url: inv.url ?? null,
    $job_id: inv.job_id ?? null,
    $received_at: inv.received_at ?? null,
    $received_text: inv.received_text ?? null,
    $client_spent_text: inv.client_spent_text ?? null,
    $client_spent_usd: inv.client_spent_usd ?? null,
    $client_hires: inv.client_hires ?? null,
    $client_payment_verified: inv.client_payment_verified == null ? null : (inv.client_payment_verified ? 1 : 0),
    $client_invites_sent: inv.client_invites_sent ?? null,
    $raw_text: inv.raw_text ?? null,
    $status: existing ? existing.status : (inv.status ?? 'new'),
    $first_seen: existing ? existing.first_seen : now,
    $last_seen: now
  });
}

export function allInvites(db) {
  return db.prepare('SELECT * FROM invites ORDER BY COALESCE(received_at, first_seen) DESC').all();
}

export function getInvite(db, id) {
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
}

export function setInviteAi(db, id, score, verdict, recommendation, analysisJson) {
  db.prepare('UPDATE invites SET ai_score=?, ai_verdict=?, ai_recommendation=?, ai_analysis_json=? WHERE id=?')
    .run(score ?? null, verdict ?? null, recommendation ?? null, analysisJson ?? null, id);
}

export function setInviteStatus(db, id, status) {
  const r = db.prepare('UPDATE invites SET status=? WHERE id=?').run(status, id);
  return r.changes > 0;
}

// 💸 賤單防呆:預算明顯過低的案,AI 再怎麼喜歡都不准標「強力接 / 8+分」。
// 為什麼:案子「乾淨好做」≠「值得你投」。$30 這種對 0 評價新手的「評價密度÷投入」太差,
// AI 詳細分析常被「小任務+好客戶+低競爭」沖昏頭給 9.5 強力接,跟規則引擎的 lowPay(MAYBE)打架,誤導使用者去衝。
// 這是 client-realism 還沒能抓 avg $/hr 之前的防呆。閾值保守(只擋真的小錢),且為單一寫入閘 → triage/大分析全涵蓋。
// 價格底線(2026-06:已完成首案 $450,不再做虧本單)。低於此 → 賤單降級(score≤6.5、強力接→可接)
const CHEAP_FIXED = 200, CHEAP_HOURLY = 20;
function isCheapJobRow(j) {
  const fb = Number(j.fixed_budget);
  const hi = Number(j.hourly_max ?? j.hourly_min);
  if (j.budget_type === 'fixed' && Number.isFinite(fb) && fb > 0) return fb < CHEAP_FIXED;
  if (j.budget_type === 'hourly' && Number.isFinite(hi) && hi > 0) return hi < CHEAP_HOURLY;
  return false; // 預算未知/0(未解析)→ 不擋,不誤殺
}

// 寫入 AI 判斷(score、verdict、win、tags 子功能陣列、category 母類別)
// 🗑️ Skip 一個案:記墓碑(之後重抓不再寫回)+ 從 jobs 刪掉。回刪掉幾列。
export function dismissJob(db, id) {
  const sid = String(id);
  try { db.exec('CREATE TABLE IF NOT EXISTS dismissed_jobs (id TEXT PRIMARY KEY, ts TEXT)'); } catch { /* 已存在 */ }
  db.prepare('INSERT OR IGNORE INTO dismissed_jobs (id, ts) VALUES (?, ?)').run(sid, new Date().toISOString());
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(sid).changes;
}

export function setAiVerdict(db, id, score, verdict, win, tags, category) {
  // 賤單封頂:讀該案預算,過低就把 score 壓回 ≤6.5、強力接→可接(附 💸 標記),其餘照寫
  try {
    const j = db.prepare('SELECT budget_type, fixed_budget, hourly_max, hourly_min FROM jobs WHERE id=?').get(id);
    if (j && isCheapJobRow(j)) {
      if (score != null && Number(score) > 6.5) score = 6.5;
      if (typeof verdict === 'string' && /^強力接/.test(verdict)) verdict = verdict.replace(/^強力接/, '可接(💸賤單降級)');
    }
  } catch { /* 防呆失敗不擋正常寫入 */ }
  const tagStr = Array.isArray(tags) ? tags.join(',') : (tags ?? null);
  db.prepare('UPDATE jobs SET ai_score = ?, ai_verdict = ?, ai_win = ?, tags = COALESCE(?, tags), category = COALESCE(?, category) WHERE id = ?')
    .run(score ?? null, verdict ?? null, win ?? null, tagStr, category ?? null, id);
}

// 學習迴路:標記投標結果
export function setOutcome(db, id, outcome) {
  db.prepare('UPDATE jobs SET outcome = ? WHERE id = ?').run(outcome ?? null, id);
}

// 讀回 job 物件(重算評分用)
export function allJobs(db) {
  return db.prepare('SELECT * FROM jobs').all();
}

export function upsertJob(db, j) {
  // 🗑️ 已被使用者 skip 的案 → 不再寫回(免得擴充功能重抓又冒出來)
  try { if (db.prepare('SELECT 1 FROM dismissed_jobs WHERE id=?').get(String(j.id))) return; } catch { /* 表還沒建就略過 */ }
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT applied, first_seen FROM jobs WHERE id = ?').get(j.id);
  const sc = j.scores || {};
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, title, url, posted_text, posted_at,
      budget_type, budget_text, hourly_min, hourly_max, fixed_budget,
      proposals_bucket, payment_verified, experience_level, connects_required,
      client_spent_text, client_spent_usd, client_hire_rate, client_rating, client_reviews, client_jobs_posted,
      description, matched_skills,
      score_reward, score_skill, score_client, score_competition, score_longterm, score_clarity, score_risk,
      total_score, verdict, reason, blocked,
      enriched, applied, first_seen, last_seen
    ) VALUES (
      $id, $title, $url, $posted_text, $posted_at,
      $budget_type, $budget_text, $hourly_min, $hourly_max, $fixed_budget,
      $proposals_bucket, $payment_verified, $experience_level, $connects_required,
      $client_spent_text, $client_spent_usd, $client_hire_rate, $client_rating, $client_reviews, $client_jobs_posted,
      $description, $matched_skills,
      $sreward, $sskill, $sclient, $scomp, $slong, $sclar, $srisk,
      $total_score, $verdict, $reason, $blocked,
      $enriched, $applied, $first_seen, $last_seen
    )
    ON CONFLICT(id) DO UPDATE SET
      title=$title, url=$url, posted_text=$posted_text, posted_at=COALESCE($posted_at, posted_at),
      budget_type=$budget_type, budget_text=$budget_text, hourly_min=$hourly_min, hourly_max=$hourly_max, fixed_budget=$fixed_budget,
      proposals_bucket=$proposals_bucket, payment_verified=$payment_verified,
      experience_level=COALESCE($experience_level, experience_level), connects_required=COALESCE($connects_required, connects_required),
      client_spent_text=$client_spent_text, client_spent_usd=$client_spent_usd,
      client_hire_rate=$client_hire_rate, client_rating=$client_rating, client_reviews=$client_reviews, client_jobs_posted=$client_jobs_posted,
      description=$description, matched_skills=$matched_skills,
      score_reward=$sreward, score_skill=$sskill, score_client=$sclient, score_competition=$scomp,
      score_longterm=$slong, score_clarity=$sclar, score_risk=$srisk,
      total_score=$total_score, verdict=$verdict, reason=$reason, blocked=$blocked,
      enriched=$enriched, last_seen=$last_seen
  `);
  stmt.run({
    $id: j.id,
    $title: j.title ?? null,
    $url: j.url ?? null,
    $posted_text: j.posted_text ?? null,
    $posted_at: j.posted_at ?? null,
    $budget_type: j.budget_type ?? 'unknown',
    $budget_text: j.budget_text ?? null,
    $hourly_min: j.hourly_min ?? null,
    $hourly_max: j.hourly_max ?? null,
    $fixed_budget: j.fixed_budget ?? null,
    $proposals_bucket: j.proposals_bucket ?? null,
    $payment_verified: j.payment_verified ? 1 : 0,
    $experience_level: j.experience_level ?? null,
    $connects_required: j.connects_required ?? null,
    $client_spent_text: j.client_spent_text ?? null,
    $client_spent_usd: j.client_spent_usd ?? null,
    $client_hire_rate: j.client_hire_rate ?? null,
    $client_rating: j.client_rating ?? null,
    $client_reviews: j.client_reviews ?? null,
    $client_jobs_posted: j.client_jobs_posted ?? null,
    $description: j.description ?? null,
    $matched_skills: j.matched_skills ? j.matched_skills.join(',') : null,
    $sreward: sc.reward ?? 0,
    $sskill: sc.skill ?? 0,
    $sclient: sc.client ?? 0,
    $scomp: sc.competition ?? 0,
    $slong: sc.longterm ?? 0,
    $sclar: sc.clarity ?? 0,
    $srisk: sc.risk ?? 0,
    $total_score: j.total_score ?? 0,
    $verdict: j.verdict ?? 'SKIP',
    $reason: j.reason ?? null,
    $blocked: j.blocked ? 1 : 0,
    $enriched: j.enriched ? 1 : 0,
    $applied: existing ? existing.applied : 0,
    $first_seen: existing ? existing.first_seen : now,
    $last_seen: now
  });
}

export function markApplied(db, id, applied = 1) {
  const r = db.prepare('UPDATE jobs SET applied = ? WHERE id = ?').run(applied ? 1 : 0, id);
  return r.changes > 0;
}
