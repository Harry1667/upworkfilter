// 接案助手 — 讀「我的檔案」+ 組各種 AI prompt(求職信 / 客戶回覆 / 作品集建議)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = path.join(__dirname, '..', 'profile.json');
const PROFILE_EXAMPLE = path.join(__dirname, '..', 'profile.example.json');

export function loadProfile() {
  // 優先讀使用者編輯過的 profile.json;伺服器首次部署時沒有 → 退回範本
  const f = existsSync(PROFILE_PATH) ? PROFILE_PATH : (existsSync(PROFILE_EXAMPLE) ? PROFILE_EXAMPLE : null);
  if (!f) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}
export function saveProfile(obj) {
  writeFileSync(PROFILE_PATH, JSON.stringify(obj, null, 2));
}

// 把檔案濃縮成 prompt 用的文字
function profileBrief(p) {
  const port = (p.portfolio || []).map((x) => `- ${x.name}(${x.type}):${x.desc}`).join('\n');
  // Profile Agent 從 GitHub 歸納的「真實 repo 證據」— 求職信優先引用這些(有實作可佐證)
  const proven = (p.provenCapabilities || [])
    .map((c) => `- ${c.repo}:${c.capability}${c.url ? `(${c.url})` : ''} [${(c.techs || []).join('/')}]`)
    .join('\n');
  return [
    `姓名:${p.name || ''}`,
    `定位:${p.title || ''}|等級:${p.level || ''}|時薪:$${p.hourlyRate || '?'}`,
    `自介:${p.bio || ''}`,
    `技能:${(p.skills || []).join(', ')}`,
    `作品集:\n${port}`,
    proven ? `已證明能力(GitHub 真實 repo,優先當證據):\n${proven}` : '',
    `求職信規則:${(p.coverLetterStyle?.rules || []).join(';')}`
  ].filter(Boolean).join('\n');
}

function jobBrief(job) {
  return [
    `標題:${job.title || ''}`,
    `預算:${job.budget_text || '未知'}|提案數:${job.proposals_bucket || '?'}|付款驗證:${job.payment_verified ? '是' : '否'}`,
    `客戶:花費 ${job.client_spent_text || '?'}、評分 ${job.client_rating ?? '無'}、聘用率 ${job.client_hire_rate ?? '?'}%`,
    `描述:${(job.description || '').slice(0, 2000)}`
  ].join('\n');
}

// ① 求職信(英文 cover letter)
export function coverLetterPrompt(job, p) {
  return `你是 Upwork 接案顧問。根據「我的檔案」與「這個職缺」,寫一封**英文 cover letter**。

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}

要求:嚴格遵守上面的求職信規則(禁用 vibe coder/靠AI/10x speed;開頭講客戶問題;用最相關的作品當證據;給具體做法+時間;結尾問一句;70-110字;像真人、專業)。
只輸出 cover letter 英文本文,不要任何中文說明、不要標題、不要引號。`;
}

// ② 投標策略 — 對齊 Upwork 提案表單真正要填的欄位
export function advicePrompt(job, p) {
  const gh = p.githubUser ? `https://github.com/${p.githubUser}` : '';
  return `你是 Upwork 接案顧問。根據「我的檔案」和「這個職缺」,產出投標表單要填的內容。除了 recentExperience 用**英文**(直接貼進 Upwork),其餘用**繁體中文**。只輸出 JSON:
{
 "showPortfolio":["主打哪 1-2 個作品 + 一句原因(優先用『已證明能力』裡的真實 repo)"],
 "screenshot":"建議附哪一張作品截圖當證據(1句,指名作品/畫面)",
 "recentExperience":"英文段落(3-4句),可直接貼到 Upwork『Describe your recent experience with similar projects』欄:引用 2-3 個真實作品+具體技術,展現端到端能力,語氣專業像真人,禁用 vibe coder/靠AI/10x",
 "githubLink":"${gh}",
 "profileHighlights":["挑 4 個最貼合此案的能力標籤(Upwork Profile highlights 用,每個≤6字)"],
 "bid":"報價建議:給具體時薪/金額數字 + 一句理由。務必比較『客戶預算』vs『我的 profile rate $${p.hourlyRate || 20}』:若客戶預算遠低於我的底價,老實說值不值得接、若為搶首評價/長期建議 bid 多少",
 "angle":"切入角度/差異化(1句)"
}

我的檔案:
${profileBrief(p)}

職缺:
${jobBrief(job)}
只輸出 JSON,不要任何多餘文字。`;
}

// ③ 客戶訊息回覆助手(繁中思路 + 英文回覆)
export function replyPrompt(clientMessage, job, p, tone) {
  const ctx = job ? `\n相關職缺:\n${jobBrief(job)}\n` : '';
  return `你是 Upwork 接案溝通顧問。客戶傳來一則訊息,幫我擬回覆。
${ctx}
我的檔案:
${profileBrief(p)}

客戶訊息:
"""${(clientMessage || '').slice(0, 2000)}"""

語氣:${tone || '專業友善'}。
只輸出 JSON:{"reply":"英文回覆(可直接貼,專業、具體、若客戶問問題要答到點,結尾推進對話)","tips":["繁體中文提醒1-3條:回這則訊息要注意什麼/有沒有陷阱"]}
只輸出 JSON。`;
}

// ④ 接案助手聊天 — 帶入「我的檔案」+「目前案件清單」當上下文,口語繁中回答
export function chatPrompt(messages, p, jobs) {
  const jobLine = (j) => {
    const ai = j.ai_score != null;
    const sv = ai ? `${j.ai_score}/10 ${j.ai_verdict || ''}` : `${j.total_score}/100 ${j.verdict}`;
    return `- [${j.id}] ${j.title} | ${sv} | 預算${j.budget_text || '?'} | 提案${j.proposals_bucket || '?'}`;
  };
  const jobsCtx = (jobs || []).map(jobLine).join('\n') || '(目前無案件)';
  const convo = (messages || []).map((m) => `${m.role === 'user' ? '使用者' : '助手'}:${m.content}`).join('\n\n');
  return `你是這位 Upwork 自由工作者的私人接案助手。用**繁體中文**、口語、精簡、條列回答。你可以:解讀案子、給投標/報價/溝通建議、想策略、回答任何問題。需要時引用下面的案件清單(用標題,不要硬背 id)。誠實,不確定就說不確定。

【他的檔案】
${profileBrief(p)}

【目前案件清單(依分數排序,供你參考)】
${jobsCtx}

【對話紀錄】
${convo}

助手:`;
}

// 從 AI 回應抽 JSON(寬容)
export function extractJson(s) {
  let t = String(s).trim();
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) t = f[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}
