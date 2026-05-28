// SQLite 資料層 — 使用 Node 25 內建的 node:sqlite(免裝原生套件)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'jobs.db');

const SCORE_COLS = ['score_reward', 'score_skill', 'score_client', 'score_competition', 'score_longterm', 'score_clarity', 'score_risk'];

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
  // 發布時間「絕對時間戳」(ISO):擴充功能算好的 postedAtIso。posted_text 是會過期的相對字串,顯示一律用這個重算。
  try { db.exec('ALTER TABLE jobs ADD COLUMN posted_at TEXT'); } catch { /* 已存在 */ }
  try { db.exec('ALTER TABLE jobs ADD COLUMN favorited INTEGER DEFAULT 0'); } catch { /* 已存在 */ }

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

// 寫入 AI 判斷(score、verdict、win、tags 子功能陣列、category 母類別)
export function setAiVerdict(db, id, score, verdict, win, tags, category) {
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
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT applied, first_seen FROM jobs WHERE id = ?').get(j.id);
  const sc = j.scores || {};
  const stmt = db.prepare(`
    INSERT INTO jobs (
      id, title, url, posted_text, posted_at,
      budget_type, budget_text, hourly_min, hourly_max, fixed_budget,
      proposals_bucket, payment_verified,
      client_spent_text, client_spent_usd, client_hire_rate, client_rating, client_reviews, client_jobs_posted,
      description, matched_skills,
      score_reward, score_skill, score_client, score_competition, score_longterm, score_clarity, score_risk,
      total_score, verdict, reason, blocked,
      enriched, applied, first_seen, last_seen
    ) VALUES (
      $id, $title, $url, $posted_text, $posted_at,
      $budget_type, $budget_text, $hourly_min, $hourly_max, $fixed_budget,
      $proposals_bucket, $payment_verified,
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
