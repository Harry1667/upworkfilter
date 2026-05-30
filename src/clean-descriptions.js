// 一次性 migration:把既有 jobs.description 的 Upwork 頁面 chrome 剝掉(冪等,可重跑)。
// 用法:node src/clean-descriptions.js   之後跑 npm run rescore 讓 clarity 等重算。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripChrome } from './score.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, '..', 'jobs.db'));
const rows = db.prepare('SELECT id, description FROM jobs').all();
const upd = db.prepare('UPDATE jobs SET description = ? WHERE id = ?');
let changed = 0, saved = 0;
for (const j of rows) {
  const c = stripChrome(j.description);
  if (c !== j.description) { saved += (String(j.description).length - c.length); upd.run(c, j.id); changed++; }
}
console.log(`✅ 清理 ${changed}/${rows.length} 列,省 ${saved} 字元。記得跑 npm run rescore 重算。`);
