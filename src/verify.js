// 幻覺偵測 — 比對 cover letter 內所有「可驗證 claim」vs profile.json
// 輸出 annotated claims:✅ verified / ⚠️ unverified / 🚨 contradicted

import { askAI } from './analyze.js';
import { extractJson } from './assist.js';

// 把 profile 壓成 AI 看得懂的「真實事實清單」
function profileFacts(p) {
  const skills = (p.skills || []).join(', ');
  const portfolio = (p.portfolio || [])
    .map((x) => `- ${x.name}: ${x.desc || ''} [techs: ${(x.tech || x.techs || []).join('/')}]${x.link ? ' ' + x.link : ''}`)
    .join('\n');
  const proven = (p.provenCapabilities || [])
    .map((c) => `- ${c.repo}: ${c.capability} [techs: ${(c.techs || []).join('/')}] ${c.url || ''}`)
    .join('\n');
  return [
    `身份: ${p.title || ''} | ${p.location || ''} | ${p.availability || ''}`,
    `Profile rate: $${p.hourlyRate || ''}/hr`,
    `Skills(自填): ${skills}`,
    `Portfolio(手動填):\n${portfolio || '(無)'}`,
    `已驗證能力(從 GitHub 抓的真實 repo):\n${proven || '(無)'}`,
  ].join('\n\n');
}

// ⑥ Citation 強制:輸入草稿,輸出附引用標記的版本 + 來源清單
// AI 要在每個可驗證 claim 後面插 [^N] 標記,並列出每個 N 對應的 profile 真實來源
export async function annotateCitations(text, profile) {
  if (!text || text.length < 30) return { annotated: text, sources: [] };
  const prompt = `你是引用標註器。下面是 cover letter,你的工作:
1) 找出每個可驗證的具體 claim(技術/作品/數字/地區/時薪)
2) 在每個 claim 後面**直接插入** [^N] 標記(N 從 1 遞增)
3) 為每個 N 寫一行 source 引用,**精準對到 profile 的哪一段**

profile 真實事實:
${profileFacts(profile)}

cover letter:
"""${String(text).slice(0, 3000)}"""

輸出規則:
- 文章本體不可改字,只加 [^N] 標記
- 找不到對應 source 的 claim → 標 [^?] 而不是 [^N],並在 sources 用 status "unverified" 警告
- 主動跟 profile 矛盾的 claim → 標 [^!] (例如 profile 是 Taiwan 但寫 US),sources 用 "contradicted"
- 結尾簽名 / Hi / "Ready to start" 這種非 claim 句不用標

只輸出 JSON:
{
 "annotated":"完整加標記的 cover letter 文本(原文 + [^N]/[^?]/[^!] 標記)",
 "sources":[
   {"n":"1 或 ? 或 !","claim":"短句精簡 ≤30 字","status":"verified|unverified|contradicted","source":"profile 哪一段(如 portfolio.AgentsHub / provenCapabilities[3] / location)","note":"額外說明(可空)"}
 ]
}`;
  try {
    const raw = await askAI(prompt);
    const data = extractJson(raw);
    return data;
  } catch (e) {
    console.error('Citation 失敗:', e.message);
    return { annotated: text, sources: [] };
  }
}

// ⑩ Skeptic — 魔鬼代言人:扮演挑剔雇主挑 cover letter 的刺
export async function skepticCritique(text, job, profile) {
  if (!text || text.length < 30) return { issues: [], verdict: 'too short' };
  const jobBrief = [
    `標題: ${job?.title || ''}`,
    `預算: ${job?.budget_text || '?'}`,
    `描述: ${(job?.description || '').slice(0, 1500)}`,
  ].join('\n');
  const prompt = `你是嚴格的挑剔雇主,正在快速掃 100 封 cover letter。你的工作:挑這封信的**刺**(不挑優點)。

【職缺】
${jobBrief}

【cover letter】
"""${String(text).slice(0, 3000)}"""

挑刺角度(找 3-6 個就好,寧少勿濫):
1. 哪句太業務 tone / 套版?
2. 哪句沒對應到 JD 客戶問的問題?
3. 哪個 claim 沒證據支撐 / 模糊?
4. 開頭 5 秒能不能 hook 我?
5. 結尾有沒有推進對話的問題?
6. 整體長度對這案 OK 嗎(JD 簡單 → 長太長 / JD 詳細 → 答太短)?
7. 有沒有讓 "新手 0 評價" 變成劣勢的句子?
8. 有沒有放錯重點(技術細節 vs 對客戶的價值)?

每個 issue 給:
- severity: high(必改) / medium(建議改) / low(可改可不改)
- problem: 1 句指出問題(繁中)
- suggestion: 1 句具體建議怎麼改(繁中)
- quote: 引用原文那 1 句(英文,精簡)

只輸出 JSON:
{
 "issues":[{"severity":"high|medium|low","problem":"...","suggestion":"...","quote":"..."}],
 "verdict":"整體 1 句評(繁中):這封信值不值得貼 / 該怎麼改才能更強"
}`;
  try {
    const raw = await askAI(prompt);
    return extractJson(raw);
  } catch (e) {
    console.error('Skeptic 失敗:', e.message);
    return { issues: [], verdict: 'verification failed' };
  }
}

// 🧠 自動 Lesson 學習 — 從 application notes 萃取 lesson 候選
export async function extractLessonCandidates(notes, existingLessons = []) {
  if (!notes || notes.length < 10) return { candidates: [] };
  const existing = (existingLessons || []).slice(0, 30).map((l, i) => `[${i + 1}] ${l}`).join('\n');
  const prompt = `你是學習日誌助手。下面是使用者寫的「為什麼這案沒中 / 沒回應」的筆記。
你的工作:從筆記抽出 **可重用的硬規則**,讓未來 AI 寫 cover letter / 投案策略時自動避開同樣的錯。

【現有 Lessons(避免重複)】
${existing || '(無)'}

【使用者筆記】
"""${String(notes).slice(0, 1500)}"""

抽 lesson 原則:
- 必須是**通用、可套用未來**的規則,不要案件專屬細節
- 必須是**硬規則**:「永遠別 X」「永遠先 Y」這種,不是「也許試試」
- 與現有 lessons 重複的 → 不抽
- 沒抽到也沒關係,寧缺勿濫

只輸出 JSON:
{
 "candidates":[{"content":"硬規則(繁中,1 句,可以直接存為 lesson)","category":"honesty|tech|format|location|client-check|strategy|general"}]
}`;
  try {
    const raw = await askAI(prompt);
    return extractJson(raw);
  } catch (e) {
    console.error('Lesson 萃取失敗:', e.message);
    return { candidates: [] };
  }
}

// 主函式:輸入 cover letter 草稿,輸出 claim 清單
export async function detectHallucinations(text, profile) {
  if (!text || text.length < 30) return { claims: [], summary: '草稿太短,跳過驗證' };
  const prompt = `你是事實核查員。下面有一封 Upwork cover letter 草稿,和使用者的真實 profile。
你的工作:抽出草稿裡每個「可驗證的具體主張」,逐一核對 profile,標 3 種狀態:
- ✅ verified: profile 真有這個事實
- ⚠️ unverified: profile 沒提到,可能是 AI 自由發揮(時間/數字/形容詞最常見)
- 🚨 contradicted: profile 明顯說的不一樣(例如地區、時薪、技術沒做過)

【真實 profile】
${profileFacts(profile)}

【cover letter 草稿】
"""${String(text).slice(0, 3000)}"""

抓 claim 的原則:
- **要查**:技術名(Cowork/n8n/RAG/特定 API)、數字(1 year / 5 apps / 30 hrs)、地區、時薪、主張(shipped X / built Y / production)
- **不用查**:口語連接詞、客套問句、JD 引用、語氣詞

只輸出 JSON,不要 markdown 圍欄:
{
 "claims": [
   {"text":"原句精簡(中英都 OK,≤40 字)", "status":"verified|unverified|contradicted", "evidence":"profile 哪一段對應(中文 1 句)或為何標警告"}
 ],
 "summary":"整體評估(繁中 1 句):有幾個 contradicted / unverified,建議使用者改哪幾處"
}`;
  try {
    const raw = await askAI(prompt);
    const data = extractJson(raw);
    return data;
  } catch (e) {
    console.error('幻覺偵測失敗:', e.message);
    return { claims: [], summary: '驗證失敗:' + e.message };
  }
}
