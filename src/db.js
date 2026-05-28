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
  return db;
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
