# Codex UpworkFilter Brief

Source: ChatGPT shared conversation provided by the user
URL: https://chatgpt.com/share/6a1a99ca-40e4-83a9-8680-9f94662dd042
Captured by Codex on 2026-05-30 because Claude could not access the share link directly.

## User Situation

- The user is trying to get the first Upwork job/review.
- The Upwork account is new and has no completed Upwork contract yet.
- The user has submitted multiple proposals without offers or invites.
- Some proposals may have been viewed, but they did not convert to replies.
- The current objective is not maximizing project size; it is getting the first credible Upwork win.

## Strategic Conclusion

Do not optimize UpworkFilter as a generic “best technical match” system only.

For a new Upwork account, the product should help the user find jobs that are both:

1. technically doable, and
2. realistically winnable by someone with no Upwork work history.

The key distinction:

- `Skill Match Score`: can the user technically do the job?
- `New Account Winability Score`: can a new Upwork profile plausibly win this job?

A job can have high skill match but low winability.

## Connects / Membership Advice

The shared conversation recommends:

- Do not buy Freelancer Plus immediately.
- If buying anything, buy only a small Connects pack as a controlled test budget.
- Do not continue submitting proposals randomly.
- First improve profile positioning, portfolio framing, job selection, and proposal structure.
- Treat the next small Connects purchase as an experiment, not as a volume strategy.

## Better Positioning

The recommended positioning is specific and outcome-oriented:

> AI Automation Developer | n8n, OpenAI API, Web Scraping, Google Sheets

The product should nudge the user away from broad “I do AI” messaging and toward:

> I can automate a specific business workflow and deliver a small working result quickly.

## Jobs To Prefer

For the first Upwork win, prefer small, clear, low-competition implementation tasks:

- n8n automation fixes
- OpenAI API chatbot setup
- Google Sheets automation
- web scraping scripts
- email parser to spreadsheet
- Zapier / Make / n8n workflow
- AI customer service bot for a small business
- small data extraction, parser, or integration tasks

Strong positive signals:

- Posted within the last 1-3 hours.
- Fewer than 10 proposals.
- Payment verified.
- Client has previous spend.
- Client has a reasonable hire history.
- Fixed price around USD 50-300.
- Clear scope and deliverables.
- Can be completed in 1-3 days.
- The user can point to a directly relevant portfolio proof.

## Jobs To Penalize Or Skip

For a new account, penalize jobs such as:

- Senior AI Agent Engineer
- Browser Agent Expert
- Computer Use Expert
- Full-stack AI Developer for large systems
- Managed agents / enterprise agent platform work
- full SaaS from scratch
- long-term expert developer roles
- vague “AI engineer” jobs with broad scope
- jobs with 20-50+ proposals
- jobs already interviewing many candidates
- jobs requiring very high Connects
- low-budget but huge-scope builds
- unverified payment
- no client spend
- no hire history
- unclear requirements

These may be technically interesting, but they are poor first-win targets.

## Portfolio Context

The user’s profile/portfolio evidence includes:

- `AgentsHub`: multi-agent AI workspace with chat, meetings, pixel office UI, Next.js, React, TypeScript, MySQL/Drizzle, OpenAI/Claude/Gemini proxy, live site.
- `SocialBot`: multi-persona social media manager, Next.js, PostgreSQL, TypeScript, OpenAI API, scheduling, AI draft generation, review/approval flow.
- `api-dindon`: hospital queue tracker serving Taiwan hospitals, FastAPI, Celery, Redis, scraper integrations, LINE Bot notifications, Docker Compose.
- `Fooda`: iOS AI meal tracker using image recognition and nutrition estimation.
- `CamMenu`: iOS menu translator and ordering guide using Gemini API.
- `Mentora`: full-stack AI mentor SaaS with Next.js, Node.js, Clerk, PostgreSQL, Docker/Nginx.
- `BuyTokyoHouse`: multilingual real estate listing platform.
- `CleanHome`: SEO-optimized housekeeping booking/conversion website.

Useful capability clusters:

- AI automation
- OpenAI / Claude / Gemini integration
- Next.js / React / TypeScript
- PostgreSQL / MySQL / Drizzle
- FastAPI / Node.js
- Docker deployment
- web scraping / parsers
- LINE Bot / notifications
- workflow automation
- SEO / conversion websites
- iOS AI app prototyping

## Why Current Proposals Likely Failed

The shared conversation’s diagnosis:

- The problem is probably not lack of technical ability.
- The current approach may sound too much like an engineer self-introduction.
- Proposals need to reduce client risk.
- Proposals need to name the client’s concrete problem and expected deliverable.
- The user should offer a small paid test or first milestone.
- The user should avoid competing directly for senior/expert AI roles before getting initial Upwork proof.

## Proposal Generation Rules

The proposal generator should produce short, specific, human-sounding proposals.

Avoid:

- generic self-introduction
- long skill lists
- inflated senior/expert claims
- broad “I can build anything with AI” language
- unsupported claims not grounded in the profile/portfolio

Prefer this structure:

```text
Hi,

The core problem is [client problem in plain English].

I can help you build/fix this by:
1. [specific step]
2. [specific step]
3. [specific deliverable]

Relevant experience:
[one directly relevant portfolio proof, not a full resume]

To reduce risk, I can start with a small paid test:
[small concrete milestone]

Question:
[one sharp question that proves the proposal was written for this job]
```

Proposal intent:

- show the user understood the job
- explain the likely solution path
- cite one relevant proof
- reduce risk with a small first milestone
- ask a concrete question

## Product Direction For UpworkFilter

Future scoring/filtering work should:

- expose both technical fit and new-account winability
- treat “ability to deliver” and “ability to win as a new profile” as separate concepts
- bias recommendations toward small, fast, clear, low-competition jobs
- warn against high-status expert jobs that burn Connects
- help choose portfolio evidence that matches the job
- generate proposals around risk reduction and small first deliverables

## Implementation Guidance For Claude

When asked to improve scoring or proposals:

1. Read this file first.
2. Inspect the current scoring/filtering code, especially `src/score.js`, `src/triage.js`, and relevant rendering in `src/web.js`.
3. Inspect proposal generation in `src/assist.js` and API wiring in `src/web.js`.
4. Do not remove the existing skill/capability gate.
5. Add or preserve a distinct new-account winability concept rather than blending everything into technical skill.
6. Keep AI cost control intact: rule scoring first, cheap AI triage second, deep analysis/proposal generation only when needed.
7. Update notes after implementation and explain any differences from the plan.

## Safety Notes

- Do not store or expose Upwork password, Gmail password, cookies, tokens, sessions, or `.env` secrets.
- Use fake or redacted job/profile data when documentation examples are needed.
- Do not add raw credentials to git.
