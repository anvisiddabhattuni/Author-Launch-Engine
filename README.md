# Author Launch Engine

Multi-agent platform that drafts and schedules social media content promoting an author's book,
with a human approval gate in front of everything that leaves the system.

This repository currently implements **STORY-001 — Draft and Schedule Social Media Content
(Content Drafting Agent)**, fulfilling `REQ-001`.

## What works today

| Story build step | Where it lives |
|---|---|
| 1. React component to upload book content and social history | `client/src/pages/UploadPage.jsx` |
| 2. Node/Express service that generates drafts with an AI model | `server/src/agents/contentDraftingAgent.js`, `server/src/ai/` |
| 3. Drafts stored in PostgreSQL with platform-targeting metadata | `server/src/db/migrations/001_init.sql` |
| 4. Scheduling module queueing approved posts | `server/src/services/scheduler.js` |
| 5. Social media APIs (mocked for demo) | `server/src/services/socialApis.js` |

Trust-Before-Intelligence controls required by the story:

- **Audit log** — every draft, decision, schedule and publish is appended to `audit_log`. Append-only
  is enforced by database triggers, so `UPDATE`, `DELETE` and `TRUNCATE` are all rejected even from a
  direct `psql` session.
- **Approval gate** — `scheduleDraft` refuses any draft not in `approved` status, and the refusal is
  itself audited.
- **Escalation** — drafts scoring below `CONFIDENCE_ESCALATION_THRESHOLD` are marked `escalated`
  instead of entering the normal queue.

## Requirements

- Node.js 20+ (developed on 22)
- PostgreSQL 17 — either a local install or `docker compose up -d`

## Setup

```bash
npm install
npm run db:reset      # creates the database, applies migrations, seeds demo data
```

`db:reset` drops and recreates the `author_launch_engine` database. Use `npm run db:migrate`
on its own to apply migrations without losing data.

If `psql` is not on your PATH (Homebrew keeps `postgresql@17` keg-only), the app does not need it —
only the migration scripts talk to the database, through the `pg` driver.

## Run

```bash
npm run dev           # API on :4000 and UI on :5173 together
```

Then open <http://localhost:5173> and walk the tabs left to right: Upload, Review & approve,
Schedule, Audit log.

## Demo in one command

```bash
npm run db:reset && npm run demo
```

Prints the full lifecycle with evidence at each step: inputs, four generated drafts with confidence
scores, the weekly cadence check, the approval gate refusing an unapproved draft, approval and
optimal-time scheduling, mocked publishing, the audit trail, and the append-only rejection.

## Tests

```bash
npm run db:reset && npm test
```

19 tests across 5 suites. The first two suites map one-to-one onto the story's Gherkin scenarios;
the rest cover the approval gate, escalation and the append-only log.

## Configuration

Copy `.env.example` to `.env` to override anything. The defaults work with no `.env` present.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/author_launch_engine` | Postgres connection |
| `PORT` | `4000` | API port |
| `AI_PROVIDER` | `stub` | `stub` or `anthropic` |
| `ANTHROPIC_API_KEY` | — | Required when `AI_PROVIDER=anthropic` |
| `CONFIDENCE_ESCALATION_THRESHOLD` | `0.7` | Below this, drafts escalate to a human |
| `MIN_POSTS_PER_WEEK` | `3` | Weekly cadence minimum from REQ-001 |

### Content providers

`stub` (default) composes platform-shaped copy from the book's own themes and sentences. It is
deterministic and needs no network, so tests and demos are reproducible. `anthropic` calls the real
Messages API.

Either way the model only *proposes* text. Confidence is scored by our own code in
`scoreDraft` — theme grounding (45%), voice overlap with the author's prior posts (35%), and fit
against the platform character limit (20%) — so the score stays explainable and provider-independent.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness plus active provider |
| `POST` | `/api/authors/:id/books` | Upload book content |
| `POST` | `/api/authors/:id/social-history` | Upload prior posts |
| `POST` | `/api/authors/:id/books/:bookId/drafts` | Generate a week of drafts |
| `GET` | `/api/drafts?authorId=&status=` | List drafts |
| `GET` | `/api/authors/:id/weekly-coverage` | Cadence proof per week |
| `POST` | `/api/drafts/:id/approve` · `/reject` | Record a human decision |
| `POST` | `/api/drafts/:id/schedule` | Queue an approved draft |
| `POST` | `/api/scheduled-posts/publish-due` | Publish through mocked adapters |
| `GET` | `/api/audit-log?authorId=` | Read the append-only log |

## Known gaps

These are deliberate deferrals, not oversights:

- Authentication and role-based access control are not implemented; the UI acts as the first author
  in the database. Auth belongs to the walking-skeleton stories in the Build Guide.
- Per-tenant isolation is by `author_id` column filtering, not the separate-schema-per-tenant model
  the requirements describe.
- Publishing is triggered on demand rather than by a background worker on a timer.
- Social platform adapters are mocked; no live credentials are involved.
- The build guide specifies Create React App; this uses Vite, since CRA is deprecated and
  unmaintained.
