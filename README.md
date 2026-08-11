# Author Launch Engine

Multi-agent platform that drafts and schedules social media content promoting an author's book,
with a human approval gate in front of everything that leaves the system.

Implemented so far:

- **STORY-001 — Draft and Schedule Social Media Content** (Content Drafting Agent), fulfilling `REQ-001`
- **STORY-002 — Identify and Draft Outreach Messages for Opportunities** (Opportunity Scouting Agent
  and PR & Outreach Agent), fulfilling `REQ-002`

## What works today

### STORY-001 — social content

| Story build step | Where it lives |
|---|---|
| 1. React component to upload book content and social history | `client/src/pages/UploadPage.jsx` |
| 2. Node/Express service that generates drafts with an AI model | `server/src/agents/contentDraftingAgent.js`, `server/src/ai/` |
| 3. Drafts stored in PostgreSQL with platform-targeting metadata | `server/src/db/migrations/001_init.sql` |
| 4. Scheduling module queueing approved posts | `server/src/services/scheduler.js` |
| 5. Social media APIs (mocked for demo) | `server/src/services/socialApis.js` |

### STORY-002 — outreach opportunities

| Story build step | Where it lives |
|---|---|
| 1. Service connecting to event and podcast directories (mocked) | `server/src/services/directories.js` |
| 2. Keyword analysis module identifying relevant opportunities | `server/src/services/keywordAnalysis.js` |
| 3. React interface for reviewing and approving messages | `client/src/pages/OpportunitiesPage.jsx`, `OutreachPage.jsx` |
| 4. Opportunities and messages stored in PostgreSQL | `server/src/db/migrations/002_outreach.sql` |
| 5. Email API for sending approved messages (mocked) | `server/src/services/emailApi.js` |

Two agents split the work along the story's two scenarios: `opportunityScoutingAgent.js` finds and
scores opportunities, `prOutreachAgent.js` drafts the pitch. Both live in `server/src/agents/`.

Trust-Before-Intelligence controls required by both stories:

- **Audit log** — every draft, opportunity, decision, schedule, publish and send is appended to
  `audit_log`. Append-only is enforced by database triggers, so `UPDATE`, `DELETE` and `TRUNCATE`
  are all rejected even from a direct `psql` session.
- **Approval gate** — `scheduleDraft` refuses any social draft not in `approved` status, and
  `sendOutreachMessage` refuses any email that is not approved. Both refusals are audited.
- **Escalation** — drafts and messages scoring below `CONFIDENCE_ESCALATION_THRESHOLD` are marked
  `escalated` instead of entering the normal queue.

Social drafts and outreach messages share one `approvals` table, so the gate behaves identically for
both. Nullable foreign keys with an exactly-one check constraint keep referential integrity that a
polymorphic `entity_id` column would lose.

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

Then open <http://localhost:5173> and walk the tabs left to right: Upload, Social review, Social
schedule, Opportunities, Outreach, Audit log.

## Demo in one command

```bash
npm run db:reset && npm run demo
```

Prints 14 stages with evidence at each one. Stages 1–8 cover STORY-001: inputs, generated drafts
with confidence scores, the weekly cadence check, the approval gate refusing an unapproved draft,
optimal-time scheduling, mocked publishing, the audit trail and the append-only rejection. Stages
9–14 cover STORY-002: the directory scan with relevance scores and rejections, the monthly cadence
check, personalized outreach drafts, the send gate refusing an unapproved message, approval and
mocked sending, and the outreach audit trail.

## Tests

```bash
npm run db:reset && npm test
```

39 tests across 9 suites. For each story the first two suites map one-to-one onto its Gherkin
scenarios; the rest cover the approval gate, escalation and the append-only log.

## Configuration

Copy `.env.example` to `.env` to override anything. The defaults work with no `.env` present.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/author_launch_engine` | Postgres connection |
| `PORT` | `4000` | API port |
| `AI_PROVIDER` | `stub` | `stub` or `anthropic` |
| `ANTHROPIC_API_KEY` | — | Required when `AI_PROVIDER=anthropic` |
| `CONFIDENCE_ESCALATION_THRESHOLD` | `0.7` | Below this, drafts and messages escalate to a human |
| `MIN_POSTS_PER_WEEK` | `3` | Weekly cadence minimum from REQ-001 |
| `RELEVANCE_THRESHOLD` | `0.5` | Below this, a directory listing is not recorded as an opportunity |
| `MIN_OPPORTUNITIES_PER_MONTH` | `5` | Monthly cadence minimum from REQ-002 |

### Content providers

`stub` (default) composes platform-shaped copy from the book's own themes and sentences. It is
deterministic and needs no network, so tests and demos are reproducible. `anthropic` calls the real
Messages API.

Either way the model only *proposes* text. Confidence is scored by our own code so it stays
explainable and provider-independent:

- **Social drafts** (`scoreDraft`) — theme grounding 45%, voice overlap 35%, platform fit 20%.
- **Outreach messages** (`scoreMessage`) — personalization 40%, theme grounding 30%, voice 20%,
  length fit 10%. Personalization dominates because a generic pitch is the specific failure this
  story exists to prevent.

Opportunity relevance (`scoreOpportunity`) is never a model call at all — it decides what reaches a
human, so it has to be reproducible. It weights having any strong theme match (55%) above breadth
across themes (30%) and loose vocabulary overlap (15%).

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
| `POST` | `/api/authors/:id/books/:bookId/opportunities/scout` | Scan directories for opportunities |
| `GET` | `/api/opportunities?authorId=&type=` | List opportunities |
| `GET` | `/api/authors/:id/monthly-opportunities` | Monthly cadence proof, by type |
| `POST` | `/api/authors/:id/books/:bookId/outreach/draft` | Draft outreach messages |
| `GET` | `/api/outreach-messages?authorId=&status=` | List outreach messages |
| `POST` | `/api/outreach-messages/:id/approve` · `/reject` | Record a human decision |
| `POST` | `/api/outreach-messages/:id/send` | Send through the mocked email provider |
| `GET` | `/api/audit-log?authorId=` | Read the append-only log |

## Known gaps

These are deliberate deferrals, not oversights:

- Authentication and role-based access control are not implemented; the UI acts as the first author
  in the database. Auth belongs to the walking-skeleton stories in the Build Guide.
- Per-tenant isolation is by `author_id` column filtering, not the separate-schema-per-tenant model
  the requirements describe.
- Publishing and outreach sending are triggered on demand rather than by a background worker.
- Social platform, directory and email adapters are all mocked; no live credentials are involved.
- Directory listings are a fixed catalogue, so a monthly rescan finds nothing new. A live adapter
  would return fresh listings over time.
- The build guide specifies Create React App; this uses Vite, since CRA is deprecated and
  unmaintained.
