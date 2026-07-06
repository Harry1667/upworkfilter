# Upwork Job Filter

A personal job-search intelligence pipeline. A browser extension scrapes live marketplace
job listings → a webhook feeds them to a cloud service → a multi-dimensional **scoring engine**
filters and ranks them → a **multi-LLM triage layer** judges fit and win-probability → a dashboard
surfaces only the jobs actually worth applying to.

> Built and run by one developer for daily personal use. Read-only, low request volume.

**Live:** https://upworkfilter.looptw.com
**Stack:** Node.js (zero web framework) · `node:sqlite` (WAL) · Playwright + stealth ·
Anthropic Claude / OpenAI / Google Gemini (one unified client with automatic fallback)

---

## What it does — a three-gate funnel

1. **Source** — a browser extension scrapes listing pages and `POST`s them to `/api/ingest`.
   Payloads are normalized and de-duplicated into SQLite.
2. **Capability gate** — a rule engine (`score.js`) hard-blocks out-of-scope / red-line jobs
   *before* any paid AI call, so money is only spent on plausible matches.
3. **Scoring + AI** — a 7-dimension weighted score, then a cheap LLM triage pass over the
   shortlist; only the best jobs get an expensive deep analysis. Results write back to SQLite
   and drive the ranked dashboard.

## Engineering highlights

- **Resilient scraping** — Playwright + `puppeteer-extra` stealth, Cloudflare-challenge
  handling with retry/backoff, login-session reuse.
- **Webhook ingestion pipeline** — extension → `/api/ingest` → normalize → dedupe → SQLite,
  fully decoupled so scraping and scoring run independently.
- **Rule-based scoring engine** — multi-dimensional weighted scoring plus hard "death-signal"
  gates (e.g. unverified client + 0% hire-rate + saturated proposals → auto-skip), all in
  plain JS/SQL with no ORM.
- **Multi-LLM with automatic fallback chain** — tries a fast direct path first, then a
  provider chain (Claude → OpenAI → Gemini) with a short per-provider timeout, so a single
  provider outage never takes the system down. Hung subprocesses are force-killed and reaped.
- **Cost control** — cheap models for bulk triage, expensive models only for the shortlist,
  plus a daily scheduled batch run. A user-toggled paid/free key switch controls spend.
- **Operational hardening** — incremental write-back (resumable mid-run), in-flight locks to
  prevent duplicate jobs, graceful degradation when an upstream is slow.

## Architecture

```
Browser extension ──webhook──▶ /api/ingest ──▶ normalize + dedupe ──▶ SQLite
                                                                        │
                          rule scoring (capability + death signals) ◀──┘
                                       │  (only plausible jobs)
                                       ▼
                       LLM triage (cheap) ──▶ deep analysis (shortlist only)
                                       │
                                       ▼
                           ranked dashboard + apply tracking
```

## Tech

| Area | Choice |
|------|--------|
| Runtime | Node.js, no web framework (raw `http` server) |
| Storage | `node:sqlite` (WAL, `busy_timeout`) |
| Scraping | Playwright, `playwright-extra`, stealth plugin |
| AI | Claude / OpenAI / Gemini via one client with fallback chain |
| Frontend | Server-rendered, CSS-Grid layout + floating chat assistant |

---

*Personal project — demonstrates resilient scraping, webhook data pipelines, a SQLite scoring
engine, and production multi-LLM integration with graceful fallback.*
