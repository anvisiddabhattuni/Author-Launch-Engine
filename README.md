# Author Launch Engine

Multi-agent platform that promotes an author's book — social content, outreach to podcasts and
events, and press materials for milestones — with a human approval gate in front of everything that
leaves the system.

Implemented so far:

- **STORY-001 — Draft and Schedule Social Media Content** (Content Drafting Agent), fulfilling `REQ-001`
- **STORY-002 — Identify and Draft Outreach Messages for Opportunities** (Opportunity Scouting Agent
  and PR & Outreach Agent), fulfilling `REQ-002`
- **STORY-003 — Draft PR Materials for Book Launch** (PR & Outreach Agent), fulfilling `REQ-003`
- **STORY-004 — Draft PR Materials for Book Anniversary** (PR & Outreach Agent), fulfilling `REQ-003`

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

### STORY-003 — press materials

| Story build step | Where it lives |
|---|---|
| 1. Backend module for PR draft generation | `server/src/agents/prMaterialsAgent.js` |
| 2. Drafts generated from milestones using the book's themes | `server/src/ai/prStubProvider.js`, `prAnthropicProvider.js` |
| 3. Drafts stored in PostgreSQL pending review | `server/src/db/migrations/003_pr_materials.sql` |
| 4. API to trigger generation and read draft status | `POST /api/milestones/:id/press-kit`, `GET /api/press-kits` |
| 5. React component to display status and allow review | `client/src/pages/PressPage.jsx` |

A **milestone** (launch, anniversary or award — the three REQ-003 names) triggers a **press kit** of
three materials: a press release, an author bio and a fact sheet. Distribution goes to a mocked
press list, and only to contacts whose beat matches one of the book's themes.

Press materials are a second capability of the same PR & Outreach Agent that owns STORY-002, kept in
its own module because a press release and a booking pitch share an owner but not a job.

### STORY-004 — anniversaries, and drafting before you ask

| Story build step | Where it lives |
|---|---|
| 1. PR generation extended to handle anniversaries | `server/src/ai/prStubProvider.js`, `prAnthropicProvider.js` |
| 2. Logic identifying *upcoming* anniversaries and drafting for them | `server/src/services/milestones.js`, `milestoneWatcher.js` |
| 3. Drafts stored pending review | unchanged — the same `pr_materials.status` path as STORY-003 |
| 4. API for anniversary generation and retrieval | `GET /api/authors/:id/milestones/approaching`, `POST .../draft-approaching` |
| 5. React component to display and review them | `client/src/pages/PressPage.jsx` — the *Approaching* card |

STORY-003 already drafted for anniversary milestones, so this story is really about the two things it
left out.

**A milestone has to be noticed.** STORY-003 drafted a kit when a person asked for one, which means
a forgotten date produced nothing. `findApproachingMilestones` returns milestones falling inside
`MILESTONE_LEAD_TIME_DAYS`, and `draftApproachingKits` drafts a kit for each one that lacks it. A
milestone already past is not approaching, and one beyond the window is not yet the agent's business.
Detection is audited (`milestone.approaching`) before drafting starts and separately from it, so a
provider failure cannot erase the fact that the milestone was seen.

**An anniversary has a number.** The copy was hardcoded to the first — "reaches its first
anniversary" — so a second or third would have gone to journalists factually wrong. `books.published_on`
makes the count derivable, and `anniversaryYears()` counts full calendar years, which is why it does
not round a date one day early up to the next year. When the publication date is unknown the copy
says "another year in print" rather than inventing one: a vaguer sentence is recoverable, a wrong
fact in a press release is not.

Drafting on detection changes *when* drafting starts and nothing about who decides. Every material
still lands `pending_approval`, and `distributePressKit` still refuses a kit the watcher produced.

Trust-Before-Intelligence controls required by all four stories:

- **Audit log** — every draft, opportunity, material, decision, schedule, publish, send and
  distribution is appended to `audit_log`. Append-only is enforced by database triggers, so
  `UPDATE`, `DELETE` and `TRUNCATE` are all rejected even from a direct `psql` session.
- **Approval gate** — `scheduleDraft` refuses any social draft not in `approved` status,
  `sendOutreachMessage` refuses any email that is not approved, and `distributePressKit` refuses
  unless **every** material in the kit is approved. All three refusals are audited.
- **Escalation** — drafts and messages scoring below `CONFIDENCE_ESCALATION_THRESHOLD` are marked
  `escalated` instead of entering the normal queue. Press materials escalate on that threshold *or*
  on falling below `MIN_THEME_ALIGNMENT`, whichever trips first.

Social drafts, outreach messages and press materials share one `approvals` table, so the gate
behaves identically for all three. Nullable foreign keys with an exactly-one check constraint keep
referential integrity that a polymorphic `entity_id` column would lose; adding the third target cost
one column and one name in the constraint.

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
schedule, Opportunities, Outreach, Press, Audit log.

## Demo in one command

```bash
npm run db:reset && npm run demo
```

Prints 25 stages with evidence at each one.

- **Stages 1–8, STORY-001:** inputs, generated drafts with confidence scores, the weekly cadence
  check, the approval gate refusing an unapproved draft, optimal-time scheduling, mocked publishing,
  the audit trail and the append-only rejection.
- **Stages 9–14, STORY-002:** the directory scan with relevance scores and rejections, the monthly
  cadence check, personalized outreach drafts, the send gate refusing an unapproved message,
  approval and mocked sending, and the outreach audit trail.
- **Stages 15–20, STORY-003:** the scheduled milestones, a press kit drafted on request with
  theme-alignment scores, the launch press release in full, the distribution gate refusing both a
  wholly unapproved kit and a partially approved one, distribution to the matching press contacts
  only, and the press audit trail.
- **Stages 21–25, STORY-004:** the lead-time window with one milestone inside it and one beyond, the
  agent drafting the approaching anniversary without being asked, the release stating which
  anniversary it is, the distribution gate refusing the kit the watcher just drafted, and the
  detection audit trail.

Stage 16 deliberately leaves the anniversary alone so stage 22 has something to find: STORY-003
drafts when a person asks, STORY-004 drafts when the date approaches.

## Tests

```bash
npm run db:reset && npm test
```

109 tests across 24 suites. For each story the leading suites map one-to-one onto its Gherkin
scenarios; the rest cover the approval gate, escalation and the append-only log. `routes.test.js`
drives the API over HTTP, which is the only way to catch a query a route assembles itself.

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
| `MIN_THEME_ALIGNMENT` | `0.5` | Below this share of the book's themes, a press material escalates |
| `MILESTONE_LEAD_TIME_DAYS` | `30` | How far ahead a milestone counts as approaching, and drafting begins |

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
- **Press materials** (`scoreMaterial`) — theme alignment 45%, completeness 25%, grounding in the
  book's own language 15%, voice 15%. Alignment dominates because it is REQ-003's acceptance
  criterion, and it is also stored in its own `theme_alignment` column so the criterion can be
  checked directly rather than inferred from a blended score.

Two scores are never a model call at all, because both decide what reaches a human and so have to be
reproducible. Opportunity relevance (`scoreOpportunity`) weights having any strong theme match (55%)
above breadth across themes (30%) and loose vocabulary overlap (15%). Theme alignment
(`themeAlignment`) counts only themes appearing verbatim, and the themes recorded against a material
are the verified matches rather than the provider's own claim about what it used.

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
| `GET` | `/api/authors/:id/milestones` | List milestones, whether each has a kit, and which anniversary it is |
| `GET` | `/api/authors/:id/milestones/approaching` | Milestones inside the lead-time window, soonest first |
| `POST` | `/api/authors/:id/milestones/draft-approaching` | Draft a kit for every approaching milestone missing one |
| `POST` | `/api/authors/:id/books/:bookId/milestones` | Schedule a launch, anniversary or award |
| `POST` | `/api/milestones/:id/press-kit` | Draft the three press materials for a milestone |
| `GET` | `/api/press-kits?authorId=` | Kits with their materials, scores and distributions |
| `POST` | `/api/pr-materials/:id/approve` · `/reject` | Record a human decision |
| `POST` | `/api/press-kits/:id/distribute` | Distribute to matching press contacts (mocked) |
| `GET` | `/api/press-contacts` | The mocked press list with beats |
| `GET` | `/api/audit-log?authorId=` | Read the append-only log |

## Known gaps

These are deliberate deferrals, not oversights:

- Authentication and role-based access control are not implemented; the UI acts as the first author
  in the database. Auth belongs to the walking-skeleton stories in the Build Guide.
- Per-tenant isolation is by `author_id` column filtering, not the separate-schema-per-tenant model
  the requirements describe.
- Publishing, outreach sending and press distribution are triggered on demand rather than by a
  background worker. STORY-004 added the *detection* a worker would call
  (`draftApproachingKits`), but something still has to call it — the UI button, the demo, or a cron
  entry. Nothing runs on a timer yet.
- Social platform, directory, email and press-list adapters are all mocked; no live credentials are
  involved.
- Directory listings are a fixed catalogue, so a monthly rescan finds nothing new. A live adapter
  would return fresh listings over time.
- Milestones are still seeded or entered by hand. STORY-004 detects an approaching one and drafts for
  it, but nothing generates the milestone itself — an anniversary does not recur onto next year's
  calendar on its own.
- A press kit is distributed as one email per contact. Real newsroom workflows expect attachments
  and an embargo date, neither of which the mocked provider models.
- The build guide specifies Create React App; this uses Vite, since CRA is deprecated and
  unmaintained.
