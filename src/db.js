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
  // 學習迴路:投標結果(applied→ 已回/面試/錄取/未回),供日後校正評分
  try { db.exec('ALTER TABLE jobs ADD COLUMN outcome TEXT'); } catch { /* 已存在 */ }
  return db;
}

// 寫入 AI 判斷(score 0-10、verdict、win 中標機率 0-100)。供卡片/評估頁優先顯示
export function setAiVerdict(db, id, score, verdict, win) {
  db.prepare('UPDATE jobs SET ai_score = ?, ai_verdict = ?, ai_win = ? WHERE id = ?')
    .run(score ?? null, verdict ?? null, win ?? null, id);
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
      id, title, url, posted_text,
      budget_type, budget_text, hourly_min, hourly_max, fixed_budget,
      proposals_bucket, payment_verified,
      client_spent_text, client_spent_usd, client_hire_rate, client_rating, client_reviews, client_jobs_posted,
      description, matched_skills,
      score_reward, score_skill, score_client, score_competition, score_longterm, score_clarity, score_risk,
      total_score, verdict, reason,
      enriched, applied, first_seen, last_seen
    ) VALUES (
      $id, $title, $url, $posted_text,
      $budget_type, $budget_text, $hourly_min, $hourly_max, $fixed_budget,
      $proposals_bucket, $payment_verified,
      $client_spent_text, $client_spent_usd, $client_hire_rate, $client_rating, $client_reviews, $client_jobs_posted,
      $description, $matched_skills,
      $sreward, $sskill, $sclient, $scomp, $slong, $sclar, $srisk,
      $total_score, $verdict, $reason,
      $enriched, $applied, $first_seen, $last_seen
    )
    ON CONFLICT(id) DO UPDATE SET
      title=$title, url=$url, posted_text=$posted_text,
      budget_type=$budget_type, budget_text=$budget_text, hourly_min=$hourly_min, hourly_max=$hourly_max, fixed_budget=$fixed_budget,
      proposals_bucket=$proposals_bucket, payment_verified=$payment_verified,
      client_spent_text=$client_spent_text, client_spent_usd=$client_spent_usd,
      client_hire_rate=$client_hire_rate, client_rating=$client_rating, client_reviews=$client_reviews, client_jobs_posted=$client_jobs_posted,
      description=$description, matched_skills=$matched_skills,
      score_reward=$sreward, score_skill=$sskill, score_client=$sclient, score_competition=$scomp,
      score_longterm=$slong, score_clarity=$sclar, score_risk=$srisk,
      total_score=$total_score, verdict=$verdict, reason=$reason,
      enriched=$enriched, last_seen=$last_seen
  `);
  stmt.run({
    $id: j.id,
    $title: j.title ?? null,
    $url: j.url ?? null,
    $posted_text: j.posted_text ?? null,
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
