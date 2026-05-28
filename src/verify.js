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
