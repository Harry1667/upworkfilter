// 🛠️ Chat Agent tool registry — 讓聊天助手能執行動作
// 協定:AI 在回覆裡夾 <tool>{"name":"X","args":{...}}</tool>,server 抽出執行,結果丟回給 AI

import {
  addLesson, listLessons, deleteLesson, setLessonEnabled,
  addAnchor, listAnchors, deleteAnchor, setAnchorEnabled,
  addApplication, listApplications, updateApplication, deleteApplication, applicationStats,
  markApplied,
} from './db.js';

// ── 工具清單(AI prompt 會看到這份說明) ──
export const TOOL_DOCS = `
你有以下工具可用。要用時在回覆裡夾 \`<tool>{"name":"...","args":{...}}</tool>\` 標籤(可以多次)。
**結果會丟回給你**,你再用最終答案回使用者。**不要在最終答案裡留 <tool> 標籤**。

可用工具:
- list_applications() — 列所有投案紀錄(id/title/status/notes/rate/連結到 job)
- import_applied() — 把列表頁勾過「已投」但 applications 沒紀錄的案子自動匯入
- add_application({job_id?,job_title,rate?,connects_used?,notes?}) — 手動加投案紀錄(沒 job_id 也可)
- update_application({id, status?, notes?, rate?}) — 改投案的狀態/備註/報價。status: sent/viewed/replied/interview/hired/rejected/no_response
- delete_application({id}) — 刪投案紀錄
- list_lessons() — 列所有 lessons(含 enabled 狀態)
- add_lesson({content, category?}) — 加新 lesson(會強制套到所有 AI prompt)
- delete_lesson({id}) — 刪 lesson
- list_anchors() — 列所有範本
- add_anchor({cover_letter, job_title?, note?}) — 加 cover letter 範本
- list_jobs({verdict?, applied?, limit?}) — 列案件清單,可過濾
- mark_job_applied({id, applied}) — 在列表頁標記某案「已投」與否

**重要規則**:
1. 只在使用者**明確要求**做事時才用 tool。聊天回答用文字就好。
2. 修改/刪除類動作(update/delete) → 先在文字裡告訴使用者你打算做什麼、確認後再用 tool。
3. 一次最多 3 個 tool call,別亂跑。
4. tool 結果回來後,**用人話總結**,別印 raw JSON。
`;

// ── 執行單一 tool ──
export function executeTool(db, call) {
  const { name, args = {} } = call;
  try {
    switch (name) {
      case 'list_applications': {
        const rows = listApplications(db);
        return { ok: true, count: rows.length, applications: rows.map((r) => ({ id: r.id, title: r.job_title, status: r.status, rate: r.rate, connects: r.connects_used, notes: r.notes, applied_at: (r.applied_at || '').slice(0, 10) })) };
      }
      case 'import_applied': {
        const applied = db.prepare('SELECT * FROM jobs WHERE applied=1').all();
        const existing = new Set(db.prepare('SELECT job_id FROM applications WHERE job_id IS NOT NULL').all().map((r) => r.job_id));
        let added = 0;
        for (const j of applied) {
          if (existing.has(j.id)) continue;
          addApplication(db, { job_id: j.id, job_title: j.title || '', applied_at: j.last_seen, rate: j.budget_text || '', notes: '從列表頁「已投」匯入' });
          added++;
        }
        return { ok: true, added, skipped: applied.length - added };
      }
      case 'add_application':
        addApplication(db, args);
        return { ok: true, msg: '已加入投案追蹤' };
      case 'update_application':
        if (!args.id) return { ok: false, error: '缺 id' };
        updateApplication(db, args.id, args);
        return { ok: true, msg: '已更新' };
      case 'delete_application':
        if (!args.id) return { ok: false, error: '缺 id' };
        deleteApplication(db, args.id);
        return { ok: true, msg: '已刪除' };
      case 'list_lessons': {
        const rows = listLessons(db, false);
        return { ok: true, count: rows.length, lessons: rows.map((l) => ({ id: l.id, content: l.content, category: l.category, enabled: !!l.enabled, hit_count: l.hit_count })) };
      }
      case 'add_lesson':
        if (!args.content) return { ok: false, error: '缺 content' };
        addLesson(db, args.content, args.category || 'general');
        return { ok: true, msg: '已加 lesson,所有未來 AI prompt 都會讀到' };
      case 'delete_lesson':
        if (!args.id) return { ok: false, error: '缺 id' };
        deleteLesson(db, args.id);
        return { ok: true, msg: '已刪 lesson' };
      case 'list_anchors': {
        const rows = listAnchors(db, false);
        return { ok: true, count: rows.length, anchors: rows.map((a) => ({ id: a.id, title: a.job_title, enabled: !!a.enabled, length: (a.cover_letter || '').length, note: a.note })) };
      }
      case 'add_anchor':
        if (!args.cover_letter || args.cover_letter.length < 30) return { ok: false, error: 'cover_letter 至少 30 字' };
        addAnchor(db, args);
        return { ok: true, msg: '已加 anchor 範本' };
      case 'list_jobs': {
        const conds = []; const params = [];
        if (args.verdict) { conds.push('verdict=?'); params.push(args.verdict); }
        if (args.applied != null) { conds.push('applied=?'); params.push(args.applied ? 1 : 0); }
        const limit = Math.min(Number(args.limit) || 15, 50);
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const rows = db.prepare(`SELECT id,title,budget_text,proposals_bucket,total_score,verdict,ai_score,ai_verdict,applied FROM jobs ${where} ORDER BY COALESCE(ai_score*10, total_score) DESC LIMIT ?`).all(...params, limit);
        return { ok: true, count: rows.length, jobs: rows };
      }
      case 'mark_job_applied':
        if (!args.id) return { ok: false, error: '缺 id' };
        markApplied(db, args.id, args.applied ? 1 : 0);
        return { ok: true, msg: args.applied ? '已標記為投出' : '取消已投標記' };
      default:
        return { ok: false, error: `未知 tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 從 AI 回覆抽 <tool>...</tool> ──
export function extractToolCalls(text) {
  const calls = [];
  const re = /<tool>\s*([\s\S]*?)\s*<\/tool>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      let raw = m[1].trim();
      // 寬容:可能包 ```json
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      const obj = JSON.parse(raw);
      if (obj && obj.name) calls.push(obj);
    } catch (e) {
      console.error('tool parse 失敗:', e.message, m[1].slice(0, 100));
    }
  }
  return calls;
}

// ── 移除回覆裡的 <tool> 標籤(顯示給使用者前清乾淨) ──
export function stripToolTags(text) {
  return String(text || '').replace(/<tool>[\s\S]*?<\/tool>/gi, '').trim();
}
