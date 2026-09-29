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
- **STORY-005 — Draft PR Materials for Book Awards** (PR & Outreach Agent), fulfilling `REQ-003`
- **STORY-006 — Align PR Drafts with the Book's Themes** (AI Content Generation Agent), fulfilling `REQ-003`
- **STORY-007 — Human Review of PR Drafts** (Approval and Notification Agent), fulfilling `REQ-003` and `REQ-006`
- **STORY-064 — Login and Basic Permissions** (Coordination and Governance Agent), fulfilling `REQ-005`
- **STORY-065 — Background Worker and Scheduler** (Infrastructure and Deployment Agent), fulfilling `REQ-004`
- **STORY-008 — Escalation of Low-Confidence PR Drafts** (Trust and Monitoring Agent), fulfilling `REQ-003`
- **STORY-009 — Content Drafting Agent Creates Social Media Posts** (Content Drafting Agent), fulfilling `REQ-001` and `REQ-004`
- **STORY-010 — PR and Outreach Agent Identifies Speaking Opportunities** (PR and Outreach Agent), fulfilling `REQ-002` and `REQ-004`
- **STORY-011 — Coordination and Governance Agent Manages Agent Tasks** (Coordination and Governance Agent), fulfilling `REQ-003` and `REQ-004`
- **STORY-066 — Generate Meme Content for Social Platforms** (AI Content Generation Agent), fulfilling `REQ-001`
- **STORY-067 — Meme Template Library** (AI Content Generation Agent), fulfilling `REQ-001`
- **STORY-068 — Book Visual Identity Guide** (AI Content Generation Agent), fulfilling `REQ-001`
- **STORY-069 — Meme vs Text Performance Tracking** (Trust and Monitoring Agent), fulfilling `REQ-001`
- **STORY-012 — Approval and Notification Agent Handles Approvals** (Approval and Notification Agent), fulfilling `REQ-005` and `REQ-004`
- **STORY-013 — Audit and Security Agent Logs All Actions** (Audit and Security Agent), fulfilling `REQ-006` and `REQ-004`
- **STORY-014 — Trust and Monitoring Agent Provides a Trust Dashboard** (Trust and Monitoring Agent), fulfilling `REQ-007` and `REQ-004`
- **STORY-015 — Infrastructure and Deployment Agent Manages Deployment** (Infrastructure and Deployment Agent), fulfilling `REQ-008` and `REQ-004` — **partially; see below**
- **STORY-016 — API Integration Agent Interfaces with External APIs** (API Integration Agent), fulfilling `REQ-009` and `REQ-004`
- **STORY-017 — Tenant Management Agent Manages Multi-Tenancy** (Tenant Management Agent), fulfilling `REQ-010` and `REQ-004`
- **STORY-018 — AI Content Generation Agent Generates PR Materials** (AI Content Generation Agent), fulfilling `REQ-011` and `REQ-004`
- **STORY-019 — Implement Append-Only Audit Log** (Audit and Security Agent), fulfilling `REQ-005` — **the access control and completeness half; see below**
- **STORY-020 — Establish Approval Gates for Outbound Communications** (Approval and Notification Agent), fulfilling `REQ-006`
- **STORY-021 — Develop a Trust Dashboard for Monitoring** (Trust and Monitoring Agent), fulfilling `REQ-007` — **the history and alerting half; see below**
- **STORY-022 — Implement Role-Based Access Control (RBAC)** (Coordination and Governance Agent), fulfilling `REQ-005` and `REQ-006`
- **STORY-023 — Create AI Content Generation Agent** (AI Content Generation Agent), fulfilling `REQ-006`
- **STORY-024 — Enable Multi-Tenant Isolation** (Tenant Management Agent), fulfilling `REQ-005`
- **STORY-025 — Integrate with Social Media Platforms** (API Integration Agent), fulfilling `REQ-006` — **the error-handling half; OAuth deferred, see below**
- **STORY-026 — Escalate Low-Confidence Content to Human Review** (Coordination and Governance Agent), fulfilling `REQ-006`
- **STORY-027 — Monitor System Health and Availability** (Infrastructure and Deployment Agent), fulfilling `REQ-007` — **no Prometheus, no PagerDuty; see below**
- **STORY-029 — Implement Content Performance Metrics** (Trust and Monitoring Agent), fulfilling `REQ-007` — **over mocked engagement; see below**
- **STORY-031 — Frontend Architecture Setup** (Frontend Development Agent), fulfilling `REQ-001`, `REQ-002` and `REQ-008` — **the trust controls, not a Next.js rewrite; see below**
- **STORY-032 — Backend Architecture Setup** (Backend Development Agent), fulfilling `REQ-003`, `REQ-004` and `REQ-008` — **input validation on every route; see below**
- **STORY-033 — Database Architecture Setup** (Database Administration Agent), fulfilling `REQ-005`, `REQ-006` and `REQ-008` — **roles in the database, not Sequelize; see below**
- **STORY-034 — Deployment Architecture Setup** (DevOps Agent), fulfilling `REQ-007` and `REQ-008` — **partially: images still unbuilt and unscanned; see below**
- **STORY-038 — API Gateway for Managing and Monitoring Integrations** (API Integration Agent), fulfilling `REQ-009` and `REQ-014` — **in-process, not Kong; see below**
- **STORY-039 — Message Queue System for Agent Communication** (Coordination and Governance Agent), fulfilling `REQ-010` — **Postgres outbox; RabbitMQ in CI only; see below**
- **STORY-040 — Central Task Manager for Agent Coordination** (Coordination and Governance Agent), fulfilling `REQ-010`
- **STORY-041 — Tenant Database Schema Isolation** (Infrastructure and Deployment Agent), fulfilling `REQ-011` — **schemas of views, not copied tables; see below**
- **STORY-042 — Tenant-Specific Access Control** (Coordination and Governance Agent), fulfilling `REQ-011`
- **STORY-043 — Tenant Onboarding Process** (Tenant Management Agent), fulfilling `REQ-011` — **by invitation: the admin never sets the author's password**
- **STORY-044 — Tenant Data Access Audit** (Audit and Security Agent), fulfilling `REQ-011` — **every request that touches tenant data, not only changes**
- **STORY-045 — Tenant-Specific API Key Management** (API Integration Agent), fulfilling `REQ-011` — **keys stored as hashes, confined to one tenant, never able to approve**
- **STORY-046 — Fine-Tune AI Models on Book-Specific Data** (AI Content Generation Agent), fulfilling `REQ-012` — **a fitted, evaluated model of each book, since Claude cannot be fine-tuned via the API**
- **STORY-047 — Review Generated Content for Thematic Alignment** (Approval and Notification Agent), fulfilling `REQ-012` — **compared with the book's themes and style; reviewers can request changes**
- **STORY-048 — Establish a Feedback Loop for Content Improvement** (Trust and Monitoring Agent), fulfilling `REQ-012` — **reviewer decisions and ratings refit the book's model; bounded and versioned**
- **STORY-049 — Encrypt Audit Logs with AES-256** (Audit and Security Agent), fulfilling `REQ-013` — **in the storage, so STORY-019's three objections no longer hold; see below**
- **STORY-050 — Implement Role-Based Access Control for Audit Logs** (Audit and Security Agent), fulfilling `REQ-013` — **every audit route declared with its permission, and the router held to it**
- **STORY-051 — Audit Log Access Monitoring** (Trust and Monitoring Agent), fulfilling `REQ-013` — **a separate, encrypted, reviewer-only security log of every attempt**
- **STORY-052 — Audit Log Access Notification** (Approval and Notification Agent), fulfilling `REQ-013` — **security officers told at once, a burst folded into one alert**
- **STORY-028 — Provide Detailed Audit Log Reports** (Audit and Security Agent), fulfilling `REQ-005` — **built after STORY-053; it had been skipped**
- **STORY-030 — Deploy System to Public Demo URL** (Infrastructure and Deployment Agent), fulfilling `REQ-007` — **ready to deploy and checked; not deployed — it needs a server and domain only the project owner can provide**
- **STORY-053 — CI/CD Pipeline with Automated Testing and Security Checks** (Infrastructure and Deployment Agent), fulfilling `REQ-014` — **CI had run once and failed unnoticed; now three test tiers, a ZAP scan, and `npm run ci:local`**
- **STORY-054 — Deploy Application Using Kubernetes with Role-Based Access Control** (Infrastructure and Deployment Agent), fulfilling `REQ-014` — **a Helm chart, run on a local k3s cluster: scaling, load balancing, self-healing and RBAC shown working; not on a cloud cluster**
- **STORY-055 — Implement Data Aggregation for Trust Dashboard** (Trust and Monitoring Agent), fulfilling `REQ-015`, `REQ-001` and `REQ-002` — **Elasticsearch, filled by the worker rather than Logstash; the encrypted part of the log is never copied; live checks written for CI, not yet run**
- **STORY-056 — Develop Visualization for Trust Dashboard** (Trust and Monitoring Agent), fulfilling `REQ-015` and `REQ-003` — **a provisioned Grafana dashboard; verified in CI, not on this machine — not yet run**
- **STORY-057 — Integrate Approval and Notification System** (Trust and Monitoring Agent), fulfilling `REQ-015` and `REQ-004`
- **STORY-058 — Implement Governance Score Calculation** (Trust and Monitoring Agent), fulfilling `REQ-015` and `REQ-005` — **a formula over what the system did, capped when an invariant is broken**

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

### STORY-005 — awards, and not guessing the result

| Story build step | Where it lives |
|---|---|
| 1. PR generation includes book awards as a trigger | `server/src/ai/prStubProvider.js`, `prAnthropicProvider.js` |
| 2. Award detection: a recorded *win* drafts; a past ceremony with no result waits | `server/src/services/awards.js`, `awardOutcome.js` |
| 3. Drafts stored pending review | unchanged — the same `pr_materials.status` path as STORY-003 |
| 4. API for award generation and retrieval | `GET /api/authors/:id/awards/awaiting-outcome`, `POST /api/milestones/:id/award-outcome` |
| 5. React interface for award drafts and review | `client/src/pages/PressPage.jsx` — the *Awards awaiting a result* card |

STORY-003 already drafted for award milestones, so this story is the distinction it collapsed.

**A win and a shortlisting are different news.** The copy always said "has been shortlisted", and the
prize name was scraped out of the title with a regex. `milestones.outcome` (`shortlisted` / `won` /
`not_won`) and `milestones.award_name` make both facts data. Recording a win is the trigger the
acceptance criterion names: the agent drafts, still into the approval gate. Recording a loss drafts
nothing — a loss is not announced, and that decision is audited so an empty log cannot look like a
system that failed to notice.

**The system will not guess.** An award whose ceremony has passed, still marked shortlisted, is listed
as awaiting a result. Guessing either way puts a false claim in front of a journalist.

**Winning withdraws the shortlist copy.** A real author gets both announcements, so a milestone may
hold more than one kit. The shortlist kit is superseded rather than deleted, and neither a superseded
kit nor an unreviewed win kit can be distributed — even if the shortlist had already been approved.

Trust-Before-Intelligence controls required by all ten stories:

- **Audit log** — every draft, opportunity, material, decision, schedule, publish, send and
  distribution is appended to `audit_log`. Append-only is enforced by database triggers, so
  `UPDATE`, `DELETE` and `TRUNCATE` are all rejected even from a direct `psql` session.
- **Approval gate** — `scheduleDraft` refuses any social draft not in `approved` status,
  `sendOutreachMessage` refuses any email that is not approved, and `distributePressKit` refuses
  unless **every** material in the kit is approved. All three refusals are audited.
- **Escalation** — drafts and messages scoring below `CONFIDENCE_ESCALATION_THRESHOLD` are marked
  `escalated` instead of entering the normal queue. Press materials escalate on that threshold *or*
  on falling below `MIN_THEME_ALIGNMENT`, whichever trips first. Social drafts add a third floor,
  `MIN_VOICE_MATCH`, measured against the author's own previous posts — copy that argues the book's
  themes perfectly in a voice the author has never used still reaches a human.
- **Escalation is checked by something other than its author** — `escalation.raised` when the monitor
  catches what a producer let through, `escalation.producer_stricter` when it disagrees the other way
  and leaves the concern standing, `trust.scan_completed` so a scan that found nothing is still
  visible. The monitor can raise and never clear.
- **Every scheduled run is on the log** — `job.succeeded`, `job.retrying`, `job.dead_lettered`,
  `job.reclaimed` and `job.retried_by_human`. A dead letter carries `needsHuman: true`, because it is
  the row a person is meant to find. Nothing that fails is dropped.
- **Every approval names a person** — `approvals.user_id` points at the authenticated account and
  the audit log carries `userId`, `role` and `attributable`. Before STORY-064 the log recorded a name
  somebody typed; it now records who the server authenticated.
- **Reviewers are told, and that is logged too** — `review.notified` records who was mailed about
  which kit and how much was waiting; `review.no_reviewers` records a queue nobody was asked to look
  at; `review.notification_failed` records a delivery that did not land. The notifier cannot move
  anything through the gate.
- **Grounding is audited** — `pr_kit.themes_retrieved` records what the drafter was handed before it
  wrote anything, and `pr_material.aligned` records what each finished material was checked against,
  both under the AI Content Generation Agent. A kit whose copy reads well but was grounded in zero
  passages is visible as such.

Social drafts, outreach messages and press materials share one `approvals` table, so the gate
behaves identically for all three. Nullable foreign keys with an exactly-one check constraint keep
referential integrity that a polymorphic `entity_id` column would lose; adding the third target cost
one column and one name in the constraint.

### STORY-006 — aligning a draft, not just grading one

| Story build step | Where it lives |
|---|---|
| 1. Theme alignment function in the AI Content Generation Agent | `server/src/agents/contentAlignmentAgent.js` |
| 2. RAG grounding drafts in the book's themes in PostgreSQL | `server/src/services/themeRetrieval.js`, `006_theme_grounding.sql` |
| 3. Alignment as part of the draft generation pipeline | `draftPressKit` — retrieve → draft → verify |
| 4. API for theme alignment status | `GET /api/books/:id/themes`, per-theme rows on `GET /api/press-kits` |
| 5. React component showing alignment status | `client/src/pages/PressPage.jsx` — the grounding card and per-theme pills |

STORY-003 already scored theme alignment, so this story is the two things that score could not do.

**Alignment now happens before the copy exists.** The old pipeline was generate-then-grade: nothing
made a draft aligned, it only measured one and escalated if it was off. Now the agent retrieves what
the book argues about each theme first, the drafter writes from those passages, and the *same*
evidence is used to check what came back. Retrieval is Postgres full-text search over `book_passages`
rather than embeddings, because the retrieved passage decides what the drafter is told and so has to
be reproducible and readable — and because the stub provider has to keep working with no network.

**Naming a theme is no longer the same as arguing it.** The verbatim check gave a perfect 1.00 to
copy that repeated "deep work, craft, attention, resilience" and made none of the book's arguments.
Each theme is now judged twice — was it *named*, and did the draft carry its *key message* — and
naming alone is worth 0.40, deliberately below the 0.50 escalation floor. That same copy now scores
0.475 and escalates. Demo stage 34 prints both numbers side by side.

Message credit requires the name: a draft that never mentions a theme cannot be reflecting its key
message, which is what keeps genuinely off-message copy at exactly zero. And the theme's own words
are excluded from what counts as its argument, so repeating the label earns nothing.

**What a theme claims is data.** `book_themes.key_message` holds the sentence a draft has to reflect;
`books.themes` stays as the author's list of labels. Both the theme rows and the retrieval passages
are derived by a trigger on `books`, because books are written from the seed, the API and the tests,
and a retrieval corpus that existed on only one of those paths would silently cost the drafter its
grounding. A theme with no key message falls back to the retrieved passage; a theme the book never
argues is reported as ungrounded rather than dropped.

### STORY-007 — a gate that tells someone it is holding something

| Story build step | Where it lives |
|---|---|
| 1. React review interface | already built by STORY-003 — `client/src/pages/PressPage.jsx` |
| 2. Approve/reject actions in the backend | already built — `server/src/services/approvals.js` |
| 3. Decisions in PostgreSQL with audit trail | already built — `approvals` + `audit_log` |
| 4. API for review actions and status | already built — `POST /api/pr-materials/:id/approve` · `/reject` |
| 5. **Notify reviewers of pending drafts** | `server/src/services/reviewNotifier.js`, `007_review_notifications.sql` |

Four of five build steps and the whole Gherkin scenario were already shipped. `grep -ri notif` over
the repo returned nothing, and notification is half of REQ-006's acceptance criteria: *"the approval
process includes notifications to relevant stakeholders and is logged for traceability."*

**The obstacle was that there was nobody to notify.** No login, no RBAC — a "reviewer" was a name
typed into a text box at the moment of deciding, so the system learned who reviewed something only
after they had already done it. `reviewers` makes that an address book: name, email, role, active.
It is deliberately **not** an access list — nothing in it decides what anyone may approve, and
`approvals.reviewer` is still free text recording who actually decided. Knowing who to *tell* is a
different fact from knowing who someone *is*, and only the first is needed to stop a draft sitting
unread. Login and RBAC stay a named gap rather than being smuggled in here.

**Silence is not success.** Materials waiting with no reviewer configured writes `review.no_reviewers`
to the log — the same instinct as STORY-005 recording that a loss produced no material. An empty
notification run must not read like a system with nothing to report.

**One nudge per reviewer per kit,** enforced by a unique constraint rather than a check-then-insert
two workers could both pass. `notifyPendingReviews` is safe to re-run and is meant to be: it is what
a scheduled worker would call, the same shape as STORY-004's `draftApproachingKits`, and an alert
that repeats on every tick is one people learn to ignore — which spends the exact attention the
approval gate exists to spend.

**Notifying is not deciding.** The agent can read the queue and mail a person about it; it cannot
approve, reject or send. A test asserts every status is exactly as it was found after a notification
run. The mail also describes the kit by *what it announces* rather than by the milestone title — a
won award keeps the title it was scheduled under ("shortlisted for X"), so using that title would
have described the win kit as the shortlist one.

### STORY-064 — the identity everything else assumed

| Story build step | Where it lives |
|---|---|
| 1. JWT auth on the Express API | `server/src/services/auth.js`, `server/src/middleware/auth.js` |
| 2. Minimal roles table + middleware check | `roles` (`author`, `admin`) — `008_auth.sql`, `requireRole` |
| 3. Approval endpoints bound to the signed-in user | `approvals.user_id`, `decide({ user })` |
| 4. React login screen and session handling | `client/src/pages/LoginPage.jsx`, `client/src/api.js` |
| 5. Approver identity stamped into the audit log | `metadata.userId` / `role` / `attributable` |

Every story before this one assumed an identity the system never had. The masthead rendered
**"Signed in as …"** over `authors[0]`. Approvals recorded a name typed into a text box, so the log
held a *claim* about who decided. Every list route took its tenant from a query parameter the caller
supplied — changing a number in the URL read another author's work.

**Deliberately thin.** Two roles, one session, one tenant boundary. No per-resource permissions,
no password reset, no signup; full RBAC stays STORY-022 in R5.

**Identity comes from the session, never the request body.** A test posts
`{"reviewer": "Somebody Else Entirely"}` alongside a valid token and asserts the approval records the
token's owner. Demo stage 45 does the same thing in the open.

**A decision with no session behind it is marked, not hidden.** Internal callers — the demo, a test —
reach the services directly and can still approve; the audit log records `attributable: false` so
those decisions cannot be mistaken for ones a real person stands behind. Demo stage 46 shows both
kinds side by side.

**Passwords** use `node:crypto` scrypt with per-user salts, stored as `scrypt$N$r$p$salt$hash` so the
work factors travel with the hash and can be raised without invalidating existing rows. Comparison is
`timingSafeEqual`. A wrong password and an unknown email return the same error, so the endpoint cannot
enumerate accounts — the difference is recorded on the log, where an operator can see it and a caller
cannot.

**Tokens** are `jsonwebtoken` rather than hand-rolled, and verification **pins the algorithm**. A test
forges an `alg: none` token — the classic JWT bypass — and asserts it is refused, along with a token
signed by the wrong secret and an expired one.

> **The bug this story shipped and then fixed.** The tenant check first lived entirely in router-level
> middleware, reading `req.params.authorId`. Express does not populate `req.params` until it has
> matched a route, so that value was always `undefined` and the check passed everything:
> `GET /authors/2/books` returned **200** for the wrong tenant. Path tenants now hang off
> `router.param('authorId')`, which fires once the value exists. Three tests cover the three shapes —
> tenant in the path, tenant in the query string, and a bare resource id that names no tenant at all
> and has to be read off the row.

### STORY-065 — the caller those functions were waiting for

| Story build step | Where it lives |
|---|---|
| 1. Queue/worker process | `server/src/jobs/worker.js` — `npm run worker` |
| 2. Jobs table: status, attempts, idempotency key, next run | `009_jobs.sql` |
| 3. Existing publish and send paths behind it | `server/src/jobs/handlers.js` |
| 4. Capped retries with backoff, then a human | `server/src/jobs/queue.js` |
| 5. Run health in the admin view | `client/src/pages/WorkerPage.jsx`, `GET /api/jobs` |

Four functions had been written as "what a cron would call" and nothing called them: `publishDue`
(001), `sendOutreachMessage` (002), `draftApproachingKits` (004) and `notifyPendingReviews` (007).
The platform could do all of its work and could not do any of it unattended.

**One table, one loop, one `kind` column.** Recurring sweeps and one-off sends are the same row shape
deliberately — a sweep that fails needs attempts, backoff and a dead-letter exactly as much as a send
does, and a health view that only knew about half the work would be worse than none.

**The worker is its own process.** Run inside the API it would die with every restart and double-run
every job the moment a second API instance existed. Polling Postgres means the database *is* the
queue: `SELECT … FOR UPDATE SKIP LOCKED` lets two workers run safely, and `tick()` stays a plain
function the tests call directly rather than a timer they wait on.

**"Every five minutes" means once per five minutes, not once per tick.** A recurring job's
idempotency key buckets the current time into its sweep window, so every worker on every poll
computes the same key and the unique constraint keeps the second one out.

**Attempts increment on claim, not on failure.** A job that kills its worker never reaches a failure
handler; counted on claim it still exhausts its retries and reaches a person instead of looping
forever. A stale claim is reaped back into the queue with the attempt already spent.

**The worker cannot approve anything.** It has no session and cannot get one (STORY-064) — it acts on
work a human already approved, and the gate has lived in the service since STORY-001 precisely so a
new caller like this cannot route around it. A test asserts an unapproved draft is still unapproved
after a full cycle.

> **What the flaky tests were actually telling me.** The suite failed roughly one run in six. Two of
> the causes were test bugs — one test claiming another's job, and a window that could straddle a
> boundary. The third was real: `ensureRecurringJobs` read the author list and then inserted a job per
> author, so an author deleted in between failed the whole sweep, taking every other tenant's work
> down with it. Making it one `INSERT … SELECT … FOR SHARE` fixed the flake *and* the bug. Ten
> consecutive green runs before calling it done.

### STORY-008 — who checks the agent that grades its own work?

| Story build step | Where it lives |
|---|---|
| 1. Confidence scoring | already built by STORY-003 — `scoreMaterial` |
| 2. Escalation logic in a Trust and Monitoring Agent | `server/src/agents/trustMonitoringAgent.js` |
| 3. Escalation actions in PostgreSQL with audit trail | `010_escalations.sql`, `escalation.*` audit actions |
| 4. API for escalations, and notify users | `GET /api/authors/:id/escalations`, `notifyRaisedEscalations` |
| 5. React component for escalated drafts and review | `client/src/pages/PressPage.jsx` — the *Escalated* card |

Escalation already worked: a material below the confidence threshold or the theme-alignment floor
landed `escalated` and waited for a human. What did not exist was the agent the story names.

**The producer was the only judge of its own output.** Three agents each carried their own copy of
`confidence < threshold ? 'escalated' : 'pending_approval'`, inside the very thing being judged.
That is the same objection this project already raised to letting a model score itself, one level up
at the agent layer — and it has a concrete failure mode: a producer whose check was wrong, missing,
or written against a policy that has since changed would never have been caught by anything.

**Policy moved to one place** (`escalationPolicy.js`) for all three producers — three copies of a
rule is three chances for it to drift. It is a pure function of the stored scores, which is exactly
what makes an independent re-derivation possible.

**The monitor re-derives rather than re-reports.** It reads what was written, recomputes the decision
from the stored scores and the policy in force, and escalates anything the producer let through. It
runs as a recurring job on the STORY-065 worker, so a floor raised today catches drafts written
yesterday that are still unapproved — something a draft-time check can never do. Demo stage 54 shows
exactly that.

**It raises and never clears.** When the producer escalated something current policy would not, the
monitor records the disagreement and leaves it escalated. A monitor that can withdraw its own
findings is one that can be wrong in the direction that matters. Demo stage 55 drops the floor back
down and shows nothing being withdrawn.

**It does not overrule a human.** Only `pending_approval` and `escalated` material is examined —
anything approved, rejected or distributed has had its human moment, and superseded kits are skipped
because nobody can act on them anyway.

**The queue is a read-model, not a second state.** Whether an escalation is open is read from the
material's own status, so approving something closes its escalation with no copy of the state to
keep in step.

> **A test that failed one run in three, twice, for two different reasons.** The first was my own
> fixture: an author bio's confidence sits near the default threshold and moves with the milestone
> id, so "the producer queued this as fine" was true only most of the time — the precondition is now
> constructed rather than hoped for. The second was real coupling this story introduced: the new
> recurring job sweeps *every* author, so the worker suite's `tick()` was legitimately notifying the
> escalation suite's reviewers first. Correct in production, wrong to assert against — the test now
> checks that the reviewer was told, not that a particular line did the telling.

### STORY-009 — the inputs it already had, and never used

| Story build step | Where it lives |
|---|---|
| 1. Content Drafting Agent module | already built by STORY-001 — `server/src/agents/contentDraftingAgent.js` |
| 2. Retrieve the book's themes and previous posts | `themeRetrieval.js` (STORY-006), `services/voiceProfile.js` |
| 3. Generate a draft from an AI provider | `ai/stubProvider.js`, `ai/anthropicProvider.js` — now written *from* the retrieved evidence |
| 4. Store the draft for review | `011_social_grounding.sql` — `draft_themes`, `drafts.theme_alignment`, `drafts.voice_score` |
| 5. Audit log for each draft action | `social.themes_retrieved`, `social.voice_derived` |

STORY-001 already drafted social posts, so this story is the clause it did not honour. The Gherkin
is *"Given the agent has access to the book's themes and previous posts … Then the agent drafts a
post that aligns with the book's themes and the author's voice."* The agent had access to both. It
passed them to the provider, which ignored them, and then graded itself on how well it had used
them.

**Both grades were unfailable.** `grounding` asked whether a theme *label* was reused — the same
verbatim check STORY-006 had already replaced for press materials. `voice` measured vocabulary
overlap with the author's prior posts, which any text about the same book shares. The author's
profile said to avoid exclamation marks and growth-hacking language; nothing checked it. Copy
breaking every one of those rules scored **0.893** and queued as one of the best drafts in the
system. Demo stage 60 scores that same copy both ways: 0.893 then, 0.56 and escalated now.

**And the old grounding score could be raised by lying about it.** `themesUsed` — the drafter's own
claim about which themes it used — was concatenated onto the text before that text was scored for
theme reuse. The same hype copy claiming all four themes scores **0.994** rather than 0.893, the
gain coming entirely from claiming `deep work` and `resilience`, neither of which it mentions. The
measure paid out for the assertion, not the writing. `themes_used` is now the verified matches, and
a claimed-but-unnamed theme scores zero.

This is STORY-006's finding at the other end of the pipeline, so it gets STORY-006's answer.

**Posts are written from retrieved passages.** The stub provider used to assemble copy from a theme
label and a sentence picked at random out of the whole book. It now writes from the theme's key
message and the passages that evidence it — the same retrieval the press drafter has used since
STORY-006, reached through the same agent (`groundInBookThemes`, generalised from `pr_kit` to any
entity). A theme the book never argues still yields no claim rather than an invented one.

**Voice is derived, not described.** `social_history` has said since `001_init` that it exists "to
derive the voice profile"; nothing ever derived one. `voiceProfile.js` counts traits off the
author's real posts — sentence length, exclamations, hype and shouting per 100 words, distinctive
vocabulary — and holds the draft to those counts. The hand-written `authors.voice_profile` is kept
but demoted to a cross-check, so a claim the writing does not support is reported as *asserted*
rather than treated as a rule. What the author writes outranks what the author says they write.

**Voice is its own floor.** The hype draft scores 0.717 on blended confidence — above the 0.7
threshold. Only a separate `MIN_VOICE_MATCH` catches it. Folding voice into confidence would let a
post buy its way past the gate with themes and formatting, and REQ-001 asks for the author's voice
specifically.

**A post is judged on the themes it raises, not on all four.** A press release announces a whole
book; a tweet makes one point. Holding a tweet to four themes would escalate every good short post.
So alignment is measured over the themes the post *names*, plus any the provider claimed and did not
name — those score zero, which is what makes `themes_used` a claim the system checks rather than a
label it repeats. A theme the book does not have is flagged `known = false` and earns nothing.

**Two false positives worth naming, because both inflated the score.** The book is called *The Quiet
Craft*, so every post citing the title was credited with naming `craft` and then scored on arguing a
theme it had never raised; exact occurrences of the title are now excluded from naming. And the
book's passages discuss its themes together, which made "attention" one of craft's own evidence
words — so copy name-checking four themes argued each one by naming the other three. Every theme
label is now excluded from every theme's evidence. Naming a theme is not arguing it, and that has to
hold sideways as well as directly.

**The bar scales with the post, not the platform.** A 240-character post cannot carry eight of the
book's words whatever platform it is on, and Instagram's 2,200-character limit says nothing about a
three-line caption. `termTargetFor` reads the post's own length. It is also the version that cannot
be gamed: padding raises the target faster than it raises the count.

> **The same question, asked one layer further in.** STORY-008 asked who checks the agent that
> grades its own work. This story is the version of that question aimed at the *inputs*: an agent
> can be handed exactly the right evidence, ignore it, and still report that it used it well —
> because the report and the work come from the same place. **"Was it given the right inputs?" and
> "did it use them?" are two different questions, and only the second one needs a check that the
> producer cannot write.**

### STORY-010 — the lead that wanted an author, not a subject

| Story build step | Where it lives |
|---|---|
| 1. Interface with event and speaker directories | already built by STORY-002 — `services/directories.js`, now filterable by type |
| 2. Find relevant speaking opportunities | `services/authorExpertise.js` — the half that modelled the author |
| 3. Store results in PostgreSQL for review | `012_speaking_expertise.sql` — `opportunities.expertise`, `opportunity_rejections` |
| 4. Approval gate before any outreach | already built by STORY-002 — `sendOutreachMessage` refuses an unapproved message |
| 5. React view of the queue | `client/src/pages/OpportunitiesPage.jsx` |

STORY-002 already scanned the directories, so this story is the clause it did not honour: opportunities
aligned with the book's themes *and the author's expertise*. Relevance was scored against exactly one
thing — whether a listing's topics repeated one of the four theme labels on the book being promoted.
The word "expertise" appeared nowhere in the codebase.

**It was hiding a real lead, silently.** `Library Author Nights — evening talks where authors discuss
their books with local reading groups` scores **0.000** against *deep work, craft, attention,
resilience*. It is an ideal speaking slot for an author. It simply never repeats a theme, because it
is not asking for a lecture on the book's subject — it is asking for an author. The system had no way
to represent that an author is what we have. Demo stage 65 scores that listing both ways.

**Expertise is split in two, because the domain is.** *Subjects* — what this author can credibly
speak about — is derived from every book they have written and what they actually post about, which
is wider than one book's four labels. *Standing* — what the author **is** — qualifies them for author
talks, panels, readings and lecture series regardless of subject. A track record of engagements
already approved adds the formats they have actually done. Derived from evidence rather than typed
into a field, for the same reason voice is (STORY-009): a self-description cannot fail, and this
score decides what a human is never shown.

**A lead qualifies on either test, and the row says which.** The acceptance criterion says themes
*and* expertise, and the strict reading — requiring both — would have rejected Library Author Nights,
the one lead this story exists to find. The story's own reason for being settles it: *"so that I can
expand the author's reach."* Expertise that could only narrow the queue would expand nothing. So both
are scored, either can qualify, and `qualified_by` records the answer to "why is this in my queue".

**It opens no floodgate.** The four genuinely off-topic listings — a fundraising podcast, a
restaurant show, a freight expo, a protocol meetup — score **0.000 on expertise too**. Exactly one
lead is recovered, and there is a test pinning that. A second test that qualified everything would be
no test at all, which is why `opportunity.scan_completed` now logs `byQualification`: a dimension that
never qualifies anything should be visible as a dead test rather than trusted as a strict one.

**And the filter now keeps a record of what it hid.** STORY-002 counted rejections and threw the
listings away — the audit log said `rejected: 5` and nothing else. That left the one part of the scan
nobody could check as the part deciding what a human would never see: an identified lead is visible
and can be judged wrong, but a lead dropped for a bad reason leaves no trace to notice. Library Author
Nights was invisible for four stories on exactly that basis. `opportunity_rejections` stores each
listing with both scores and **both floors it failed**, so a call made under a policy that has since
changed can be re-derived — the same property STORY-008 needed to re-judge press materials.

> **A blind spot is not a bug you can find by reading the code.** Nothing about STORY-002's relevance
> scoring was wrong on its own terms; it did exactly what it said. The defect was in what it never
> looked at, and the only reason it surfaced was reading the rejected list instead of the accepted
> one. **When a filter decides what a human sees, its output is the half you can check and its
> rejections are the half you cannot — so store them.**

### STORY-011 — the bug two workers had and one worker hid

| Story build step | Where it lives |
|---|---|
| 1. Coordination module | `server/src/services/coordination.js` |
| 2. Priority-based conflict resolution | `013_coordination.sql` — `jobs.priority`, `jobs.resource` |
| 3. Interface with all other agents | already built by STORY-065 — the coordinator plans, the queue claims |
| 4. Enforce compliance | the gates stay in the services; every distribution is on the audit log |
| 5. Distribution visible to an operator | `client/src/pages/WorkerPage.jsx` — priority and holds |

STORY-065 built the queue that runs every agent's scheduled work, and built it to support more than
one worker: *"SKIP LOCKED is what lets more than one worker run"*. It does. What it has no way to say
is that some of that work must not run at the same time as other work, or that some of it matters
more. Both gaps are demonstrable on the shipped system.

**The ordering bug is real and was hidden by running one worker.** `press.draft_approaching`
*produces* the press materials that `trust.monitor_escalations` and `reviews.notify_pending`
*consume*. Nothing anywhere said so. With one worker the order came out right by accident — `RECURRING`
is declared producer-first and the rows get ascending ids. With two workers, drained concurrently:
six materials were created and the monitor examined **zero** of them, because it read `pr_materials`
while the drafter's transaction was still open. The work then sat unexamined and nobody was told
until the next sweep window. Demo stage 71 runs exactly that, before and after.

**The priority bug is the queue's own ordering.** Claiming was FIFO on `(run_at, id)`. A human
approves an outreach email and the send queues behind every internal sweep in the window — one per
author per kind. The single piece of outbound, time-sensitive, human-authorised work in the queue was
the last thing the worker reached, and with more authors it sits behind more.

**Two decisions, and only two.** `priority` says what to reach first; `resource` says what must not
run at the same time as what. The bands are the argument rather than the numbers: outbound work a
human authorised (90, 80) outranks work that produces (50), which outranks the agents that react to
what was produced (30, 20). `reviews.notify_pending` is deliberately last, so that it also covers
anything the monitor escalated in the same window instead of missing it by one sweep.

**Exclusion is what makes the priority mean anything.** The drafter, the monitor and the notifier
share one resource per author — `author:7:press` — because they are three stages of one pipeline over
the same rows. Priority decides who goes first; exclusion is what stops the other two reading the
table while the first is still writing it. Scoping the resource *per author* is what keeps this from
serialising the queue: a hundred authors still draft, monitor and notify in parallel with each other.

**A dead heat is settled by the database.** The claim query checks that a resource is free and then
writes, and those are two steps: under `READ COMMITTED` two workers can both see it idle. A unique
partial index on `(resource) WHERE status = 'running'` makes the second write fail, and the loser
reports an idle pass rather than an error — the same instinct as the append-only audit log being a
trigger rather than a code convention. Eight workers racing one queue: 0 errors.

**Compliance here is narrower than it sounds, on purpose.** The coordinator does **not** re-check
approval. That gate has lived inside `scheduleDraft`, `sendOutreachMessage` and `distributePressKit`
since STORY-001 precisely so a new caller cannot route around it, and a coordinator that re-checked it
would be a second copy of the rule with its own chance to drift — the exact mistake STORY-008 existed
to clean up. What it enforces is the story's trust clause: every distribution and every deferral is on
the audit log, with the reason, written by the agent that made the decision. There is a test asserting
the module exposes no approval logic at all.

> **A concurrency bug is not a bug you can find by reading the code, either.** STORY-065's queue is
> careful work — idempotency keys, `SKIP LOCKED`, backoff, dead letters, a reaper. Every one of those
> guards *a job against itself*. The defect was one level up, in the relationship *between* two
> agents' jobs, and it was invisible with the worker count the tests and the demo happened to use.
> **A guarantee that only holds at concurrency 1 is not a guarantee, and the only way to find out is
> to run two.**

### STORY-066 — a meme is a draft with a picture

| Story build step | Where it lives |
|---|---|
| 1. Meme content type with image, caption, provenance | `014_memes.sql` — `drafts.format`, `drafts.media` |
| 2. Meme generation in the AI Content Generation Agent | `memeTemplates.js`, `stubProvider.js` |
| 3. Brand-safety and image-rights check before queueing | `brandSafety.js` |
| 4. React approval UI previewing image and caption as one | `client/src/pages/ReviewPage.jsx` |
| 5. Route memes to visual-first platforms | `platform_windows.visual_first` |

Added to the backlog after Ram's review: *"On platforms like X, memes might get more traction than
text."* Scoped against the existing REQ-001 rather than opening a new requirement, so the
traceability matrix stays intact.

**A meme is a `drafts` row with a different `format`, not a table of its own.** That is the whole
design decision. Everything a text post already has — the approval gate in `scheduleDraft`, the
append-only audit trail, escalation, the weekly cadence count, the STORY-011 coordination resource —
applies to a meme with no second copy of any of it. The story's second acceptance clause is
*"identical to the gate on text posts"*, and the cheapest way to be identical to something is to be
it. A `memes` table would have needed its own gate, and a second gate is a gate with a hole in it.

**The caption is the book's argument, not a label.** Memes are drafted from the same STORY-009
grounding the text posts use — the theme's key message and the passages that evidence it — with one
caption shape per template layout, because the image carries half the sentence and the words have to
leave room for it.

**The image is real, and rendered offline.** Templates render to SVG data URIs, so the approval UI
previews an actual image rather than a grey box, and the same inputs always produce the same bytes.
No network call, the same constraint that kept theme retrieval lexical in STORY-006.

**The caption and the panels are different things, and looking at the render is what proved it.**
The first version joined a two-panel meme's text into the caption with a separator — which put a
literal `|` in the tweet and repeated in the post text the words the picture was already showing.
The panels now live in `media.panels` and the caption is what gets posted beside the image. That
split has a second consequence worth stating: a meme is *scored* on caption plus panels, because the
argument is laid into the picture and scoring the caption alone measures half the post — it escalated
every good meme until it did. The character limit still applies to the caption alone, since that is
all the platform counts. The same render also exposed silent truncation: a long panel simply stopped
mid-sentence, so the type now shrinks to fit rather than dropping the lines that do not.

**Brand safety and image rights are different kinds of failure and are treated differently.** This is
the part worth defending. Brand safety is a *judgement* — whether a joke is off-key for this author
is something a person can overrule — so a finding escalates and reaches a human, who may approve it
anyway. Image rights are a *fact*. Nobody at this company can grant a licence they do not hold, so an
unresolved or refused image is refused at publication **even after a human approves it** — the rule a
superseded press kit has followed since STORY-005. Demo stage 79 approves a meme and watches it be
refused anyway.

**An image with no provenance is `unresolved`, not `cleared`.** The system does not assume a licence
it cannot point at, for the same reason it will not guess an award result or invent a claim about the
book. A `cc-by` licence naming nobody to attribute is also unresolved: a requirement that cannot be
satisfied has not been satisfied. Two of the five templates are withheld from the drafter before
generation starts — the rights check exists to catch what gets past that, not to be the only guard.

> **The interesting question was not "how do we make memes", it was "what can this refuse".** A
> content type is easy to add. What made this story worth building carefully is that it is the first
> thing in the system whose output carries someone else's property, and that turns out to need a
> different control from every other gate here: **one a reviewer is not allowed to open.** Every
> other check in this codebase escalates to a human because a human is the final authority. This one
> does not, because on this question they are not.

### STORY-067 — the half of a filter nobody could check

| Story build step | Where it lives |
|---|---|
| 1. `meme_templates` table | `015_meme_template_library.sql` |
| 2. Seed an initial set with recorded provenance | `server/src/db/memeTemplateSeed.js` — 10 templates, 8 usable |
| 3. Selection service that filters out templates lacking rights | `services/memeLibrary.js` — and logs every refusal |
| 4. Compose a meme by filling a chosen template | `composeFromTemplate`, `stubProvider.js` slot fillers |
| 5. Admin view to browse, add and retire | `client/src/pages/TemplatesPage.jsx` |

Added after Ram asked for memes to be *"a significant theme"*, not a single story. STORY-066 shipped
five templates as a hardcoded array and drew the whole picture at draft time from a colour palette —
fine for proving the idea, wrong for owning one. An author cannot add a template to a source file,
cannot retire one that has stopped working, and cannot see what the generator is choosing from.

**A template is now artwork that exists before the caption.** Each row carries a stored image, a
recorded source, a licence, and **named caption slots** the drafter fills. A slot says what it is
*for* — `setup` is "the expectation", `turn` is "what the book actually says" — so a template can be
added without a code change to go with it. STORY-066 had one hardcoded caption function per layout,
which meant every new format was a code change.

**The refusals are on the audit log, and that is the point of the story.** STORY-066 filtered
unlicensed templates out with `usableTemplates()`, which returned an array and said nothing. That is
the exact silence STORY-010 found in the opportunity scanner: a filter deciding what nobody would
ever see, keeping no record of having decided. The second acceptance clause asks for *"the attempt
is logged"*, and that clause is what turns "an unlicensed image can never reach a draft" from a claim
into something you can check. Every template reached for and refused gets its own `meme_template.rejected`
row with a named reason — never a count.

**Refused at the door, not filtered later.** `addTemplate` rejects a template nobody can licence
rather than accepting it and hiding it at selection time. A library that holds unusable templates is
a library whose count means nothing.

**Retiring, not deleting.** A meme drafted last month points at its template with a foreign key, and
deleting the row would strand the provenance on a post that has already gone out. Retiring sets
`active = false` with a timestamp and a reason, and the generator stops offering it. Demo stage 84
retires one and shows the three drafts still pointing at it.

**The rights question is asked in one place.** `assessTemplate` calls STORY-066's `checkImageRights`
rather than restating its rules — the licence question is the same question whether it is asked of a
finished draft or of a template about to be chosen, and two copies of it would be free to disagree.
The hardcoded `memeTemplates.js` was deleted rather than left beside the table it was replaced by.

> **The same lesson, third time, and it keeps being about silence.** STORY-008 found a producer
> grading its own work. STORY-010 found a scanner discarding leads with no record. This found a
> filter withholding templates the same way. The pattern underneath all three: **a system's outputs
> are the part everyone reviews, and its refusals are the part nobody does — so refusals need to be
> written down more carefully than results, not less.**

### STORY-068 — eight licensed templates, five accent colours

| Story build step | Where it lives |
|---|---|
| 1. `visual_identity` table, versioned per tenant | `016_visual_identity.sql` |
| 2. Derive an initial guide from themes and cover art | `services/visualIdentity.js` — `deriveIdentity` |
| 3. Expose it in the React UI for human editing | `client/src/pages/TemplatesPage.jsx` |
| 4. Content agent reads the active version at generation | `contentDraftingAgent.js`, `selectTemplate` |
| 5. Score each candidate against the guide and gate on it | `scoreIdentity`, `escalationPolicy` |

STORY-067 gave every template a licence and a slot structure, and nothing more. Reading the finished
library back is what made the gap concrete: **eight licensed templates carrying five different accent
colours** — blue, green, amber, purple, red — and one of them light while the rest are dark. Every
template legal, on-message and reusable. Together they are a feed rather than a book. Demo stage 86
scores all eight against the guide; three fit.

**The guide is derived from evidence, and says when it is guessing.** With cover art the palette is
*observed*; without it, inferred from the book's own words and recorded as `inferred from the book's
words — no cover art supplied`. Presenting an inference with the confidence of an observation is the
failure STORY-009 found in the hand-written voice profile, and the UI shows which it is. The
do-not-use rules inherit whatever the author's voice profile already avoids, so the verbal identity
and the visual one cannot contradict each other.

**Tone words describe; do-not-use rules refuse.** The same split as safety and rights in STORY-066.
A guide that only described would be a claim nothing verifies.

**The guide shapes what gets made, not only what gets caught.** Selection prefers on-identity
templates and the score gates whatever slips past — the same evidence on both sides of generation
that STORY-009 used for themes. Without that, the library's five off-accent templates would send most
memes to a human for a fault the system itself chose.

**Versioned, because a revision must not reinterpret what came before.** The story asks that an
author's edit apply to *later* memes; the half it does not say is that memes already judged are
already judged. A revision writes a new version and retires the previous one, drafts store the
version they were scored against, and a database partial index enforces exactly one active version
per book — "the rules in force" is a question that must have one answer. Demo stage 88 changes the
accent to green and the same seed picks a different template; stage 89 shows the older memes still
pointing at v1.

**Identity escalates; rights refuse.** A drifting meme reaches a human who may approve it anyway —
the author is the authority on what their book looks like. That is deliberately unlike STORY-066's
image rights, which no approval can override, because they are not the authority on whether we hold
a licence.

> **The check that could not fail, found by running it against real data.** The first version of the
> palette check only looked at large filled rectangles, and every off-brand template scored a clean
> 1.00 — because a template's accent is almost always a hairline rule, a stroke or a line, all far
> below any sensible area threshold. **Size is not what makes a colour deliberate; saturation is.**
> The check existed, passed its own tests, and measured nothing until it was pointed at the library
> it was written for.

### STORY-069 — a dashboard whose main job is saying "not yet"

| Story build step | Where it lives |
|---|---|
| 1. Format discriminator carried through publishing | `017_engagement.sql` — `scheduled_posts.format` |
| 2. Collect engagement per published item (mocked) | `services/engagement.js` — `collectEngagement` |
| 3. Aggregate by format and platform | `compareFormats` |
| 4. React comparison view with a small-sample warning | `client/src/pages/PerformancePage.jsx` |
| 5. Mix recommendation as an approval-gated suggestion | `trustMonitoringAgent.recommendMix`, `approvals.js` |

The last of the four meme stories, and the one that closes the loop on why the other three exist.
Ram's note was *"on platforms like X, memes might get more traction than text"*. STORY-066 made memes,
067 gave them a library, 068 gave them a look, and not one of them could say whether the premise
holds.

**It would have been easy to divide two averages and print a winner.** At the sample sizes this
system will realistically have for months, that ratio is noise wearing a decimal point. A verdict
here requires `MIN_SAMPLE_PER_CELL` posts of *both* formats on a platform **and** 95% intervals that
do not overlap — and when it cannot conclude, it says which of those two failed, by name: *"0 memes
and 3 text posts — 8 of each needed before this can say anything"*. There is no `lift` field unless a
verdict was reached; a headline number nobody should act on is not reported at all.

**The mocked collector is format-blind, and there is a test pinning that.** This is the obvious place
to quietly make the premise come true, and a generator tuned so memes win would turn the demo into a
claim about the world rather than a demonstration of the apparatus. `mockMetrics` produces byte-identical
output for a meme and a text post; a caller may pass `formatEffect` to *simulate* a world where memes
lead, and the audit log records whatever value was used. Demo stage 92 does exactly that, out loud.

**Posts too young to have settled are excluded, not averaged in.** A meme measured an hour after
publishing against a three-week-old text post is measuring age. `hours_live` is stored on every
reading so the maturity window is applied to the measurement rather than assumed.

**A recommendation is a proposal, enforced structurally.** The drafting agent reads
`authors.memes_per_batch`; a pending recommendation is a row in a table nothing consults. Approving
it moves the setting inside the same transaction as the decision; rejecting it is genuinely inert.
Demo stage 94 rejects one and shows the mix unmoved, then approves the next and shows the following
batch drafting more memes. It stays quiet entirely on a platform whose data cannot separate the two —
a recommendation drawn from an inconclusive comparison would launder noise into an instruction.

> **The deliverable is a dashboard that usually refuses to answer.** Every instinct in building this
> pulls the other way: a comparison view that shows a winner feels finished, and one that says "not
> enough data" feels broken. But the premise four stories rest on is exactly the kind of thing an
> organisation talks itself into, and **the value of measuring it is entirely in being willing to
> report that it is not yet measurable.** A dashboard that always finds a difference will always be
> believed, and will usually be wrong.

### STORY-012 — the word "and"

| Story build step | Where it lives |
|---|---|
| 1. Hold drafts in PostgreSQL until approved | already built by STORY-001 — the gate lives in the services |
| 2. Approval and Notification Agent module | `server/src/agents/approvalNotificationAgent.js` |
| 3. Notify users of pending approvals | `018_approval_notifications.sql`, `notifyAwaitingApproval` |
| 4. Runs unattended | `approvals.notify_waiting` on the STORY-065 worker |
| 5. One queue a reviewer can see | `GET /api/authors/:id/awaiting-approval`, the Review tab |

Half of this story has worked since STORY-001. Nothing reaches a platform without a human decision —
`scheduleDraft`, `sendOutreachMessage` and `distributePressKit` each refuse unapproved work, and the
gate has grown to four targets without being forked once.

**The other half is the word "and".** The clause is that the agent holds the draft *and sends a
notification*, and notification existed for exactly one of the four things a human approves. The
`notifications` table said so itself:

```sql
CONSTRAINT notifications_exactly_one_target CHECK (num_nonnulls(pr_kit_id) = 1)
```

There was no column for a draft. A social post could sit in `pending_approval` for a week and there
was no mechanism by which anyone could be told — not a bug in the notifier, an **absence in the
schema**. On a freshly seeded database with five social drafts and three outreach messages waiting,
the number of notifications ever sent about any of them was zero, and could not have been anything
else.

**One digest per reviewer, not one email per item.** STORY-007's model is one email per press kit,
which is right for a kit: they are rare and each is its own decision. Social drafts arrive four at a
time every week, and that model there is four emails a week per reviewer — which a reviewer stops
reading, at which point the notification is worse than none. Rows are still written **per item**, so
the idempotency guarantee holds: announced once to a reviewer, never again however often the sweep
runs. `batch_id` is what lets one email carry many rows.

**It does not notify about press kits, deliberately.** STORY-007 already does, with kit-specific
content this has no business duplicating — two agents emailing about the same kit is the drift
STORY-008 spent a story removing. Kits appear in the queue, because a reviewer should see one list,
and the sweep logs `deferredToReviewNotifier` so the omission is visible rather than looking like a
miss.

**Work waiting and nobody to tell is still recorded.** The state STORY-007 named for kits is no less
true here, and `approval.unreachable` says so rather than the sweep passing over in silence.

**Notifying is not deciding.** There is a test asserting no status moves when the sweep runs.

> **A migration that dropped a constraint someone else had grown.** Redefining
> `notifications_exactly_one_target` meant restating every target it accepts, and the first draft of
> this migration copied the version from STORY-007 — silently removing the `escalation_id` STORY-008
> had added in between. The suite caught it in one run. **A constraint that has grown must be read
> from the live schema, not from the migration that first created it**, and `DROP CONSTRAINT … ADD
> CONSTRAINT` is a rewrite pretending to be an edit.

### STORY-013 — prevention is not detection

| Story build step | Where it lives |
|---|---|
| 1. Log every agent action | already built by STORY-001 — `services/auditLog.js` |
| 2. Append-only in PostgreSQL | already built — UPDATE, DELETE and TRUNCATE triggers |
| 3. Audit and Security Agent module | `server/src/agents/auditSecurityAgent.js` |
| 4. Integrity that can be checked | `019_audit_integrity.sql` — `audit_checkpoints` |
| 5. Runs unattended | `audit.seal_and_verify` on the STORY-065 worker |

The audit half of that agent's name was already true, and I checked rather than assumed: an
inventory of every file that mutates state against every file that writes an audit row comes back
clean, and the table really does refuse UPDATE, DELETE and TRUNCATE.

**The security half had nothing behind it.** Append-only here is a *policy* — a trigger — and a
policy can be switched off:

```sql
ALTER TABLE audit_log DISABLE TRIGGER ALL;
UPDATE audit_log SET actor = 'SomebodyElse', action = 'draft.approved' WHERE id = 3;
DELETE FROM audit_log WHERE id IN (4, 5);
ALTER TABLE audit_log ENABLE TRIGGER ALL;
```

Run against this database that rewrote who approved what and removed two rows, and afterwards the
log still refused every ordinary mutation and **nothing in the system could tell**. Prevention with
no detection: the guarantee held exactly as long as nobody with table rights decided otherwise, and
left no evidence either way. Demo stages 103–105 do it and catch it.

**Checkpoints, not a per-row hash chain.** Chaining at insert time means serialising every audit
write in the system behind a lock on the previous row, and every action here writes one. Sealing
ranges periodically costs nothing on the write path and detects the same three things: a row
altered, a row removed, a row inserted after the fact.

**The digest covers `metadata`.** That is where the thresholds a decision was judged against and the
session behind it live. A seal that ignored them would let someone rewrite *why* a draft was approved
while the digest still matched — a worse guarantee than none, because it would be believed.

**Row counts are stored, not derived.** Sequence gaps are normal: a rolled-back transaction consumes
an id without leaving a row, so `to_id - from_id + 1` never was the count. Storing the real count at
seal time is what makes a later deletion — or an insertion into a gap — detectable.

**Sealing does not feed on itself.** The seal writes its own receipt into the log, so the next run
always finds something; without a rule it would seal that receipt, forever, one empty checkpoint per
sweep. A range containing only this agent's own bookkeeping is not sealed, and those rows are swept
into the next checkpoint that covers real activity.

**What it cannot do, in the README rather than only in my head.** Anyone who can disable the log's
triggers can disable the checkpoints' triggers and re-seal a doctored range into a consistent chain.
What this buys is that tampering now takes rewriting two structures in step rather than one, and
that anything short of that is caught. Publishing digests somewhere this database cannot reach is
the next step, and it is a deployment decision rather than a schema one.

> **A guarantee nobody can check is a promise.** The audit log was described in this README as
> append-only for twelve stories, and it was — under the assumption that the triggers stay on. That
> assumption was never stated and never tested, and the whole value of an audit log is that it does
> not rest on assumptions about the people who can reach it. **Ask of any control: what does it look
> like after it has failed? If the answer is "exactly the same", the control is prevention with no
> detection.**

### STORY-014 — a score that is never allowed to outrank a broken promise

| Story build step | Where it lives |
|---|---|
| 1. Aggregate the data in Node | `services/governance.js`, `services/anomalies.js` |
| 2. Serve it over REST | `GET /api/authors/:id/trust-dashboard` |
| 3. React trust dashboard | `client/src/pages/TrustPage.jsx` |
| 4. Governance score | `scoreOf` — a summary of a readable list, not a verdict |
| 5. Anomaly detection | detectors that state their sample and decline below it |

REQ-007's first real entry, and unusual for this project in that nothing was half-built: every input
already existed and existed *separately*. Escalations on one screen, dead letters on another, audit
integrity on a third, work waiting on a human on a fourth. Each observable, none observable together,
so "is this system behaving" was four questions with four places to look.

**The score is a summary, never the verdict.** A governance score is easy to build and easy to
believe, because it is a number. Checks are split into **invariants** — things that must never be
true, like content published with no approval on record — and **quality checks** — things that
should be true, like every approval naming an authenticated session. One failed invariant is a
`breach` regardless of score: a dashboard showing *94% compliant* above content that went out
unapproved would be worse than one showing nothing. The demo prints exactly that case at 0.778.

**The gates are checked from outside the code that enforces them.** `scheduleDraft`,
`sendOutreachMessage` and `distributePressKit` each refuse unapproved work; these queries ask the
database the same question independently. A gate that only checks itself is the arrangement STORY-008
spent a whole story removing.

**Nothing here is recomputed.** Audit integrity comes from the Audit and Security Agent, the pending
queue from the Approval and Notification Agent. A dashboard that recomputed what it displays would be
a second implementation free to disagree with the first, and the disagreement would be invisible —
which is the specific way dashboards become confidently wrong.

**The anomaly detectors say what they cannot conclude.** This is the part of a trust dashboard most
likely to invent findings: a "spike" over four data points is noise, and a dashboard that reports one
will be believed. Each detector reports its sample and returns `insufficient_evidence` rather than a
guess, and the UI distinguishes *looked and found nothing* from *could not look* — a panel listing
only its findings looks identical either way. The STORY-069 rule, applied to a different set of small
numbers.

**One detector is aimed at this system's own central claim:** a reviewer who has made enough
decisions and never once rejected anything. An approval gate that never turns anything away is hard
to tell apart from no gate at all.

> **The demo's dashboard opens by reporting a breach, and that is the point.** STORY-013's stages
> tamper with the audit log to prove detection works, and never repair it — so three stages later the
> trust dashboard correctly refuses to call the system healthy. It would have been easy to quietly
> restore the log first and show a clean board. **A monitoring surface is only worth having if you are
> willing to look at it on a bad day**, and the honest demonstration is the one where it fails.

### STORY-015 — the half a laptop can finish, and the half it cannot

| Story build step | Where it lives |
|---|---|
| 1. Docker configuration for the stack | `server/Dockerfile`, `server/Dockerfile.worker`, `client/Dockerfile`, `docker-compose.yml` — **never built** |
| 2. CI/CD pipeline | `.github/workflows/ci.yml` — **ran once on GitHub and failed (see STORY-053)** |
| 3. Deploy to a public demo URL | **not done — see below** |
| 4. Deployment logs for rollback and audit | `020_deployments.sql`, `services/deployment.js` |
| 5. Reliable availability | `/api/ready`, graceful shutdown in `server/src/index.js` |

**This story is not finished, and the parts that are not finished are named rather than implied.**
The acceptance clause asks for deployment to a public demo URL using Docker. There is no cloud
account, no credentials, and **Docker is not installed on the machine this was written on**. The
Dockerfiles, the compose stack and the CI workflow are written and reviewed and have **never been
executed** — each says so in its own opening lines, and there is a test asserting that they do. A
green tick over an untested claim would have been a worse outcome than an unfinished story.

What *is* built and verified is the half that turns out to matter operationally, and it is the half
the trust clause actually names.

**Liveness and readiness are different questions.** `/api/health` answers "is this process up" —
what a platform restarts on. `/api/ready` answers "is it safe to send this instance traffic" — what a
load balancer asks, returning 503 when the answer is no. Conflating them means a schema mismatch gets
treated as a crash and restarted into the same mismatch, forever.

**Readiness checks the thing a rolling deploy actually breaks.** An instance whose code expects a
migration nobody applied starts perfectly, answers `/health`, and throws on the first request that
touches a column that is not there. `/api/ready` compares the migrations this build ships against the
migrations the database has run, and names the missing files. Demo stage 114 removes one and watches
readiness refuse.

**The API drains on SIGTERM.** The worker has done this since STORY-065 — *"so a deploy does not
create a stale claim"* — and the API never did: `listen()` with no signal handler, so every deploy
severed whatever requests were in flight. Readiness flips first so traffic stops arriving, then
in-flight requests finish, then the process exits. Verified by holding a database lock, sending
SIGTERM, and watching the blocked request return **HTTP 200 with a full body** afterwards.

**A release you can identify is a release you can roll back to.** Each instance records what it is —
version, commit, and the schema it expects against the schema it found — written *by the process
itself at boot*, because the process is the only thing that knows which commit it is actually
running. A record produced by the deployer describes what it intended to start. Stopping on purpose
and crashing are recorded differently, because an instance that keeps crashing and restarting looks
like a healthy deploy history otherwise.

**What still needs a platform**, precisely: somewhere to run the images; a registry to push them to;
secret storage for `JWT_SECRET` and `DATABASE_URL`; a managed Postgres with backups; a load balancer
wired to `/api/ready` rather than `/api/health`; a termination grace period longer than
`SHUTDOWN_GRACE_MS`; and a migration step that runs once per release rather than per instance — the
compose file models that last one with a `migrate` service the API waits on, which is the shape, not
a proof it works.

> **The temptation here was to write a Dockerfile and call the story done.** It would have looked
> identical to a finished one in the diff, and the acceptance criterion has a checkbox that could
> have been ticked. **Infrastructure you have never executed is a design document with a filename
> that makes it look like a build** — so it is committed with what it is written at the top of each
> file, and there is a test that fails if anyone removes the disclaimer.

### STORY-016 — a mock never fails the way a real API fails

| Story build step | Where it lives |
|---|---|
| 1. Module handling auth and retrieval from external APIs | `server/src/agents/apiIntegrationAgent.js` |
| 2. Data stored in PostgreSQL for other agents | `021_api_interactions.sql` |
| 3. Every adapter routed through it | `socialApis.js`, `emailApi.js`, the three Anthropic providers |
| 4. Log all API interactions | one row per *attempt*, plus `api.call_failed` on the audit log |
| 5. Visible to an operator | `GET /api/integrations`, the Trust tab |

The acceptance clause passed before this story existed. Adapters for the social platforms, email and
the directories were all written to the shape of a real client, and the demo makes 48 outbound calls
through them. What a mock cannot exercise is the ways a real provider fails, so the code around it
had never had to be right — and it wasn't, in three specific ways.

**Nothing was logged.** The trust clause asks that all API interactions be recorded for traceability.
48 calls in a demo run and zero rows anywhere. The audit log has always said `post.published` — the
*business* event — and never which service was called, how long it took, what came back, or whether
it was retried. When a platform starts degrading it is the second fact that tells you, and it did not
exist.

**Nothing had a timeout.** A bare `fetch` in Node has none. Against a provider that accepts the
connection and never answers, it waits indefinitely — measured against a real socket at over four
seconds before the harness gave up, and it would have waited all day. Since STORY-015 added graceful
shutdown that would also hold the drain open until the platform force-killed the process, turning one
slow provider into a failed deploy.

**Nothing distinguished a 429 from a 400.** Retrying a rejected request gets the same refusal more
slowly; not retrying a rate limit throws away work that would have succeeded a second later. They are
opposite mistakes and neither was possible to make, because there was no retry at all. Rate limits,
timeouts, connection resets and 5xx are retried; a 4xx the provider actually answered is not.
A `Retry-After` header overrides the backoff, because the provider knows better than the schedule.

**One row per attempt, not per call.** A call that succeeded on its third try and one that succeeded
immediately are very different pictures of a provider, and collapsing them loses exactly the signal
worth having. The Trust tab shows attempts beside calls for that reason: attempts above calls means a
provider is degrading rather than failing, which is the state worth catching before it becomes the
other one.

**The policy lives in the agent, not in each adapter.** The adapters were written on the premise that
swapping a mock for a real client is a change confined to one file, and that premise only holds if
the retry, timeout and logging are already outside them.

> **The mock was the problem, and it had been the whole time.** Every one of these adapters worked
> perfectly, in tests and in the demo, for fifteen stories. A stub that always succeeds does not just
> fail to test the error path — it removes the pressure to write one, and the absence looks exactly
> like completeness. **Ask of any faked dependency: what does the real one do that this one cannot,
> and which of those has my code never had to survive?**

### STORY-017 — the guard that checks the address, not the answer

Multi-tenancy was built in STORY-064 and this README has claimed it ever since. The story asks for a
Tenant Management Agent that keeps tenants isolated — and the honest reading of that, given the guards
already existed, was to stop restating the claim and go test it.

It failed on the first try, in my own code.

Signed in as Mira, tenant 1, asking for **her own** trust dashboard:

```
recent actions returned: 20
belonging to ANOTHER tenant: 1
  author 2 · TomasPrivateAgent · tomas.secret_action
```

Nothing was bypassed. `enforceTenant` pins `?authorId=` to the caller and `tenantParam` refuses
`/authors/2/...` — both worked exactly as written. They guard the **address** of a request. They say
nothing about the rows a handler then goes and fetches, and the STORY-014 trust dashboard fetched
recent audit activity with no tenant filter at all, because at the point I wrote it the surrounding
route was already "protected". Two routes had the same shape; both are fixed.

That is the useful finding, and it is not a bug about one query. A tenant check that lives at the
door cannot see what the room does. The only thing that catches this class of error is a check that
looks from **outside** the code doing the enforcing, so this story built two of them:

**A walk across the API as a real tenant.** `tenantIsolation.test.js` signs in as tenant 1, requests
every list route, and asserts no row in any response carries another tenant's id — the exact walk
that would have caught the dashboard leak the day it was written. It is a guard against a whole
category, not a regression test for one query.

**A check against the database, not the requests.** `verifyIsolation` looks for a child row claiming
one tenant while its parent belongs to another — a draft on someone else's book. No code path should
produce that, which is precisely why nothing that only inspects incoming requests would ever see it.

The first version of that check reported **1,868 orphaned `audit_log` rows as a breach**. They are not
a breach: `audit_log` has no foreign key to `authors` on purpose, because deleting an account must not
delete the record of what it did. So the check names its exclusions in its result rather than
skipping them quietly — a security check that cries wolf about a design decision is one people learn
to ignore, and an exclusion nobody can see is indistinguishable from a check that never ran.

Onboarding and suspension follow the same rule the rest of the system already uses. `onboardTenant`
creates the author and its login in one transaction — an author with no account is a tenant nobody can
reach, an account with no author is a session with nothing behind it, and either half alone is a
broken state somebody cleans up by hand. `suspendTenant` sets a status and revokes access; it does
not delete. That is the same reasoning as retiring a meme template rather than dropping it: a
cascading delete takes the evidence away with the account.

The isolation result is also a governance invariant (`tenant.isolation`), so a breach costs the
governance score the way an approval-gate violation does, rather than sitting in a log nobody reads.

**What this is not:** the build note suggests PostgreSQL schemas or separate databases per tenant.
This is neither. Isolation here is an `author_id` column on 23 tables plus application middleware —
which is what the README has always said, and is now what a test asserts rather than what a paragraph
claims.

### STORY-018 — the agent that graded everyone else finally writes something

| Story build step | Where it lives |
|---|---|
| 1. Node module generating PR materials with an external AI API | `server/src/agents/aiContentGenerationAgent.js` |
| 2. Retrieval of the book's themes before drafting | `server/src/services/themeRetrieval.js`, `contentAlignmentAgent.js` |
| 3. The author's voice, measured from their own posts | `server/src/services/voiceProfile.js` |
| 4. Drafts stored in PostgreSQL for review | `server/src/db/migrations/023_on_demand_pr.sql` |
| 5. Approval gate on everything generated | `server/src/services/approvals.js`, `governance.js` |

The AI Content Generation Agent has been on the agent map since the start and had never generated
anything. It was a scorer — `alignToThemes`, the visual identity check, the meme library — always
grading some other agent's output. This story is where it writes, and it got the press materials
because press materials had the two holes that matched its own acceptance criterion.

**"When PR material generation is requested" — it could not be.** Press materials existed only as a
byproduct of a milestone. `draftPressKit` took a milestone id and nothing else, and `milestone_id`
was `NOT NULL`. A book has three or four milestones in its life; a publicist promoting it during the
rest of that life had no path except to invent an event, which would put a fiction in the table the
schedule reads from. So `pr_kits` gained an `occasion`, and "no occasion but the book itself" became
one of the occasions rather than a missing row.

**"and author's voice" — press copy was never measured against it.** This is the sharper half.
`assess()` was called as `assess({ confidence, themeAlignment })`, with `voice` omitted — the
parameter's own docstring said "Social posts". The only voice number press copy had was a word
overlap with the author's prior posts, worth 0.15 of confidence and gating nothing. So a release
could argue every one of the book's themes in a register the author had never used and queue for
ordinary approval. That is the same finding STORY-009 made about social posts, at the other end of
the pipeline, and it gets the same answer: counted traits, stored verdict, floor that acts.

Here is the case, from the demo:

```
theme alignment 0.64 — it names every theme and carries their arguments
voice           0.35 — floor is 0.5
status          escalated
reads unlike the author on: exclamations, hype, shouting, sentence_length
```

On themes alone that copy passes. Before this story, themes alone was the whole test.

**Voice is measured on the prose, not on the format.** This was the part that needed thinking about.
`measure()` counts a run of capitals as shouting — correctly, for a tweet. But a press release is
required to say `FOR IMMEDIATE RELEASE` and `MEDIA CONTACT`, and a fact sheet is almost entirely
capitalised labels. Scored raw, every press kit fails for being a press kit: that is a *format*
measurement wearing voice's name, and a floor built on it would escalate everything and therefore
mean nothing. `proseOf` drops the lines with no lowercase in them and strips the `LABEL — ` prefix
from the rest. The same release scores **0.74 counted raw and 0.87 counted on its prose** — the
difference is entirely the furniture.

What survives that is a real finding rather than a structural one: the release still reads longer
than this author's posts (`sentence_length` is a violation on most press copy, because a lede is not
a tweet). It is reported to the reviewer and does not escalate on its own, because the composite
clears the floor. A note, not a gate.

**Making a required column optional breaks queries that never mentioned it.** Four `JOIN milestones`
were inner joins — `GET /press-kits`, the review-notifier queue, the escalation notifier, and the
trust dashboard. None of them lost a *column* when `milestone_id` went nullable; they dropped the
whole kit. An on-demand kit would have been generated, stored, and then been invisible to every
screen a human approves from — an approval gate with nobody standing at it. All four are `LEFT JOIN`
now, and `aiContentGeneration.test.js` asserts the kit reaches the review queue and the dashboard.

The voice floor applies to **all** PR materials, milestone kits included, because "an approval gate
for all generated PR materials" is what the story asks for and two standards for one table is how a
gate becomes advisory. Existing press tests were unaffected, and not by luck: they seed one and two
prior posts, below `MIN_POSTS_FOR_TRAIT`, so voice is not enforceable and scores the neutral 0.6.
The seeded demo author has five, so the demo's copy is genuinely measured.

Materials written before this story carry no voice verdict and are never backfilled — a score
nothing measured would be inventing the evidence the check exists to find. `023` records a watermark
and the `press.voice_measured` governance check reads it, so those rows are reported as history
rather than as a permanent red nobody can clear.

### STORY-019 — the log nobody could edit and everybody could read

| Story build step | Where it lives |
|---|---|
| 1. `AuditLog` module handling logging | `server/src/services/auditLog.js` (since STORY-001; redaction added here) |
| 2. Table with action details, timestamps, before-after states | `audit_log`, `001_init.sql` |
| 3. Secure the table | `019_audit_integrity.sql` (append-only) + redaction at write — **not AES-256; see below** |
| 4. RBAC in the Node/Express backend | `024_rbac.sql`, `server/src/services/permissions.js`, `middleware/auth.js` |
| 5. Endpoints for logging and retrieving with access control | `GET /api/audit-log`, `GET /api/audit-integrity` |

STORY-013 proved the audit log **cannot be tampered with**. This story asks two different questions:
is it **complete**, and **who may read it**. Both were measured before anything was written.

**Anyone could read it.** `GET /api/audit-log` had no guard at all — any signed-in author read it.
The 403 an author gets asking for another tenant comes from `enforceTenant`, which is *tenant
scoping*: it answers "whose rows?", not "may this role read audit data?". Those two questions agree
right up until they don't. That is the third time this project has hit the same shape — a system
cannot audit its own audit log (STORY-013), middleware cannot verify the handlers it protects
(STORY-017), and now a tenant check cannot answer an access-control question.

**So permissions became rows.** `008_auth.sql` said it in its own comment — *"This is not RBAC:
there are no per-resource permissions here"* — and predicted the fix in the next line: *"adding a
third role later is a row rather than a migration to every check."* This story added a third role
and took that claim at its word:

```
admin       audit.read, audit.verify, templates.manage, tenant.manage, tenant.read.all
author      audit.read
compliance  audit.read, audit.verify, tenant.read.all
```

A compliance officer reads every tenant's log and can change nothing. Under role checks that person
had to be made an admin, which is how "read the audit log" quietly becomes "suspend a tenant". No
route names the `compliance` role, and a test asserts that — if the claim had been false, adding the
role would have required editing routes. All seven `requireRole('admin')` guards became permission
checks, and `requireRole` is deleted rather than deprecated, because leaving it exported leaves the
easy wrong answer next to the right one.

The same conflation was one layer down, in the schema: `CHECK (role = 'admin' OR author_id IS NOT
NULL)` meant "an account with no tenant must be able to read across tenants", and while `admin` was
the only such role the two sentences were indistinguishable. It rejected the first compliance user.
It is now a trigger that consults the grant table, because a `CHECK` may not contain a subquery.

**Why not AES-256** *(superseded by STORY-049, which does it in the storage layer and answers each
objection below — the redaction stays, for the reason given)*. The build note asks for it on this table. It would break the STORY-013 seals
(which hash row contents), make every governance check unable to filter on `action` or join on
`author_id`, and leave the key in the same env file as the database URL. None of that addresses the
actual hazard, which is this: 28 call sites log a whole database row with `after: row`, and the day
one of those rows comes from `users`, the password hash is in a table whose triggers refuse `UPDATE`,
`DELETE` and `TRUNCATE`. **A secret written here can never be taken back out.** Encryption still lets
the key holder read it; neither lets anyone remove it. So redaction happens at the single function
every writer goes through:

```
after.password_hash        → "[redacted]"
metadata.nested.api_key    → "[redacted]"
after.email                → "mira@example.test"   (not a credential, kept)
```

The key is kept and the value replaced, because *that a write touched a credential* is itself an
audit fact. Encryption at rest is a deployment-layer concern and is named in Known gaps rather than
faked here — the same call STORY-015 made by saying "not deployed" out loud.

**"Before-after states", checked where a state existed.** Two actions moved a row's status and
recorded neither: `tenant.suspended` and `meme_template.retired`. Both now capture both states in a
single statement (`FROM authors old` reads the pre-update snapshot, so there is no gap in which
someone else's write could become the recorded "before").

The governance check that stops this drifting again is deliberately narrow, and **its first version
was wrong** — it counted 67 `meme_template.rejected` rows as violations. Those are gate *refusals*:
the generator reached for a template it may not use and was told no. Nothing was stored, so there is
no prior state, and demanding one is demanding fiction — exactly what the check's own comment warns
against. It now qualifies `rejected` by entity type. Creations keep `after` with no `before`,
retrievals have neither, and none of them count.

Proving that check can fail needed a bad row, and a bad row here is permanent — it would leave the
check red in every later run, and a red nobody can clear is one people learn to scroll past. The test
writes one inside a transaction and rolls it back: the triggers block edits to committed rows and
have nothing to say about a write that never commits.

### STORY-020 — the gate that was never missing, and the one nobody would have noticed

| Story build step | Where it lives |
|---|---|
| 1. `ApprovalGate` module managing approval workflows | `server/src/services/approvals.js` (since STORY-001) |
| 2. `approvals` table tracking pending communications | `001_init.sql`, extended by 002/003/017 |
| 3. Endpoints for submitting, notifying, logging | `/api/*/approve`, `/api/*/reject`, `/api/authors/:id/notify-pending` |
| 4. Email notifications | `server/src/services/emailApi.js`, `reviewNotifier.js`, `approvalNotificationAgent.js` |
| 5. **What was actually missing** | `server/src/services/outboundPaths.js` |

Both of this story's acceptance clauses were already built. The gates have existed since STORY-001,
and `gate.posts` / `gate.outreach` / `gate.press` have checked them from outside since STORY-013.
Rebuilding any of that would have been motion.

What none of it could answer is whether a gate had been **missed**. Each of those three invariants
joins one table that records a send — `scheduled_posts`, `outreach_sends`, `pr_distributions` — so
each verifies *a gate that exists*. A seventh way out, added next month, writing to none of those
tables, is ungated and invisible to all three. "Is this message approved?" was answered six ways.
"Is there a way out that nobody put a gate on?" was never asked.

Counting them for the first time: **six outbound paths, three gated, three not.**

```
GATED   social.publish       an approved post to a social platform
GATED   outreach.send        an approved pitch to a podcast, event or venue
GATED   press.distribute     a complete press kit to matching press contacts
EXEMPT  review.notify_pending      a digest of materials awaiting review
EXEMPT  review.notify_escalation   notice that the monitor raised an escalation
EXEMPT  approval.notify_waiting    the digest of everything waiting on a human
```

The three ungated ones are **correct**, and that is the interesting part. The email that asks for
approval cannot itself require approval — that is circular, and the queue would never be announced.
So the answer is not "gate everything"; it is that an exemption has to be *declared, with its
reason, somewhere a reviewer can read it*. All three are on the trust dashboard rather than in a
source comment, for the reason STORY-017 learned: an exclusion nobody can see is indistinguishable
from a check that never ran.

**Enforced at the choke point, not by convention.** `emailApi.send` and every social publisher now
require a `via` naming a declared path, and refuse anything else — the same reasoning that puts the
approval check inside `scheduleDraft` rather than in the route above it. A caller who forgets is
precisely the case this exists for.

It proved that on its author. Wiring the six known send points, **I missed `outreachSender.js`**, and
the suite failed on it immediately with `Outbound send refused: no via given` — a missing declaration
caught the same day the mechanism was built, in code written by someone with the registry open.

A test also reads the source and fails at build time, so a new path is caught before it ever runs.
Planting a probe file that sends without declaring itself:

```
not ok - finds every send call site, and every one names a path
         + '__probe.js: .send({...}) with no via'
```

Two independent failures for one mistake — the STORY-013 rule again: the check and the risk have to
be in different places.

The new invariant `gate.outbound_declared` asks what the other three cannot — does every gated path
name an invariant that checks it? A gated path with no invariant behind it is the state REQ-006 was
in before STORY-013, and this is what notices if it recurs.

### STORY-021 — a dashboard that only existed while somebody was looking at it

| Story build step | Where it lives |
|---|---|
| 1. `TrustDashboard` React component | `client/src/pages/TrustPage.jsx` (since STORY-014) |
| 2. Backend aggregating audit logs, approvals, health | `server/src/agents/trustMonitoringAgent.js` |
| 3. Anomaly detection | `server/src/services/anomalies.js` — **statistical, not TensorFlow; see below** |
| 4. REST endpoints serving the dashboard | `GET /api/authors/:id/trust-dashboard`, `/trust-history` |
| 5. **What was actually missing** | `server/src/services/trustHistory.js`, `025_trust_history.sql` |

Both acceptance clauses passed before this story started. Measured first: the dashboard already
showed health, pending approvals, recent actions and anomalies, and three detectors were running.

What REQ-007 also asks is that users **monitor and analyse** trust metrics, and analysis needs a
second reading to compare the first one to. There wasn't one:

```
assessments stored          0   (only an audit row per page load)
recurring jobs assessing    0   (six sweeps ran; none was this)
alerts when a check breaks  0
```

So an invariant could break at 2am and the system told nobody. It became visible whenever a human
next opened the page — and even then the page could not say how long it had been true. **A dashboard
nobody is looking at reports nothing.**

Three things now exist that didn't. The score is **stored**, so it is a series rather than a
snapshot. A check **changing state** is an event with a time on it, kept as an episode — so a failing
check says *failing since 19:04:12*, and a check that fails, recovers and fails again leaves two
rows rather than one that forgets the first outage. And `trust.assess` joined the six recurring
sweeps, so the assessment happens whether or not anyone is watching. That last one is the whole
difference between a dashboard and a monitor: **one answers a question when asked, the other notices
while nobody is asking.**

An invariant breaking now alerts the author's reviewers — **once**. Only invariants (a quality check
dipping is worth seeing, not worth waking someone for), only on the transition, and never re-sent
while the breach persists, because re-sending on every sweep is how an alert channel gets filtered
into a folder nobody opens. A breach with no reviewer configured writes
`governance.breach_unreachable` rather than failing silently. The alert leaves by a declared outbound
path (`trust.alert_breach`) because STORY-020 refuses to send any other way — and refused this one
until it was declared.

**Why not TensorFlow.js.** The build note asks for it. With three detectors over tens of rows there
is no training data to learn from, an unexplainable anomaly score is worse than none on a dashboard
whose entire premise is that a reviewer can read *why*, and it would break the offline-reproducible
property the tests and demo depend on. The existing detectors each state their sample size and
decline to conclude below it, which is the property that actually matters here. Named in Known gaps
rather than quietly skipped.

Two things this story tripped over, both worth keeping:

**STORY-017's isolation check caught the new tables immediately** — they carry `author_id`, and rows
pointing at deleted authors read as orphans. The easy fix was to add them to the exclusion list
beside `audit_log`. That would have been wrong: the audit log is *the* record of what was done and
must outlive the account, while these are a derived read-model of one tenant's scores, and the
requirements ask for GDPR-compliant deletion. They got cascading foreign keys instead, and the
isolation check stayed strict. **Widening a security exclusion for convenience is how one gets
hollowed out.**

**STORY-020's scan caught this story twice.** First for writing `via: ALERT_PATH` — a named constant
rather than a greppable literal, which hid the declaration from the check built to find it. Then for
a *comment* explaining that very scan, which contained the pattern it greps for and was read as
code. The scan now strips comments before reading, and the `via` at each call site is a literal on
purpose.

### STORY-022 — the read-only role that could approve a press release

| Story build step | Where it lives |
|---|---|
| 1. RBAC module in the backend | `server/src/services/permissions.js` (STORY-019) |
| 2. Roles and permissions in PostgreSQL | `024_rbac.sql`, `026_approval_permissions.sql` |
| 3. Express middleware checking permissions | `requirePermission` in `server/src/middleware/auth.js` |
| 4. Integrate with audit log access **and approval processes** | audit log: STORY-019. **Approvals: this story.** |

STORY-019 built the RBAC, and both of this story's acceptance clauses passed before it started. Its
fourth build step named the half that had not been done — and measuring that found a hole I had
made three stories earlier.

**Eight approve/reject routes carried no permission check at all.** The approval gate — the control
REQ-006 is entirely about — asked whether the caller was signed in and in the right tenant. It never
asked whether they were allowed to *approve*.

**And the `compliance` role could approve content in any tenant.** That role was added by STORY-019
to read everything and change nothing, with tests asserting it cannot suspend a tenant or retire a
template. Against a real pending material in another author's tenant:

```
compliance POST /pr-materials/:id/approve   →  200  APPROVED
```

The mechanism is worth keeping. STORY-019 replaced `role === 'admin'` with `holds(user,
'tenant.read.all')` in three guards. Two of them — `enforceTenant` and `tenantParam` — decide which
tenant a request may *address*, and the substitution was correct. The third, `assertOwns`, decides
whether a caller may *act on a row*, and there it silently turned a read permission into a write
permission for all fourteen row-addressed actions: approve, reject, send, schedule, distribute.

It was invisible because at the moment of that change **only `admin` held `tenant.read.all`** — and
for an admin, reading everything and changing everything had always been the same thing. Adding a
role that could read and must not act is what pulled the two apart, and nothing was watching the
seam. A permission split that looks like a no-op is a no-op only until someone holds one half of it.

So reading across tenants and acting across tenants became different permissions, and approving
became a permission at all:

```
tenant.read.all → admin, compliance      (see every tenant)
tenant.act.all  → admin                  (change any tenant)
content.approve → admin, author          (decide on outbound content)
```

A permission on seven of eight doors is a gate on a building with eight, so the suite reads the
route file and counts rather than trusting a list somebody keeps in their head — the STORY-020 shape
again: a check that verifies the gates that exist cannot see a missing one, so this one looks for
the absence.

### STORY-023 — the channel that emails strangers was the least checked

| Story build step | Where it lives |
|---|---|
| 1. `AIContentGeneration` module using an AI API | `server/src/agents/aiContentGenerationAgent.js` (STORY-018) |
| 2. Service handling content requests | `contentDraftingAgent.js`, `prOutreachAgent.js`, `aiContentGenerationAgent.js` |
| 3. Drafts stored for review | `drafts`, `outreach_messages`, `pr_materials` |
| 4. **What was actually missing** | `027_outreach_grounding.sql` |

The story names three content types — social posts, outreach messages and PR materials — all aligned
with the book's themes and the author's voice. Two of them had both halves already:

```
social posts   retrieved themes (STORY-009) + measured voice (STORY-009)
PR materials   retrieved themes (STORY-006) + measured voice (STORY-018)
outreach       neither
```

Outreach was the one that *looked* done, which is why it survived six stories. `scoreMessage` had a
number called "grounding" and a number called "voice" — and both were the measures the other two
stories had already replaced.

**The grounding counted a theme as hit if any single word of it appeared anywhere.** "deep work" was
satisfied by the word "work" — including in *"I would love to work with you"* — and then floored at
0.55 for a single hit, so one accidental match scored 0.66. **The voice was vocabulary overlap with
prior posts**, the exact function `011_social_grounding.sql` records scoring 0.994 on copy breaking
every rule the author's own voice profile states.

Neither was a floor. `assess({ confidence })` was called with no `themeAlignment` and no `voice`, so
both were blended into one number and outvoted by personalisation, which carries 0.4. Measured
before the fix:

```
Hi Dana! I would absolutely LOVE to work with The Focus Podcast in London!!!
This is an incredible, game-changing, guaranteed-viral opportunity...

  confidence 0.79  →  QUEUED FOR ORDINARY APPROVAL
```

Its grounding of 0.66 came entirely from the word "work". The real voice check scores that text
**0.16**, with violations on exclamations, hype, shouting and vocabulary. And this is the channel
that emails a **named human at a podcast** with the author's name on it — the highest-stakes of the
three and the only one nothing was checking.

After: `confidence 0.53 · theme 0.00 · voice 0.17 → escalated` on all three reasons.

**The provider had to change too, not just the scoring.** Teaching the checker without teaching the
writer just escalates everything: the stub's real pitches scored 0.10–0.25 alignment the moment the
measure got honest, because it quoted a sentence picked at random out of the book — which is not
retrieval, it is whatever happened to be in range. It now writes from the claims retrieval found for
the themes each opportunity is about. Alignment went to **0.82–1.00 without a single threshold
moving**, which is the STORY-006 lesson repeating: alignment has to be something the drafter does,
not something done to the draft afterwards.

**Outreach is scored against the themes the pitch is actually about.** A press release can argue
four themes; a 1,200-character booking request cannot, and averaging across themes the pitch had no
business raising would cap every message below the floor. The grounding is narrowed to the
opportunity's matched themes, with the full theme list passed as `themeVocabulary` so narrowing
cannot grant credit sideways for naming a theme that was not being scored.

### STORY-024 — the walk that was correct about 29% of the surface

| Story build step | Where it lives |
|---|---|
| 1. `TenantIsolation` module | `server/src/agents/tenantManagementAgent.js` (STORY-017) |
| 2. PostgreSQL schemas per tenant | **not done — STORY-041 in R10; see below** |
| 3. Tenant-specific RBAC | `middleware/auth.js`, `024_rbac.sql`, `026_approval_permissions.sql` |
| 4. **What was actually missing** | `server/src/services/tenantSurface.js` |

STORY-017 built the cross-tenant walk that would have caught its own leak: sign in as one tenant,
request every list route, assert no response carries another tenant's id at any depth. It found two
real leaks and it works.

It also kept its routes in a hand-written array, and the array stopped growing. Measured at the start
of this story: **10 of 35 GET routes were in it.** Everything added since — `/audit-log` (gated by
STORY-019, re-gated by STORY-022), the trust history from STORY-021, the on-demand press route from
STORY-018 — was never walked.

STORY-017's own Known-gaps entry predicted this in so many words: *"a new handler written the same
careless way is caught only if someone adds it to that test."* Six stories went by. Nobody added
one — including across four stories where I was the one adding the routes.

So the surface is derived from `router.stack` rather than typed out, and not by grepping the source,
because the source is where a typo hides and the stack is what the server actually serves:

```
before:  10 of 35 GET routes walked, list maintained by hand
after:   30 walked · 5 declared unwalkable with reasons · 0 unaccounted
```

The five exemptions each carry a written justification — `/health` and `/ready` are public because a
load balancer has no session; `/audit-integrity` verifies one log across every tenant, so tenant ids
in it are the subject rather than a leak. A reviewer can disagree with any of them, which is the
point: an exclusion nobody can see is indistinguishable from a check that never ran.

**Every walked route returns 200.** A walk that returns early on a non-200 can pass without ever
reaching its own assertion, so that was measured rather than assumed — 30 of 30 genuinely answer and
are genuinely inspected.

**What the wider walk found: nothing.** Thirty routes, zero leaks. STORY-017's fixes held and the
routes written since were written correctly. That is worth stating plainly rather than dressing up —
a check that finds nothing is not a check that did nothing.

`tenant.surface_walked` is a governance invariant so the coverage cannot rot again, and it fails
usefully: adding a row-addressed route during development turns it red and names the offender.

**Why not schema-per-tenant.** The build note suggests PostgreSQL schemas or separate databases.
That is **STORY-041, "Tenant Database Schema Isolation", scheduled in R10** — pulling it forward
here would be doing a later release's architecture work inside a story whose acceptance criteria are
about data being isolated and access being role-based, both of which already hold.

### STORY-025 — the failure the system knew about and the author did not

| Story build step | Where it lives |
|---|---|
| 1. `APIIntegration` module for social APIs | `server/src/services/socialApis.js`, `agents/apiIntegrationAgent.js` |
| 2. OAuth for secure authentication | **not done — deferred with reasoning; see below** |
| 3. Endpoints to schedule and publish approved posts | `POST /api/drafts/:id/schedule`, `/scheduled-posts/publish-due` |
| 4. **What was actually missing** | `server/src/services/publishFailureNotifier.js` |

The first acceptance clause — an approved post gets scheduled and published — has worked since
STORY-001, and STORY-016 gave the call real timeout, retry and classification policy. The second
clause asks the system to log an API failure **and notify the user**, and only the first half
existed.

Measured before building. On a failed publish:

```
scheduled_posts.status = 'failed', with the provider's message   yes
a post.failed audit row with before/after                        yes
a row on the Schedule tab, if somebody opened it                 yes
a notification to anyone                                          NO
a governance check that would notice                              NO
a place in any queue a human works from                           NO
```

The failure was *recorded* and nobody was *told*. That is the worst shape an outbound failure can
take — the system knows, and the only person who needs to know does not. An author whose post
silently failed goes on believing it went out, and the only way to learn otherwise is to open a table
they have no reason to open.

The notification schema had no column for a scheduled post, so this could not have been a bug in the
notifier; it was an absence in the schema, the same finding `018` recorded about drafts.

**What the notice is careful to say.** It names the platform, the provider's own message and the
post's opening words — and then states the thing a reader most needs: *nothing was published that
should not have been*. "Published without approval" and "never published at all" are opposite fears,
and a notice that does not distinguish them sends the reader to check the wrong thing.

Announced **once per post per reviewer, ever**. A failed post stays failed, and a sweep on a timer
would otherwise re-announce every past failure until the channel got muted — the rule STORY-012 set
for the approval digest and STORY-021 reused for a persisting breach. It runs as
`posts.notify_failures`, the eighth recurring sweep, so nobody has to remember to look.

The return value distinguishes three states a bare count would collapse: **nothing failed**,
**already announced**, and **nobody to tell** — the last recorded as
`publish.failure_unreachable`. `posts.failures_announced` counts only failures for authors who have
an active reviewer, so a missing reviewer cannot disguise itself as a missing notification; they are
different findings with different fixes.

**Why not OAuth and live platform SDKs.** The build note asks for both. The publishers are still
deterministic mocks returning `twitter_000001`. No developer accounts exist for this project, and
swapping in live SDKs would end the offline reproducibility that 628 tests and 170 demo stages
depend on — while adding per-author token storage and refresh that nothing could exercise end to
end. That is the "mocks hide the work" trap STORY-016 already found once, in reverse. Named here
rather than half-built.

### STORY-026 — an objection answered for a third of the system

| Story build step | Where it lives |
|---|---|
| 1. `ContentReview` module handling escalation | `server/src/agents/trustMonitoringAgent.js` (STORY-008) |
| 2. Machine learning for confidence and anomalies | **not done — statistical detectors; see below** |
| 3. Endpoints for escalating content | `POST /api/authors/:id/trust/scan`, `GET /api/authors/:id/escalations` |
| 4. **What was actually missing** | `029_escalate_all_content.sql`, `anomalies.js` |

STORY-008 built the independent monitor on one sentence in its own module comment: *"an agent that
both writes the material and decides whether the material is good enough has no one checking the
second half."* That objection was answered for **one content type out of three**.

`monitorPressMaterials` queried `FROM pr_materials` and nothing else — and could not have done
otherwise. The `escalations` table had a `pr_material_id` column and no column for a draft or an
outreach message, so recording one for a social post was *impossible*. The same shape `018` found in
`notifications` and `028` found again for scheduled posts.

Measured, reproducibly across runs: **the monitor examined 5 items where 10 were decidable.** It was
blind to exactly half the work waiting on a human. What that costs shows up the moment a standard
moves — tighten the voice floor from 0.5 to 0.9 and press gets re-judged while drafts and outreach
keep whatever verdict the agent that wrote them gave itself.

**Widening it broke two things that had assumed press**, both caught here rather than by a user:
`listEscalations` and `notifyRaisedEscalations` inner-joined `pr_materials`, so a draft escalation
would have been dropped from the read-model and **notified nobody** — the STORY-025 finding,
reintroduced by the fix for a different one.

**The second clause had nothing at all.** Three anomaly detectors existed and every one watched
*reviewer* behaviour — who approves in seconds, who never rejects, where the monitor disagrees with a
producer. None looked at content, and none escalated anything; they reported to a dashboard and moved
nothing.

`content.near_duplicate` looks at the content and escalates. On its first real run it found the
**stub generator repeating itself**:

```
2 drafts say the same thing: 3, 8      facebook · Sep 14, Sep 21
3 drafts say the same thing: 5, 10, 16 twitter  · Sep 14, Sep 21, Oct 12
3 drafts say the same thing: 14, 60, 61 twitter, instagram · Sep 28, Oct 26
```

The author's feed would have carried *"On craft, and what it actually costs."* three times. Every
one of those drafts scores perfectly on its own — well-grounded, in voice, above every floor. **The
anomaly exists only between drafts**, which is what "deviates from typical patterns" means and why no
amount of scoring one draft at a time could find it.

**It was wrong twice before it was right, and both are worth recording.** The first version reported
pairs, so twelve identical drafts arrived as sixty-six findings — a detector nobody would read. The
second reported **40 false positives**: the demo seeds `simulated post 0` … `simulated post 39`, and
a tokenizer that dropped digits reduced every one of them to `{simulated, post}`, matching at 100%.
The fix was not a length floor — that excluded 47 of 62 drafts and lost real repetitions — but
keeping numbers as tokens, which separates the fixtures at 50% while leaving short social posts
comparable.

**Why not machine learning.** The build note asks for it. Same answer as STORY-021: no training data
at this size, and an anomaly score a reviewer cannot audit is worse than none on a system whose
premise is that every judgement is legible. "These three drafts share 100% of their distinctive
words, here they are" is a claim somebody can check by reading them.

### STORY-027 — the record that could say "started" and never "died"

| Story build step | Where it lives |
|---|---|
| 1. `HealthMonitoring` module performing regular checks | `server/src/services/healthMonitoring.js`, run by `index.js`, `worker.js` and the `system.health_check` sweep |
| 2. Docker and Prometheus for system monitoring | **not done — nothing installed, nothing to scrape; see below** |
| 3. PagerDuty for downtime alerts | `alertOnOutages` → the mock email adapter, to accounts holding `system.operate` |
| 4. **What was actually missing** | `030_health_monitoring.sql`, `requestStats.js` |

STORY-015 built `/health`, `/ready` and a `deployments` table, and read quickly the acceptance clause
— *"when health checks are performed, system status is logged and displayed"* — looks done. Measured
before writing anything:

- **Nothing performed a health check.** Both endpoints answered when asked and the answer was thrown
  away. 24 `deployment.*` rows on the audit log, none of them a check.
- **`deployments` decided an instance was running by whether it had written a stop row.** A process
  killed with SIGKILL, or a host that loses power, cannot write one — so the table's answer to "what
  is running" was really *"what has not said goodbye"*, and it would say `ready` about a dead process
  forever.
- **The worker had no row at all.** The process that runs every sweep in the system was invisible to
  the record of what is running.
- **There was nobody to tell.** Every alert this system sends goes to a tenant's `reviewers`, and an
  outage belongs to no tenant.

So liveness became something a process *demonstrates*: every instance writes `last_seen_at` on a
timer, and a monitor — run by the API every 30 s, by the worker on its sweep, and by an operator from
the Trust tab — probes the database, reads every heartbeat, probes every API instance at its own
`/api/ready` over HTTP, and writes one `health_checks` row per target. A component changing state is
an `outages` row with `down_since` (the last heartbeat, not the moment somebody looked), `detected_at`
and `alerted_at`; the gap between the first two is the number that grades the monitoring rather than
the system. Outages close when a check finds the component up. Never because time passed.

**Who gets paged is a permission.** `system.operate`, granted to `admin`, held by `ops@example.test`
in the seed. STORY-019's argument again — "the infrastructure team" is a capability, and the person
who must be woken at 3am is not necessarily the person who may suspend a tenant.

**The API and the worker check each other, and neither can check itself.** Each is the only thing
positioned to notice the other is gone. Both gone at once is noticed by nobody here, and that is the
outside probe a real deployment still needs.

**The first real outage it caught was the laptop going to sleep**, and it paged the operators about
the process that was paging them. On waking, the API's monitor fired before its own heartbeat did,
read its own stale beat, and opened an `api` outage on itself. The checker now refreshes its own
heartbeat rather than reading it — a process can observe that it is running. The 1,060-second
detection lag on that outage is left on the record; it is correct, and it is what monitoring from
inside the thing being monitored looks like.

Measured with real processes, awake: a worker killed with `kill -9` was detected by the running
API's timer and `ops@example.test` was emailed, unattended, in **284 s** — longer than the 90 s the
intervals promise, and the record says so rather than the intervals.

**Up is a low bar.** An instance answering every request with a 500 is up, ready, and useless, so
each API heartbeat carries a snapshot of its last 500 requests — count, error rate, p50, p95 — and
the Trust tab shows them beside the pill. The row of record is the heartbeat; writing a row per
request would make the monitoring the heaviest thing the database does.

**Why not Prometheus and PagerDuty.** Neither is installed, neither has an account, and a scrape
config for a server that does not exist would be the STORY-015 Dockerfile again. What is here is the
part those sit on top of: something that measures, something that remembers, something that tells
someone. The notifier is one call site; the metrics they would scrape are the rows this writes.

### STORY-029 — two relationships that were both the platform

| Story build step | Where it lives |
|---|---|
| 1. `PerformanceMetrics` module to track and analyse | `server/src/services/performanceMetrics.js`, the `engagement.collect` sweep |
| 2. PostgreSQL table `content_metrics` | `031_content_metrics.sql` — a history, beside STORY-069's snapshot |
| 3. REST endpoints for the dashboard | `GET /api/authors/:id/content-performance`, the Performance tab |

STORY-069 built engagement collection and one analysis over it, and against this story's clause —
*tracked*, *displayed*, *analysed for insights* — what existed was thinner than it looked:

- **Collection ran when a human pressed a button.** Zero recurring sweeps; every collection ever was
  the demo's. "Tracked" means on a timer.
- **One reading per post, overwritten.** No history, so "is this post still earning or has it
  stalled" was unanswerable — a post that stopped at 900 impressions and one still climbing were the
  same row.
- **One question was asked of the data.** Memes or text. Nothing asked which platform earns more,
  whether the scheduler's "optimal window" (STORY-001, every post since) does anything, or whether
  the two scores this system escalates drafts on — theme alignment and voice — relate to how a post
  performs once it is out.

So: `content_metrics` keeps every reading, `engagement.collect` fills it on the worker's sweep, the
mock accrues with age so a series shows a post filling in, and `contentPerformance` asks four
questions of the result, each in STORY-069's shape — state the sample, decline below it, say what
the evidence was when concluding. The format question is answered by STORY-069's own function,
called rather than copied, because the mix recommender already acts on that one.

**The first version found two relationships that were not there.** On the demo data — a collector
that has never read a draft and does not know what time it is — the timing question came back
*"in-window posts lead"* and theme alignment came back **r = 0.37 over 66 posts, t = 3.2**,
significant at any textbook threshold. Both were the platform. Instagram's best hour is 16:00, so
every instagram post was "in-window", and instagram's mock base rate is double twitter's; the pooled
cell was measuring which platform a post was on. The fixtures with the highest theme scores happened
to be the instagram ones. Held within platform, with engagement taken relative to posts on the same
platform and format, **r = 0.37 became r = 0.00 without a single reading changing.** STORY-006's
alignment score again — a number named after the right thing, measuring a different one — in a
different room, and a regression test now plants the confound on purpose.

**Every reading is mocked, and the page says so beside the chart** rather than in this file. The
adapters are the mocks STORY-025 left with reasons; `content_metrics.source` says `mock` on every
row and will say `platform` the day one is real.

### STORY-031 — the clause about headers, not the build note about Next.js

| Story build step | Where it lives |
|---|---|
| Security headers with Helmet, CSP, HTTPS | `server/src/services/securityHeaders.js` — one policy; `app.js` (helmet), `vite.config.js`, `client/nginx.conf` |
| Responsive | `client/src/styles.css`, the STORY-031 block |
| "Create a new React app using Next.js … Tailwind" | **Not done, on purpose** — see below |

Written as *"given a new project repository"*. There has been a React app since R0 — Vite, eleven
tabs, ~3,900 lines — so the acceptance clause is the loop stop, and against it, measured:

- **No security header on any response.** API, Vite and nginx all sent none. No CSP, no HSTS, no
  HTTPS enforcement, and `cors()` answered every origin on the internet.
- **No media query in the stylesheet.** At 390px wide, **10 of 11 tabs scrolled the whole page
  sideways** — Worker by 1,423px, and Worker overflowed on desktop too.

**The clause's CSP, applied literally, breaks the product.** `default-src 'self'` is there, verbatim.
But meme artwork is stored as `data:image/svg+xml` (STORY-067), `img-src` falls back to
`default-src`, and every meme preview on Review and Templates renders as an empty frame. So exactly
one directive widens it — `img-src 'self' data:` — declared in `CSP_EXEMPTIONS` with its reason, and a
test fails if any other widening appears without one. No `'unsafe-inline'`: React's `style={{…}}`
goes through the CSSOM, which CSP does not govern.

**One policy, three senders.** The API sends it through helmet, Vite imports it, and nginx — which
cannot import JavaScript — carries a copy the test suite compares header by header. Development gets
it as *Report-Only*, because React fast-refresh injects an inline script and a dev server that blocks
its own hot reload gets its policy deleted; `vite preview` and nginx enforce.

**HTTPS is enforced where the connection is real.** On by default in production: a plain-http GET is
redirected (308), anything else is refused (403) rather than redirected, because its body has
already crossed in the clear. `/api/health` and `/api/ready` stay reachable over http for the load
balancer. `X-Forwarded-Proto` is trusted only when enforcement is on.

**Proved in a browser, not a header string.** `npm run check:browser` loads every tab in Chrome at
two widths under the enforced policy: 22 loads, 0 violations, 0 overflow, every meme image shown. Its
control run, under the literal clause, blocks 12 of 12 images. It also found an unrelated bug: the
Audit tab asked every author for `/audit-integrity`, which only compliance may read, and swallowed the
403 — no panel, but a refused request in the console on every visit. It now asks only when the
session holds `audit.verify`.

**The first responsive fix was wrong, and the check passed it.** It used `overflow-wrap: anywhere` on
table cells, so every table "fit" a phone by breaking words into three-letter columns — no page
overflow, nothing readable. The browser check measured overflow, not readability, and reported a
clean pass; the screenshot is what showed it. The check now also counts *crushed* cells (narrower than
~5 characters holding a longer word): 56 on Press, 20 on Worker, 1 on Trust under the old rule, 0 now.
Tables keep a readable width and scroll inside their card.

**Not rebuilt in Next.js or Tailwind.** Rewriting a working app to reach a clause about headers and
layout would spend the whole story on the part nobody asked to change, and would re-open every
screen eighteen stories have been checked against. That is a scope decision the backlog owner should
make knowingly rather than one an implementer makes by default; it is named here for that reason.

### STORY-032 — 28 routes crashed on bad input, and one stored it

| Story build step | Where it lives |
|---|---|
| Input validation using Joi | `server/src/middleware/validate.js`, `server/src/routes/schemas.js` |
| JWT authentication | Since STORY-064 — `middleware/auth.js`; re-asserted in `inputValidation.test.js` |
| "Structure with controllers, services, models" | Services exist; **routes not split** — see below |

JWT has existed since STORY-064. Input validation had not — no library, no schema. Measured by
sending malformed input to all 77 routes:

- **28 answered 500.** Every row-addressed route handed `NaN` to Postgres for a non-numeric id and
  returned the database's own words — `invalid input syntax for type bigint: "NaN"` — to the caller.
  Three more crashed in JavaScript (`platforms.includes is not a function`).
- **One stored it.** `POST /authors { name: 123, email: ["x"] }` answered 201 and saved the email as
  the text `{"x"}`. In the product: an author pasting `twiter | …` into the Upload tab was told
  *"Added 2 prior posts"* and the typo was stored as a platform.

Now every route that reads a body or query string declares it, per part, and the handler receives
only what was declared, converted to the declared type. Path ids are checked once, on
`router.param`, so a route added later that names `:id` is guarded without anyone remembering.
**0 of 77 routes crash on bad input.** Errors name every wrong field (`details`), and the Upload tab
turns them into "Line 1: "twiter" is not a platform posts are drafted for".

**Stripping is only safe if proven.** Unknown fields are stripped rather than refused, so the UI's
harmless extras don't become outages — but that silently deletes any field a handler reads and its
schema forgot. So `inputValidation.test.js` reads every handler's source from the live router and
fails on the first field read but not declared; it was seen to fail when `awardName` was removed
from one schema on purpose.

**Authorisation before validation.** The first version validated first, so a compliance session
posting a template got a 400 listing the input rules of an action it may not take. The existing
RBAC suite caught it; validation now sits behind `requirePermission` on all 13 guarded routes.

**Not done: splitting the 1,500-line routes file into controllers.** It changes no behaviour, and
every scan that proves a property of the API — tenant walking (STORY-024), input coverage — reads the
live router, so the split can be done mechanically when it is wanted.

### STORY-033 — the account that writes the audit log could erase it

| Story build step | Where it lives |
|---|---|
| Role-based access control in the database | `032_database_roles.sql` — `ale_app`, `ale_readonly`, `ale_app_login` |
| Secure access, reported | `/ready` privileges check; `db.least_privilege` on the Trust tab |
| "Create schemas using Sequelize" | **Not done, on purpose** — see below |

STORY-019 built permissions in the application. The database under it had none. Measured:

- **The API connected as `anvi`, a Postgres superuser that owned all 46 tables.** Anything that got
  code running in the API could drop any table or grant itself anything.
- **The audit log's append-only promise was defeatable by the account that writes it.** Three
  triggers refuse UPDATE/DELETE/TRUNCATE — and the table owner can switch them off. Stages 103–105 of
  the demo did exactly that, through the application's own pool.

Now the application runs as **`ale_app_login`**, a member of **`ale_app`**: SELECT/INSERT/UPDATE/DELETE on
rows, no schema, no TRUNCATE, **insert-only on `audit_log` and `audit_checkpoints`**, read-only on
`schema_migrations`. **`ale_readonly`** reads everything and writes nothing — the database counterpart
of STORY-019's `compliance` role. Migrations run as the owner through `MIGRATION_DATABASE_URL`.

- **A separate login, not `SET ROLE`.** A superuser session that can SET ROLE can RESET ROLE, so an
  injected statement would simply switch back. Only a login that never held the power is a boundary.
- **Two walls.** The privilege stops the application; the trigger still stops a mistaken UPDATE by
  anyone who has the privilege — including the owner. Getting past both now takes the owner's
  credentials, which is the threat STORY-013's seals exist to detect.
- **The whole suite and the demo run as the restricted login.** The only things that needed the
  owner were migrations and the demo's deliberate tampering (`ownerQuery` in `db/pool.js`). Six
  tamper tests now fail at the privilege, before the trigger, and accept either refusal.
- **Coverage is tested, not listed.** New tables get grants by default privileges, and a test fails
  if the set of tables the app cannot update is anything other than the declared append-only ones.
- **Reported.** `/ready` refuses traffic in production when the app is a superuser or owner, and the
  Trust tab's `db.least_privilege` check fails wherever it is — shown failing with the app pointed at
  the owner, and passing on the login.
- **No password in the repository.** `ale_app_login` has none locally (Homebrew trusts localhost);
  `APP_DB_PASSWORD` is applied by `migrate.js` where one is needed. CI and compose set it.

**Not done: Sequelize.** The schema is 32 hand-written migrations whose comments carry most of this
project's reasoning. An ORM on top would be a second description of the schema, free to disagree with
the first — the drift this project has refused everywhere else.

Also found while here: a STORY-029 test asserted "no relationship" on a freshly random sample every
run, which fails about one run in twenty — what a 95% interval means. Its fixtures are now fixed.

### STORY-034 — nineteen stories of "reviewed, not run"

| Story build step | Where it lives |
|---|---|
| Dockerfiles for frontend and backend | `server/Dockerfile`, `server/Dockerfile.worker`, `client/Dockerfile` — digest-pinned, non-root |
| Docker Compose, services communicating | `docker-compose.yml` — **repaired**; `client/nginx.conf` forwards the scheme |
| Image scanning with Clair | `.github/workflows/ci.yml`, `images` job — **written, never run** |
| (added) dependency scanning | `npm run scan:deps`, gating CI before the tests |

**Docker is not installed here and never has been**, so the images have never been built and Clair
has never scanned one. What *can* be proved without Docker is proved by `containerPolicy.test.js`,
which reads the files the way Docker and a reviewer would. Against the files as STORY-015 left them it
fails 12 of 22 checks, and it found two real defects:

- **`docker-compose.yml` defined one service.** The top-level `volumes:` block sat between `postgres`
  and `migrate`, so YAML read migrate, api, worker and client as *volumes*. `docker compose up` could
  only ever have started a database. Moved to the end; the test parses the file as Compose does.
- **The stack would have refused its own UI.** STORY-031 made the API enforce HTTPS in production,
  reading `X-Forwarded-Proto`; in the stack the API is in production behind nginx, which never sent
  that header. Every browser call would have looked like plain http. nginx now forwards the client's
  scheme (the terminator's, or its own), and the local stack sets `ENFORCE_HTTPS=false` because it has
  no TLS terminator — set it true where one exists.

Also: **no `.dockerignore`**, so every `COPY` shipped host `node_modules`, build output and any `.env`
into an image layer — now excluded. Base images **pinned by digest** (a tag names whatever was pushed
last, so a scan of one build says nothing about the next). nginx replaced by
**`nginx-unprivileged`**, which does not start as root. The app and worker containers use STORY-033's
restricted login.

**The scan that runs here.** `npm audit` found **3 moderate in production** — `qs`, via Express, one a
denial of service in the query-string parser every request passes through — and **3 high in
development**, via `puppeteer-core`, which STORY-031 added for the browser check. Fixed, not muted:
0 now. In CI as a gate before the tests.

**The scan that does not.** The `images` job builds all three images, `docker save`s them and runs
`quay/clair-action@v0.0.16` on each, with **`return-code: '1'`** — the action's default is `'0'`,
which reports vulnerabilities and passes the build, so the example in its own README is a scan that
can never fail CI. Written against the action's published `action.yaml`; never executed.

### STORY-038 — the gateway whose header was not true

| Story build step | Where it lives |
|---|---|
| 1. An API gateway | `callExternal` in `agents/apiIntegrationAgent.js` (STORY-016), extended — **not Kong or AWS**; see below |
| 2. Routes and policies per integration | `services/integrationRoutes.js` — undeclared services refused |
| 3. Monitoring and logging | `api_interactions` (STORY-016), `short_circuited` outcome; Trust tab integrations panel |
| 4. All interactions routed through it | Directory search now routed; source scan in `integrationGateway.test.js` |
| 5. Failure detection and alerting | Per-integration circuit (`integration_circuits`), `integration.circuit_opened`, operators alerted |

STORY-016's gateway header said every outbound call went through it — *"the social platforms, the
email provider, the directory search, and the Anthropic content API."* Measured:

- **The directory search did not.** All three directories behind opportunity scouting were called
  directly: no timeout, no retry, no record — and absent from the Trust tab, which listed only what
  had been logged. A live directory that hung would have hung the scout.
- **One policy for everything.** 10 seconds and 3 attempts for email and for an AI generation that
  takes twenty.
- **A failure was logged and nobody was told**, and a provider that was down got three attempts with
  backoff on every call for as long as it stayed down.

Now every integration is **declared** with its own policy — Anthropic 60s × 2 (a retry is a second
paid generation), directories 8s × 2, social and email on the STORY-016 defaults — and `callExternal`
refuses a service nobody declared, the way `assertDeclaredPath` refuses an undeclared outbound path
(STORY-020). The Trust tab lists every declared integration, called or not, with its policy.

**The circuit.** Per integration, in the database so the API and worker share it. After
`failureThreshold` failed *calls* in a row the circuit opens: the gateway stops calling that provider
(logged as `short_circuited`, not as a failure), records `integration.circuit_opened` and **emails the
operators — once**. After the cooldown one trial call goes through; success closes it with how long
it was down, failure re-opens it without paging again. **A 4xx never counts** — a post too long for
the platform is the provider answering correctly, and counting it would let one bad draft take a
platform offline for everyone. **Email cannot be alerted about by email**; its outage is recorded as
`integration.alert_unreachable` and shown on the Trust tab. One directory being down no longer
empties the scout: the others' listings still arrive, and the panel shows why there are fewer.

**Found in its own screenshot:** the first version counted a short-circuited call as a call and an
attempt, so an open circuit looked like heavy traffic to a dead provider — the opposite of what
happened. Refused calls are now counted separately, with a test.

**Not Kong or AWS API Gateway.** Both are a network hop in front of the providers, and neither exists
here to configure. What the clause asks for — every interaction through one place, a policy per
integration, failures detected, logged and alerted — lives in the module every adapter already calls,
and a source scan fails the build if production code calls out around it.

### STORY-039 — eleven agents, and not one message between them

| Story build step | Where it lives |
|---|---|
| 1. A message queue | `agent_messages` (`034`) + `services/messageBus.js` — Postgres; RabbitMQ via `amqpTransport.js` |
| 2. Producers and consumers in the agents | Trust monitor and scheduler send; `jobs/messageHandlers.js` receive |
| 3. Serialised and deserialised correctly | `serialize()` — Dates as ISO, refuses what JSON would silently lose |
| 4. Tests | `tests/messageBus.test.js` — the RabbitMQ scenario runs where `AMQP_URL` is set |

Measured: agents reached each other by direct function calls or by polling a table on a five-minute
sweep. When the monitor escalated a draft, the reviewer heard at the next sweep — **up to 300
seconds** — and nothing recorded that one agent had told another anything.

Now an agent that needs another to act **sends a message in the same transaction as the change it
describes** (the outbox pattern — a message exists if and only if its change committed, which a
broker alone cannot promise), and the worker delivers it on every poll: **within 5 seconds instead of
300**. Each recipient declares the topics it accepts, and anything else is refused at send time.
Delivery is at-least-once: SKIP LOCKED so two workers never take the same message, redelivery after a
60-second visibility window, retries with backoff, then a dead letter shown on the Worker tab with a
Redeliver button — never dropped. Every message is on the audit log twice, `message.sent` by the
sender and `message.received` by the recipient, with both agents and the latency. Handlers are the
existing idempotent notifiers, so a burst of messages is still one email per item; the sweeps still
run, so a message lost to a bug is a late notice, not a missing one.

**Serialisation refuses what JSON would silently lose:** an `undefined` field (dropped without a
word by `JSON.stringify`), BigInt, functions, NaN, cycles. Dates become ISO strings on purpose.

**RabbitMQ, which the story names, is not installed here.** `amqpTransport.js` uses it as the carrier
— relaying from the outbox table with publisher confirms, consuming per-agent queues — with the table
still the record of truth. CI runs a digest-pinned RabbitMQ service beside Postgres and sets
`AMQP_URL`, so the broker scenario runs there; locally it reports itself **skipped**, never passed.

**A clock bug, found by a 1-in-60 flake.** The queue compared the worker's clock with timestamps the
database wrote. On one machine that is milliseconds; across two it is however far the clocks drift,
and a slow worker would delay every message by that much. When no time is given, the database's
clock decides what is due.

### STORY-040 — the notifier that said "notified: 2" when nobody had been told

| Story build step | Where it lives |
|---|---|
| 1–3. Task manager, priority and availability criteria, assignment | `TASKS` in `services/coordination.js`; the claim in `jobs/queue.js` |
| 4. Integrated with the message queue | The same tick claims tasks and delivers messages (STORY-039) |
| 5. Tests | `tests/taskManager.test.js` |
| Trust: assignments logged and reviewable | `task.dispatched` / `task.deferred`; `tasks.priority_respected`; Worker tab |

STORY-011 built the coordinator — a priority per kind, an exclusive resource, a record per dispatch.
Measured against this story:

- **Deferrals were never recorded.** `recordDispatch` had a branch for "held back", documented as the
  interesting half, and nothing called it. A stalled queue looked exactly like an empty one.
- **Two kinds fell to the default priority** and were described by a reason — "produces work other
  agents react to" — that was false for both.
- **Availability meant only "is the resource held".** With email's circuit open (STORY-038),
  `approvals.notify_waiting` ran anyway: both sends were refused by the gateway, the notifier recorded
  the items as announced — it deliberately never re-announces a failed send — and the job reported
  **"notified: 2"**. Nobody had been told, and those items would never be announced.

Now every kind is **assigned to a named agent** on declared grounds — priority, reason, and the
integrations it `requires` — stored on the job. A task whose integration is down **waits without
spending an attempt** until the circuit will take a trial call (released then, or nothing would ever
test whether the provider is back), and the wait is recorded **once per reason**, not once per
five-second poll. Every dispatch records **what it went ahead of**: each higher-priority task still
waiting and what blocked it, read in the same statement as the choice. Both notifiers now report
failures apart from deliveries, and log them as failures.

**The review check was wrong twice before it was right, both times on the demo's own data.** First,
blockers were looked up after the choice; with two workers, a resource held at the moment of choosing
had been released by the moment of looking — a correct choice recorded as a wrong one. Then two
workers took priority-25 tasks in the same millisecond a priority-30 task was mid-claim by a third,
which started 8ms later. `tasks.priority_respected` now judges by consequence: a passed-over,
unblocked task counts only if it was then kept waiting more than 5 seconds, or never run.

**Not changed, flagged:** a failed announcement is still never retried — STORY-012's choice, so no
reviewer is told the same thing twice. Holding the job while email is down removes the common case;
the trade-off itself is a product decision.

### STORY-041 — isolation the database enforces, not each query

| Story build step | Where it lives |
|---|---|
| 1. PostgreSQL with multiple schemas | `036_tenant_schemas.sql` — `ale_provision_tenant`, rebuilt from the catalogue |
| 2. Schema created on onboarding | `onboardTenant` → `provisionTenant`; `tenant.schema_created` on the audit log |
| 3. Each tenant's queries against their schema | `middleware/tenantScope.js` — every author GET, on by default |

Measured: **the database enforced no separation between tenants.** The application's login reads
every author's rows; isolation lived entirely in each query's `WHERE author_id = …` — the clause
STORY-017 found missing from two routes.

**Not a copy of every table per tenant.** That means every query routed to the right copy, every
migration applied once per author, every compliance and operator view a union across all of them —
a rewrite of the data layer. Instead each tenant gets **`tenant_<id>`: a schema of `security_barrier`
views** over the shared tables showing only its rows (tables that carry `author_id`, views such as
`escalation_targets`, and tables owned through a parent, like `draft_themes` → `drafts`), and a role
**`ale_tenant_<id>`** that can read only that schema and the declared shared reference tables (through
one group role, `ale_tenant`). Rebuilt from the catalogue, so migrations re-provision every tenant and
a new table is covered — or refused, until someone classifies it in `tenant_shared_tables`.

**An author's GET requests run as that role**, read-only, with their schema first on the search path —
on by default for every GET route, so a route added later is isolated without anyone remembering.
All queries during the request — `query`, `pool.query`, `withTransaction` — go to the scoped connection,
so code written long before this story is isolated without being edited. A route whose query has **no
WHERE clause at all** returns only the caller's rows; the test for it fails when the scope is removed.
35 of 39 GET routes are scoped; the other four are declared with reasons (`/health`, `/ready`,
`/auth/me`, and the trust dashboard, which verifies seals over every tenant's rows and writes).
Sessions that read across tenants (admin, compliance) are not scoped. The Trust tab's **Your data**
panel shows the role the page's own reads ran as.

**What switching it on broke, each a real difference:** `GROUP BY k.id` with `k.*` is legal on a table
(the key implies the columns) and not on a view; the first provisioning walked tables and missed
`escalation_targets`; another author's book now answers **404** rather than 403 — inside your schema
it does not exist, and 404 does not confirm the id is somebody's; and two tenants provisioned at once
collided editing one permission list, which is why shared grants go through the group role and
provisioning takes a lock. Also: roles outlive `db:reset` and schemas do not, so the scope checks for
the **schema**, not the role.

**The limit, stated and pinned by a test.** Postgres always lets a session return to the login it
connected as, so `RESET ROLE` works inside a tenant scope. This stops the leak this project actually
had — a query that forgot its filter — not an attacker who can already run arbitrary SQL; that is met
by parameterised queries and STORY-033's login. A database login per tenant would close it at the cost
of a connection pool per author. The pinned test fails the day that is built.

### STORY-042 — nobody changes access alone

| Story build step | Where it lives |
|---|---|
| 1. Authentication | JWT since STORY-064 — **Passport.js not adopted**; it would change nothing the clause asks about |
| 2. RBAC for tenant-specific permissions | STORY-019's permissions, STORY-017 and STORY-041's isolation |
| 3. JWT sessions and tenant identification | Tokens now carry an access version, re-read when stale |
| Trust: role/permission changes reviewed and approved | `037_access_changes.sql`, `services/accessChanges.js`, the Access tab |

The acceptance clause — a user reaches only their own tenant's data — has held since STORY-017 in the
application and STORY-041 in the database. The trust line had three holes, all measured:

- **No reviewed way to change access existed.** Grants changed by editing `role_permissions` in SQL.
- **One admin could mint another.** `POST /tenants { role: "admin" }` answered 201; the account signed
  in with all eight permissions; the log said `tenant.onboarded` by an agent.
- **A revoked permission kept working.** Permissions ride in the session token; an author approved a
  draft after `content.approve` was taken from authors — for up to twelve hours.

Now every grant, revocation and role assignment is a **request** with a reason (`access_changes`), and a
**different admin decides it** — refused by the service in words and by the database as a constraint
(`decided_by <> requested_by`). Approval applies the change in the same transaction through
**`ale_apply_access_change`**, which re-checks the approval; the application login **no longer has write
access** to `role_permissions` or `users.role` at all. Onboarding refuses anything but an author, and a
repeat sign-up no longer rewrites a role. Tokens carry the **access version** they were issued under;
a session behind the current version has its role and permissions re-read before it is trusted, so a
revocation bites on the **next request**. Every request, decision and application is on the audit log
with who asked and who agreed, and the invariant **`access.elevated_reviewed`** fails for any account
with more than author access that no approved change — or owner-written `bootstrap` record, for the
seeded accounts — accounts for. A second seeded admin, `security@example.test` / `second-pair-of-eyes`,
exists because with one admin nothing can be approved.

**Found in STORY-041, by this story's first test.** Tenant views showed every row with no author to
every tenant — right for a system-wide job, wrong for `users`, where no author means a staff account.
An author could read every admin's row. Rows with no author are now **private unless a table declares
them system-wide** (`tenant_system_rows`, with reasons), and an explicit classification beats foreign-key
discovery. And the Access view is not for `audit.read` alone — authors hold that for their own trail.

### STORY-043 — onboarding by invitation

| Story build step | Where it lives |
|---|---|
| 1. Onboarding UI for admins | The **Tenants** tab (`client/src/pages/TenantsPage.jsx`) |
| 2. Tenant creation and schema setup | `onboardTenant` in `agents/tenantManagementAgent.js`, STORY-041's `provisionTenant` |
| 3. Welcome email | `services/invites.js`, declared outbound path `tenant.welcome` |
| Trust: every onboarding logged with the time and the admin's id | `tenant.onboarded`, actor = the admin, `metadata.adminId` |

Measured before this story: onboarding was an API call with no screen and no email; the audit row named
`TenantManagementAgent`, not the admin; the author and the account were committed separately, so an
account that clashed left an author nobody could sign in to; and **the admin chose the author's
password**, so the admin knew it and had to pass it on somehow.

Now the admin gives a **name and an address**. One transaction creates the author, an account with **no
password**, and a one-time invitation (`038_tenant_invites.sql`); after the commit the tenant's private
schema is built and the welcome email is sent. The email carries a link to `/accept-invite` where the
author **chooses their own password** and is signed in. The token is 32 random bytes, stored only as its
SHA-256, **single use**, expires after `INVITE_TTL_HOURS` (72), and a resend retires the previous link.
Refused links — used, replaced, expired, made up — get one answer and a `tenant.invite_refused` audit
row naming which. A password sent to `POST /tenants` is **refused (400), not ignored**, so an old client
learns the API changed. The Tenants tab lists every tenant with whether they have signed in, their
schema, when and by whom they were onboarded, and resend / suspend / restore.

Email is still the STORY-002 mock and delivers nowhere, so outside production the API response and the
Tenants tab show the link, labelled *development only*. In production it exists only in the email.

### STORY-044 — who read whose data

| Story build step | Where it lives |
|---|---|
| 1. Logging middleware capturing all data access | `accessLog()` in `services/dataAccess.js`, mounted on `/api` |
| 2. A dedicated table with tenant and user identifiers | `039_data_access_log.sql` — `data_access_events`, append-only |
| 3. A React reporting tool for security audits | The **Security** tab; the author's **Trust** tab, "Who opened your data" |
| Trust: every data access event with user and tenant | Two CHECK constraints make an unattributed event impossible to store |

Measured before this story: the audit log recorded what *changed*. A read of a tenant's data was
recorded nowhere, and a request for another tenant's data was refused (403) and forgotten.

Now every request under `/api` except health, readiness and sign-in is written to `data_access_events`
as it finishes: the user, their role and their own tenant; **whose data** it was about (from the path,
the `authorId` query, or the row an id points at — or "all tenants" for a cross-tenant read); the
route, the status and the outcome (`allowed`, `denied`, `not_found`, `invalid`, `unauthenticated`,
`error`) with the refusal's reason; and the **database role** that served it (STORY-041's
`ale_tenant_<id>` for an author). The table refuses an event with no user — unless there was no session
to name — and a tenant event with no tenant. It is append-only by privilege and by trigger, and kept when
a tenant is deleted.

An account (or, with no session, an address) refused `ACCESS_ALERT_THRESHOLD` (5) times within
`ACCESS_ALERT_MINUTES` (10) is flagged as `access.suspicious` and every admin is emailed once per window.
An admin can **block** the account from the Security tab — with a reason, never their own — through the
owner function `ale_set_account_active`, which moves the access version so the block bites on the next
request, not at token expiry. Authors see the accesses to their own data on the Trust tab, read through
their own database view.

Limits, said out loud: a refusal counts whatever its cause, so an author poking at admin-only pages is
flagged like one probing another tenant — the security officer decides which it was. And the record is
written after the response, so a process killed mid-flight loses the records of its last requests;
failures to write are counted and shown on the Security tab rather than dropped.

### STORY-045 — per-tenant API keys

| Story build step | Where it lives |
|---|---|
| 1. API key generation | `createApiKey` in `services/apiKeys.js`; the **API keys** tab |
| 2. Stored securely | `040_tenant_api_keys.sql` — the SHA-256 of the key, never the key; **not** env vars (see below) |
| 3. Requests validated against the correct tenant's key | `sessionForKey`, called from `authenticate` on `X-API-Key` / `Authorization: ApiKey` |
| Trust: key generation and usage logged with tenant | `api_key.created` / `api_key.revoked` on the audit log; every use in `data_access_events.api_key_id` |

Measured before this story: no per-tenant keys existed. An integration could reach the API only by
signing in as a person — with their password and every permission they hold, approval included.

A key is `ale_<prefix>_<secret>`: 32 random bytes, shown once in the response that creates it and stored
only as its SHA-256 (a fast hash is enough for a random 256-bit secret; there is nothing to guess). It
belongs to one tenant and acts for the person who created it, **with no permissions of its own**: it reads
what an author reads, submits what an author submits if created `read_write`, and can never approve —
`content.approve` stays with people. It cannot create, list or revoke keys. Keys expire (1–365 days,
default 90), a tenant holds at most 10 live, and a key stops on its next request when revoked, expired,
when the person it acts for is blocked (STORY-044), or when the tenant is suspended. The caller is told
only "API key not accepted"; which of those it was goes to the access log for the security officer.

**Not done as written:** the build note's "environment variables or a secrets manager". Right for the
application's own secrets, which is where `ANTHROPIC_API_KEY` lives; impossible for keys tenants create
while the system runs. Storing only a hash leaves no secret to keep.

Found on the way: the Vite proxy forwarded every path *beginning* with `/api` to the API — including the
UI's own `/api-keys` page, which came back as `{"error":"Not found"}`. It now matches `^/api(/|$)`.

### STORY-046 — a model fitted to each book

| Story build step | Where it lives |
|---|---|
| 1. Ingest the book's text and supplementary materials | `book_passages` (STORY-006) and `book_materials` (`041_book_models.sql`); the Upload tab |
| 2. A fine-tuning pipeline | `fitParameters` / `fitBookModel` in `services/bookModel.js` — see below for what "fine-tuning" can honestly mean here |
| 3. Integrated into the backend | Fitted on upload, on new material, and before a draft whose book has changed; used by `draftWeeklyPosts` |
| 4. Parameters stored in PostgreSQL | `book_models.parameters`, versioned; a version is never rewritten (trigger) |
| Trust: the fitting on the audit log, parameters transparent | `book_model.fitted` / `book_model.applied`; the Upload tab's "What the AI learned from this book" |

Measured before this story: nothing ran when a book was uploaded; what generation learned about a book
was recomputed per batch and thrown away; there was nowhere to put supplementary material; and theme
retrieval matched the theme's own word, so a passage arguing "loss" through an empty chair and a coat on
a hook was invisible to it.

**Claude models cannot be fine-tuned through the public API**, and the offline provider is templates. So
what is fitted is a model *of the book*: for each theme, a lexicon — the words this book uses to argue it
— learned by contrasting the passages that name the theme with the rest of the book (a smoothed log ratio
of document frequencies over Postgres `english` lexemes, the stemming retrieval already uses). Material
sentences that name a theme join the examples; **only the book's own passages are ever evidence or quoted**.
Plus the book's style and the lines that carry each theme best. Every statistic is computed within the
book; other tenants' text is never read.

It is judged on held-out data: leave one passage that names a theme out, remove the theme's word from it,
and see whether the model still recognises it. Literal retrieval scores 0% on that by construction. On the
demo's sample manuscript (`db/sampleManuscript.js`, 18 passages): **33% from the book alone, 56% once the
author's synopsis and note are added**, and grounding evidence rises from 7 to 8 of 8 slots — the model
finds the empty-chair passage for "loss", which the book names only once. A theme named too rarely to learn
from says so ("too few examples") rather than guessing.

Generation uses it: passages the model found fill a theme's empty grounding slots, marked `via: 'book
model'` (literal evidence is never displaced), and the Anthropic prompt carries each theme's lexicon and
lines. **Limits:** small data makes weak lexicons (grief learns "change, shape, learn"); social drafts
only — outreach and press still ground by the literal search.

### STORY-047 — drafts reviewed against the book

| Story build step | Where it lives |
|---|---|
| 1. Extract key themes and stylistic elements from the book | Themes and their words: STORY-046's model; style: `bookStyle` in `services/contentReview.js` |
| 2. Compare generated content with them | `reviewDraft` — run on every draft as it is saved, kept in `content_reviews` (`042_content_review.sql`) |
| 3. A dashboard to approve or request modifications | The **Social · review** tab: the comparison beside each draft, and **Request changes** |
| Trust: an approval gate | Unchanged — a revision is a new draft waiting for a person with `content.approve` |

Measured before this story: drafts were scored against the book's themes and against the author's *social
posts* for voice — never against the book's own style — and a reviewer could only approve or reject.

Now each draft is compared with its book when it is saved: every theme it claims — argued or not, and in
the book's own words for it (STORY-046's lexicon; the title's words don't count) — and four style elements
measured by the same `measure()` that reads the author's posts: exclamation marks, marketing words, words
in capitals (each allowed 0.5 per 100 words over the book's own rate) and sentence length (at most 1.6× the
book's). The verdict — *matches the book*, *check*, *does not match* — and every note is shown beside the
approve button and on the audit log (`draft.compared_with_book`). It informs the human decision; it never
makes it.

**Request changes** sets a draft aside (`changes_requested`, with the note — the database refuses one without)
and asks for a revision, linked by `revision_of`, which is scored, compared with the book and waits for a
person like every other draft. The Anthropic provider is given the note and the draft the reviewer saw. The
offline provider cannot read the note; a revision keeps the reviewer's theme and quotes a different passage
from the book where there is one — the passage actually quoted is found in the draft's text, since
`draft_themes.passage_ids` lists every passage grounding the theme.

### STORY-048 — reviewers' feedback changes the next drafts

| Story build step | Where it lives |
|---|---|
| 1. Capture reviewer comments and ratings | `content_feedback` (`043_content_feedback.sql`); rating buttons on the **Social · review** tab |
| 2. Adjust model parameters from feedback | `learnPreferences` in `services/bookModel.js` — per-passage and per-theme weights |
| 3. Integrated with the fine-tuning process | Part of STORY-046's book model: new feedback → a new version (`trigger = 'feedback'`) |
| Trust: feedback and adjustments on the audit log | `feedback.recorded`; `book_model.fitted` with `preferencesMoved` (from → to, and why) |

Measured before this story: every approval, rejection and request for changes was recorded and nothing
learned from any of them — a passage turned down on Monday was quoted again on Tuesday.

Each judgment on a book's drafts counts: a reviewer's rating where there is one (4–5 good, 1–2 bad), otherwise
their decision (approved/scheduled good; rejected/changes requested bad). It is attributed to the passages the
draft quoted — found in its text — and the themes it claimed. A weight is `(good + 1) / (good + bad + 2) × 2`,
applied only after **two judgments**; passages range 0–2, themes are held to **0.5–1.5** (tilted, never
silenced). A passage below 0.6 — turned down twice and never liked scores 0.5 — is not quoted while its theme
has another; themes are chosen in proportion to their weight; and the Anthropic prompt carries the reviewers'
notes. Feedback is processed before the next drafts (the model's inputs changed) or at once with **Apply
feedback now**. On the demo's sample book: the funeral passage, turned down twice, was quoted by 2 drafts of a
week before and 0 when the same week (same seeds) was drafted again.

**Limits:** a judgment counts against both the passage and the theme — the system cannot tell which the
reviewer meant; their note can, and only the Anthropic provider reads it. And it learns preferences over the
book's passages and themes, not new wording.

### STORY-049 — the audit log, encrypted with AES-256

| Story build step | Where it lives |
|---|---|
| 1. An encryption/decryption module (AES-256) | `audit_seal` / `audit_open` in `044_audit_encryption.sql` — pgcrypto, `cipher-algo=aes256` |
| 2. Integrated with the logging mechanism | `audit_log` is now a view: it encrypts on insert and decrypts on read; `recordAction` is unchanged |
| 3. Every entry encrypted before it is stored | The storage, `audit_log_sealed`, holds only ciphertext; a connection without the key cannot write |
| Key management | `services/auditKey.js`: `AUDIT_KEY` or `AUDIT_KEY_FILE` (default `server/.keys/audit.key`, mode 600, git- and docker-ignored; a mounted secret in `docker-compose.yml`) |

STORY-019 declined this for three reasons, each true of encrypting in application code: the tamper seals
hash row contents, forty files read the log in SQL, and the key would sit beside `DATABASE_URL`. So the
encryption is in the storage and every reader keeps its view:

- **`audit_log_sealed`** keeps the routing columns in the clear — id, actor, action, entity, tenant, time —
  so the log can still be filtered and joined; the entry itself (before, after, metadata) is one AES-256
  ciphertext (OpenPGP symmetric, with an integrity check). The application login has no privilege on it
  at all.
- **`audit_log`** is a view with the same columns, in the same order: decrypted on read, encrypted on
  insert (a `SECURITY DEFINER` trigger — the only way in), append-only in the same words. Every reader,
  writer and test is unchanged, and the seals hash the rows they always did — so an edited ciphertext,
  which no longer opens, breaks them.
- **The key is not in the database.** Each connection the application opens is handed it at startup
  (`ale.audit_key`, a connection option — never in query text or `pg_stat_activity`). A dump, a backup, a
  replica or any login the application did not open sees ciphertext, and cannot write an entry at all.
  Existing entries were encrypted in place by the migration, the one time the append-only trigger was
  lifted.
- **Checked from outside:** the invariant `audit.encrypted` — every entry under the current key, and
  opens — counted by `audit_encryption_status()`, and shown on the Audit tab's Integrity card.

**Limits:** the running application holds the key, so whoever controls it reads the log; rotation is not
built (each row records its key id). The redaction STORY-019 built stays — a secret written to an
append-only log can never be removed, encrypted or not.

### STORY-050 — who may read and manage the audit logs

| Story build step | Where it lives |
|---|---|
| 1. Roles and permissions for audit logs | `AUDIT_ROUTES` in `services/auditAccess.js` — each audit route, its permission, and why |
| 2. RBAC in Express middleware | `requirePermission` (now readable off the router) and `requireAuditReviewer` in `middleware/auth.js` |
| 3. The front end checks before showing audit logs | The Audit log tab only for `audit.read`; the Access tab's **Who can read the audit logs** table |

Measured before this story: the permissions existed (STORY-019), but nothing tied *which routes serve audit
data* to *which permission guards them*. Walking every route whose handler reads audit data found three —
a tenant's access log, trust history and trust dashboard — guarded only by the tenant rule, so an **API key,
which holds no permissions (STORY-045), read all three**. Two more carried private copies of the reviewer
check.

Now the three require `audit.read` (authors hold it for their own trail, so nothing changes for them), the
reviewer check is one middleware, and every audit route is declared. `auditAccess.test.js` holds the live
router to the declaration both ways — a route whose handler reads audit data and is not declared, or is
guarded by anything other than its declared permission, fails the build — and walks every declared route as
no session, an author, another tenant's author, compliance, admin and an API key, against the statuses the
policy predicts. The policy table on the Access tab is computed from the live grants, so it changes when a
grant does. Refusals land on the access log (STORY-044) with the permission that was missing.

### STORY-051 — who tried to read the audit logs

| Story build step | Where it lives |
|---|---|
| 1. A security log of access attempts | `045_security_log.sql` — `security_log_sealed` behind the `security_log` view |
| 2. Integrated with RBAC | Every attempt on a route in STORY-050's `AUDIT_ROUTES`, recognised even when refused before routing |
| 3. Encrypted and access-controlled | Same AES-256 key as the audit log; the app writes through the view only; `ale_readonly` has nothing; `/security/audit-access` for reviewers |

Measured before this story: attempts on the audit logs went only into the data access log (STORY-044) — in the
clear, among every other request. Now each one, allowed or refused, is also written to a separate security log
— who (user, name, role, API key), from where (address, browser), what (route, path), and how it ended (outcome,
reason) — in the **same transaction** as its access record, sharing a request id. The entry is AES-256 ciphertext
under the audit log's key; it is append-only; and reading it (the Security tab's **Who tried to read the audit
logs**) is itself an attempt on an audit log, and is recorded there. The invariant `security_log.complete` counts
any access record on an audit route with no security entry.

### STORY-052 — the security officer is told

| Story build step | Where it lives |
|---|---|
| 1. Alerts for unauthorized attempts | `notifyAuditAttempt` in `services/securityNotifications.js`, on every refused security-log entry |
| 2. A third-party sending service | The email adapter (STORY-002), shaped like SendGrid's send call, through the integration gateway (STORY-038) — **still the mock**; swapping in SendGrid is a change to `emailApi.js` |
| 3. Detailed notifications | Who, role, what route and path, when, address and browser, outcome and reason, and a link to act |

Measured before this story: refused attempts were recorded and nobody was told — STORY-044's alert waited for five
refusals of any kind. Now the **first** refused attempt on an audit log from a person (or, with no session, an
address) emails every security officer — whoever holds `audit.verify` — at once, as the declared outbound path
`security.alert_audit_access`. Attempts in the next 10 minutes join that alert (`attempts`, `routes_tried`) rather
than sending another. Who it was meant for, who received it and who it failed for are kept separately
(`security_notifications`), and on the audit log. On the Security tab an officer **acknowledges** an alert with a
note, and an admin can **block** the account behind it (STORY-044).

### STORY-053 — the pipeline, and the run nobody saw

| Story build step | Where it lives |
|---|---|
| 1. GitHub Actions on every commit | `.github/workflows/ci.yml` — `unit` → `test` → `e2e`, `security`, `images` |
| 2. Unit, integration and end-to-end tests | `npm run test:unit` (no database, <1 s), `npm test` (the API on real Postgres), `npm run test:e2e` (a person's journey in Chrome) — **node:test and Puppeteer, not Jest/Mocha/Cypress; see below** |
| 3. Security checks | `npm audit` (dependencies, STORY-034), Clair (images, STORY-034), and now an **OWASP ZAP baseline** of the running build, rule levels in `.zap/rules.tsv` |
| 4. On each commit, automatically | `on: push` and `pull_request`, every branch |

**Measured before this story:** the README said the workflow had never run. It had — once, on GitHub, on
2026-09-26, commit `b24202f` — and **failed at `npm test`**, and nobody knew. The job log needs a signed-in
account, so the cause was found by reproducing CI's conditions here (UTC, the restricted login with a password,
an owner role called `postgres`): `databaseRoles.test.js` checked the app could not `GRANT anvi` — the
developer's own Postgres login, which does not exist on a runner, where Postgres answers "role does not exist"
instead of refusing. It now asks Postgres who owns the database. Two cross-suite races found on the way were
fixed the same day.

**Now:**
- **Unit tier** (`tests/unit/`): the product's pure decisions — style and voice measures, the book model's
  learning and bounds, escalation floors, the access log's classification of requests — with **no database
  reachable at all** (checked by pointing it at a closed port). Runs first; everything else waits on it.
- **Integration tier**: the existing suite, three times, as before.
- **End-to-end tier** (`client/scripts/e2e.mjs`): sign in, upload a book, see its model, generate drafts compared
  with the book, request changes, approve the revision, create an API key shown once, compliance refused — and no
  uncaught error, console error or 5xx on the way. Proved able to fail by renaming one button.
- **ZAP baseline** against the production build with the API behind it; `FAIL`-level rules fail the build.
- **`npm run ci:local`** runs the same steps in the same order under CI's conditions, and says what it cannot run
  here (RabbitMQ, ZAP, image builds) instead of passing them; for ZAP it runs a labelled stand-in that checks the
  headers the `FAIL` rules check.
- Actions bumped to `checkout@v5`/`setup-node@v5` (GitHub was forcing the v4s off Node 20).

**Not done as written:** Jest, Mocha and Cypress. The suite is `node:test` and the browser tier Puppeteer, both
already here; three new frameworks would re-express the same tests, not add any. And there is still **no deploy
step** — nothing to deploy to (STORY-030).

### STORY-028 — audit log reports (built after STORY-053)

Skipped when the backlog was worked through in order, and ticked complete on Basecamp with nothing built; caught
by review and built after STORY-053.

| Story build step | Where it lives |
|---|---|
| 1. A report generation module | `services/auditReports.js` — `generateAuditReport`, `reportAsCsv` |
| 2. PostgreSQL queries extracting detailed records | One query over the `audit_log` view (decrypted, STORY-049), joined to accounts and tenants |
| 3. RBAC on report access, integrated with the front end | `GET /audit-reports` requires `audit.read` (declared in STORY-050's `AUDIT_ROUTES`); the Audit tab's **Audit log report** |

Measured before: the Audit tab listed the last 200 entries by tenant and type — no period, no filter by person or
action, no summary, no export, nothing proving a copy was not edited, and "who" was a name string.

A report covers a period (default the last 30 days) filtered by tenant, actor and action prefix (escaped — action
names contain `_`, which `LIKE` reads as a wildcard). Each record has its time, action, entity and tenant, and
**who**: a *person* (their account's email and role), an *agent*, or a *name no account has* — resolved, never
guessed. The report carries a summary (by action, actor, day), the seal status when it was made, and a **SHA-256
of its records**; `format=csv` downloads it with the digest in the header. Generating one is itself on the audit
log. An author's report is their own tenant's — confined by the tenant rule and by reading through their own
database role; the seal check and the log entry run outside that scope, as system acts.

### STORY-030 — a public demo URL (ready; not deployed)

Skipped when the backlog was worked through in order; caught by review. **Not deployed:** a public URL needs a
server, a domain and DNS in the project owner's name, and publishing the product is theirs to decide. Everything
up to that point is built and rehearsed.

| Story build step | Where it lives |
|---|---|
| 1. Docker | The images from STORY-015/034; `docker-compose.prod.yml` overlays the stack for a public host |
| 2. A cloud platform | Any VM with Docker — the overlay is platform-neutral; steps below |
| 3. A custom domain | `DOMAIN`, served by Caddy (`deploy/Caddyfile`) |
| 4. HTTPS | Caddy obtains and renews Let's Encrypt certificates; http only redirects; the API refuses plain http (`ENFORCE_HTTPS`) |
| Trust: protected against unauthorized access | Only Caddy is public; the seed's published passwords are replaced by random ones in production; the login page hides them; `npm run smoke:deployed` checks all of it |

**Found on the way — a hole a public deploy would have opened:** the seed gives the demo accounts fixed passwords
(`ops-password` for an admin), printed in this README and on the login page. Deployed as it was, anyone could sign
in as an admin. Now, with `NODE_ENV=production`, every seeded account gets a random password printed once in the
seed's log, and the production image is built with `VITE_SHOW_DEMO_LOGINS=false`, which leaves the passwords out
of the bundle entirely.

**To deploy** (the project owner):

```bash
# on a VM with Docker, with DNS for demo.example.com pointing at it
git clone … && cd Author-Launch-Engine
mkdir -p server/.keys && openssl rand -base64 32 > server/.keys/audit.key && chmod 600 server/.keys/audit.key
export DOMAIN=demo.example.com APP_DB_PASSWORD=$(openssl rand -base64 24) JWT_SECRET=$(openssl rand -base64 48)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile seed run --rm seed   # prints the logins once
npm run smoke:deployed -- https://demo.example.com
```

**`npm run smoke:deployed`** checks the two acceptance clauses against the live URL: valid HTTPS, http→https,
the app and API up; no data without a session, the published passwords refused, none in the served JavaScript,
the security headers and HSTS, no other origin let in. Rehearsed here: against the development stack it **fails**
(the published passwords sign in; the bundle contains them); against a production seed and build it **passes**
every check that does not need a real certificate, and says the other three were skipped.

**Unverified until it runs:** the overlay and Caddyfile have never been executed (no Docker here), and the Caddy
image is pinned by tag only — its digest must come from the registry on the first pull.

### STORY-054 — Kubernetes, with access by role (run on a local cluster)

| Story build step | Where it lives |
|---|---|
| 1. Kubernetes manifests: deployments, services, ingress | `deploy/helm/author-launch-engine/templates/` — API, worker, client, Postgres, migrate and seed jobs, an optional Ingress |
| 2. RBAC roles and bindings | `templates/rbac.yaml`: *viewer* (read pods, logs, deployments), *operator* (plus restart, scale, roll out), *secrets-admin* (the one app secret, nothing else), bound to groups from `values.yaml` |
| 3. Helm | The chart itself; `helm lint` clean; the chart's rendered output is tested in `server/tests/unit/helmChart.test.js` |
| 4. Auto-scaling and self-healing | An HPA (2–5 API pods at 70 % CPU), a PodDisruptionBudget, `maxUnavailable: 0`, liveness on `/api/health` and readiness on `/api/ready` |
| Trust: secure access management | Service accounts get no API token; every pod runs as a numeric non-root user; NetworkPolicy lets only the app reach Postgres |

**Run on a real cluster** — k3s under Colima, single node, with the images built for the first time since STORY-015.
What it showed (`kubectl` output in the STORY-054 update):

- **Load balancing:** twelve requests to the `api` Service answered by two pods, 7 and 5. `/api/ready` now names
  the pod that answered (`instance`), so this is visible from outside.
- **Scaling:** under load the HPA took the API from 2 to 3 pods ("cpu resource utilization above target").
- **Self-healing:** a deleted API pod was replaced and the Deployment ready again in 2 seconds.
- **RBAC:** `kubectl auth can-i` per group — viewers read but cannot delete or read secrets; operators restart
  and scale but cannot read secrets; secret admins can read and update `ale-secrets` and no other secret.
- **Network:** the client pod cannot reach Postgres; the API pod can.

**What the first real run found, that review had not** — each now pinned by a chart test:

1. The API image's build failed: npm workspaces leave no `server/node_modules` to copy.
2. `runAsNonRoot` refused the pods: Kubernetes cannot verify a user *name* is not root. The images now run as uid 10001.
3. The audit key (STORY-049) was mounted readable only by root; the app could not start. `fsGroup` and mode 0440 fix it.
4. After the autoscaler scaled up, the next `helm upgrade` failed: the chart and the HPA both set `replicas`.

**Not done:** a cloud cluster, a real load balancer or TLS at the Ingress, and pulling images from a registry
(the local run used `pullPolicy: Never`). The Dockerfiles now say they were built and run, and where.

```bash
kubectl create namespace ale
helm install ale deploy/helm/author-launch-engine -n ale \
  --set secrets.appDbPassword=… --set secrets.ownerDbPassword=… --set secrets.jwtSecret=… --set secrets.auditKey=… \
  --set 'rbac.operators={your-ops-group}' --set seed.enabled=true
```

### STORY-055 — logs and metrics in a search index

| Story build step | Where it lives |
|---|---|
| 1. An Elasticsearch cluster | `templates/search.yaml` (one node, behind its own NetworkPolicy); a service container in CI's `search` job |
| 2. An index schema for audit logs and system metrics | `services/searchIndex.js` — `SOURCES` (audit, data access, security logs) and `METRICS`; strict mappings |
| 3. Ingestion pipelines from PostgreSQL | The worker's `search.aggregate` sweep and `npm run search:aggregate` — **not Logstash or Beats; below** |
| 4. Efficient, fast queries | `GET /authors/:id/search` (tenant-filtered in code), the Trust tab's **Search the logs**; sub-second checked at 20,000 rows in CI |
| Trust: every action indexed and searchable | `search_sync` records how far each source has got and what the last reconciliation found |

**What the index may hold.** STORY-049 encrypted each audit entry's before, after and metadata. The index gets
only the columns that were always stored in the clear — who, what, which record, which tenant, when — read by
migration 047's functions *without* decrypting. The encrypted part never leaves Postgres; a hit links back by id.
No email or IP address from the security or data access logs is copied either.

**Not Logstash.** Logstash would need the audit key to read the log, and a second holder of the key is what
STORY-049 exists to prevent; and a JVM beside every deployment is a gigabyte to do what the worker already can.

**No data lost or corrupted — checked, not assumed:**

- a batch moves the mark only after every document has been read back and its SHA-256 digest matched;
- each run re-reads a window behind the mark, so a row that commits after a higher id was indexed is not skipped;
- reconciliation compares counts and, on a gap, walks the ids to fill it; it re-reads a sample and rewrites any
  document changed in the index;
- an index that disappears is rebuilt from the start, and the rebuild is on the record;
- an index that is down leaves the mark where it was and records why.

**Verified here:** unit tests (documents, digests, read-back) and, against an in-memory stand-in, the live suite's
plumbing — which found two bugs before CI could. **Not yet verified:** the live suite against a real Elasticsearch
(`server/tests/searchLive.test.js`), including the one-second limit. It runs in CI's `search` job on the next push.
With `ELASTICSEARCH_URL` empty, nothing is copied and the Trust tab says search is not set up.

### STORY-056 — the trust dashboard in Grafana

| Story build step | Where it lives |
|---|---|
| 1. Grafana | `templates/dashboards.yaml`; `docker run` in CI's `search` job |
| 2. Connected to Elasticsearch | `files/grafana/datasources/elasticsearch.yaml` — one data source per index |
| 3. Panels: approval rates, audit entries, governance scores | `files/grafana/dashboards/trust.json` — eight panels, a tenant filter, a time range |
| 4. Interactive, customisable, saved and shared | Editable and provisioned with `allowUiUpdates`; saved to a volume; viewers cannot save over it |

The same files serve the chart and CI. A unit test checks every field a panel queries exists in the index it
reads — a misnamed field in Grafana draws an empty chart and no error.

**Not yet verified:** Grafana has not run on this machine. `server/tests/grafanaLive.test.js`, in CI's `search`
job, checks the data sources answer, runs every panel's query over a chosen range (and a range with no data),
saves an editor's change and reads it back as a viewer, refuses a viewer's save, then restarts Grafana and checks
the change was kept. The job uploads screenshots of Grafana and the Trust tab's search as an artifact.

### STORY-057 — what is waiting, and for whom

| Story build step | Where it lives |
|---|---|
| Pending approvals and recent actions, with timestamps and priority | `agents/approvalNotificationAgent.js` (`PRIORITY_RULES`), `services/attention.js`; the Trust tab |
| A prominent notice for users with pending approvals | `AttentionNotice` under the header on every tab, for whoever holds `content.approve` |

Measured before: pending approvals were counts per kind; recent actions a time of day; no priority; nothing told the
person who decides. Now each waiting item has its time, age and priority with the reason (*escalated*, *older than
two days* → high; *older than a day* → medium), most urgent first; recent actions carry their full timestamp and a
priority by what happened. Both refresh every 15 seconds. The compliance auditor, who cannot approve, is not told to.

### STORY-058 — a governance score from what the system did

| Story build step | Where it lives |
|---|---|
| A score with a breakdown of contributing factors | `services/governanceScore.js`; the Trust tab's **Governance score** |
| Reflects the most recent data | Computed on each request; the card refreshes every 15 seconds |

Measured before: the "score" was governance checks passing (22 of 24) — whether the rules held, not what the system
did. Now: checks passing (25 %), approvals honoured before anything went out (25 %), decisions on the audit log
(15 %), sends and jobs that did not fail (15 %), waiting items younger than two days (10 %), audit log sealed and
encrypted (10 %). A factor with nothing to measure is left out and its weight shared, and shown. **A broken
invariant caps the score at 50.**

**Found by the score:** the demo's first figure was 50, capped from 72, because `gate.posts` was failing — and had
been at the end of every demo since STORY-029. That story's engagement fixtures published 24 posts marked
"approved" with no approval behind them. The gate check was right; the fixture was wrong. It now records the
approval (an hour before the post, by Mira's account) and its audit entry with the states. The demo now scores
**92**: the integrity factor loses half its points to the STORY-013 stage that tampers with the log on purpose,
and three quality checks fail for reasons earlier stages show.

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

Then open <http://localhost:5173> and sign in — `npm run db:reset` prints the seeded logins, and
`mira@example.test` / `quiet-craft` is the one with all the demo data. Walk the tabs left to right:
Upload, Social review, Social schedule, Opportunities, Outreach, Press, Worker, Audit log.

### Background worker

```bash
npm run worker
```

Its own process on purpose. Polls Postgres for due work, runs each recurring sweep once per window,
retries with backoff and hands what it cannot finish to a person. Safe to run more than one. The API
works without it — the buttons still do everything by hand — but nothing happens on a timer until it
is running.

## Demo in one command

```bash
npm run db:reset && npm run demo
```

Prints 269 stages with evidence at each one.

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
- **Stages 26–31, STORY-005:** an award whose ceremony has passed and whose result nobody recorded,
  recording the win as the trigger that drafts, the release stating a win rather than a shortlisting,
  the gate refusing the win kit, the withdrawn shortlist kit refused even after the fact, and the
  award audit trail.

- **Stages 32–35, STORY-006:** what retrieval hands the drafter for each theme, every theme judged
  twice on every material (named / argued, with the words it carried through), the same name-checking
  copy scored 1.000 by the old measure and 0.475 by the new one, and the grounding audit trail.

- **Stages 36–41, STORY-007:** what is sitting on a human right now, the "work waiting and nobody to
  tell" state recorded rather than passed over, naming the stakeholders, the notification that
  actually goes out, pressing it again sending nothing, every material status unmoved by the
  notifier, and the notification audit trail.

- **Stages 42–46, STORY-064:** every protected endpoint answering 401 with no session, signing in and
  what the token actually claims, the same 401 answer for a wrong password and an unknown email, one
  tenant refused three different ways, an approval recording the session's owner rather than the name
  in the request body, and the identity trail showing attributable and unattributable decisions
  together.

- **Stages 47–52, STORY-065:** a human approves and queues a post and walks away, the worker
  publishing it unattended, a second cycle doing nothing twice, a failure retried with backoff and
  then handed to a person, a human putting it back, a worker dying mid-job without losing the work,
  and run health with the job trail.

- **Stages 53–57, STORY-008:** the drafts a producer judged for itself, the confidence floor raised
  so yesterday's work is re-judged against today's policy, the floor dropped again with not one
  concern withdrawn, the escalation queue with who caught what and why, and the monitoring trail.

- **Stages 58–62, STORY-009:** what retrieval and voice derivation hand the social drafter, a week
  of posts written from that evidence with per-theme verdicts, the hype draft scored under both the
  STORY-001 measure and this one, the name-checking and false-claim cases, and the drafting trail.

- **Stages 63–68, STORY-010:** a search narrowed to speaking engagements, what the agent knows about
  the author as opposed to the book, the lead the book's themes scored at exactly zero, every listing
  scored on both dimensions with exactly one recovered, the rejections the filter used to discard,
  and the scouting trail.

- **Stages 69–74, STORY-011:** one sweep window in arrival order with the approved email last, what
  the coordinator decides and why, the two-worker ordering bug before and after, per-tenant rather
  than per-queue serialisation, eight workers racing one queue with no errors, and the distribution
  log.

- **Stages 75–80, STORY-066:** a meme landing in the same table and the same gate as a text post,
  the caption and the rendered image with its licence, the two templates withheld before generation,
  the five safety and rights outcomes side by side, an approved meme refused at publication because
  its rights are unresolved, and the meme trail with provenance.

- **Stages 81–85, STORY-067:** the library with every template's slots and licence, the two refusals
  written to the log rather than swallowed by a filter, an unlicensed template refused at the door,
  a template retired without stranding the drafts that used it, and the library trail.

- **Stages 86–90, STORY-068:** all eight licensed templates scored against the guide with three
  fitting, selection preferring an on-identity template, the author revising the accent and the same
  seed choosing differently, older memes still pointing at the version they were judged under, and
  the identity trail.

- **Stages 91–95, STORY-069:** the honest answer on real data (nothing measurable yet), a constructed
  history in a simulated world where memes lead so the verdict path has something to act on, a
  recommendation that changes nothing, a rejection that changes nothing and an approval that moves
  the next batch, and the measurement trail with the simulation flag on it.

- **Stages 96–101, STORY-012:** everything held for a human in one queue, the constraint that made
  notifying about most of it impossible, work waiting with nobody to tell, one digest per reviewer
  covering many items, a second sweep announcing nothing and moving no status, and the approval
  trail.

- **Stages 102–106, STORY-013:** every agent's rows and the three mutations the table refuses, the
  triggers switched off and history rewritten while the log still refuses ordinary writes, the seal
  catching the edit, the same catch for removed rows, and what the checkpoints still cannot do.

- **Stages 107–111, STORY-014:** the dashboard opening on a breach caused by the previous story's
  tampering, every check with its severity and why it matters, the four gates checked from outside
  the code that enforces them, the anomaly detectors declining to guess, and health and queue drawn
  from the modules that own them.

- **Stages 112–116, STORY-015:** what this story could not do and why, liveness against readiness,
  an instance running ahead of its migrations being refused traffic, the release record that makes a
  rollback possible, and the difference between stopping and crashing.

- **Stages 117–121, STORY-016:** every integration's call volume and latency where nothing was
  recorded before, a 429 and a 400 classified as opposite instructions, a rate limit ridden out
  across three attempts, a provider that never answers being abandoned, and giving up recorded as an
  event rather than a silence.

- **Stages 122–126, STORY-017:** the 23 tables isolation actually rests on, the cross-tenant leak
  found in this project's own trust dashboard, onboarding as one transaction, suspension that keeps
  the audit trail, and an isolation check that names what it excludes and why.

- **Stages 127–132, STORY-018:** a press kit generated with no milestone and none invented, the
  retrieved claims a release with no news hook has to lean on, the author's voice derived from five
  real posts and cross-checked against their hand-written profile, the same release scored 0.74 with
  its format furniture and 0.87 without, copy that argues every theme escalating on voice alone, and
  both press invariants checked from outside the code that enforces them.

- **Stages 171–175, STORY-026:** the independent monitor covering one content type of three, what that
  costs when a reviewer tightens a floor, three anomaly detectors that all watched reviewers and none
  watched content, the stub generator caught repeating itself across weeks and platforms, and the
  40 false positives a tokenizer that dropped digits produced on the first run.

- **Stages 176–180, STORY-027:** a release record that calls a SIGKILLed worker "running" forever, a
  check that probes the API over HTTP and reads the worker's heartbeat with a row per verdict, an
  outage opened on the transition and paged to `ops@example.test` once, recovery as a check finding
  it up rather than time passing, and the three things this monitoring cannot see, said out loud.

- **Stages 266–269, STORY-054, STORY-055, STORY-056:** the instance a request reached; an audit row as indexed,
  without its encrypted fields, and its digest; the aggregation (or, with no index configured, why not); the
  Grafana panels as provisioned. The cluster and the live index and Grafana checks are not part of the demo.

- **Stages 263–265, STORY-058:** the old score and what it could not say; the new one factor by factor (92 on the
  demo data); when it was computed.

- **Stages 260–262, STORY-057:** what the dashboard showed before; everything waiting for Mira, most urgent first,
  with times and reasons; the notice Mira sees and the compliance auditor does not.

- **Stages 258–259, STORY-028** (built after STORY-053): a report of Mira's draft actions with its
  attribution, seal status and digest, and who may and may not generate one.

- **Stages 254–257, STORY-052:** nobody told before; alerts already raised by earlier refusals; three more
  attempts folded into one alert; the email an officer receives; and acknowledging it.

- **Stages 250–253, STORY-051:** four attempts on the audit logs in the security log with who and how they
  ended, stored encrypted and closed to the app's own login, and the completeness invariant.

- **Stages 246–249, STORY-050:** three audit routes an API key could read, the declared policy by role
  derived from the live grants, and the same key and author granted or refused route by route.

- **Stages 242–245, STORY-049:** why STORY-019 said no, an entry stored as AES-256 ciphertext and read back
  unchanged, a connection without the key reading nothing and refused a write, and each old objection
  answered.

- **Stages 238–241, STORY-048:** what reviewers' decisions changed before (nothing), a rejection and
  ratings with reasons, the model refitted from them with each weight that moved, and the same week drafted
  again — the passage turned down twice no longer quoted.

- **Stages 234–237, STORY-047:** what a reviewer had (approve or reject), the book's style measured, drafts
  compared with it as they are made, an off-register draft marked with every reason, and changes requested
  — the revision quoting the passage the reviewer asked for.

- **Stages 230–233, STORY-046:** what generation kept about a book (nothing), a model fitted on upload,
  the author's notes teaching it a theme the book barely names, and the next drafts written with it.

- **Stages 226–229, STORY-045:** how an integration got in before (as a person), a key created and
  shown once, the same key refused another tenant, writing, approving and minting keys, and refused
  on the request after it is revoked — with the reason kept for the security officer.

- **Stages 222–225, STORY-044:** what reading left behind (nothing), four requests for the same books
  traced to four different people and outcomes, an account trying doors flagged and the admins told,
  and a block that stops the account on its next request.

- **Stages 218–221, STORY-043:** what onboarding was, measured; an admin onboarding with a name and an
  address (and refused a password); the author choosing their own from a one-time link that then stops
  working; and a clash that leaves nothing half-made behind.

- **Stages 214–217, STORY-042:** one admin no longer mints another, a requester refused their own
  approval by the service and by the database, a revocation that bites on the next request, and the
  invariant that checks every privileged account was reviewed.

- **Stages 210–213, STORY-041:** what the database enforced between tenants (nothing), a schema created
  at onboarding, a query with no WHERE clause returning only the caller's rows, and what switching
  isolation on broke — plus the limit, stated.

- **Stages 206–209, STORY-040:** the coordinator measured against the story, a task held without cost
  while email is down, every dispatch naming what it went ahead of and why, and notices that were not
  sent no longer counted as sent.

- **Stages 202–205, STORY-039:** agents that had never messaged each other, an escalation handed to
  the notifier in its own transaction and delivered within one poll, what the bus refuses and what it
  never drops, and RabbitMQ — written, and run only in CI.

- **Stages 198–201, STORY-038:** the gateway that said the directory search went through it, every
  integration and its policy, a directory going down — circuit opened, operators alerted once, calls
  stopped, the scout carrying on — and recovery on a trial call.

- **Stages 195–197, STORY-034:** the Compose file that defined one service, the two configs that
  would have refused the UI together, and the dependency scan that runs here against the image scan
  that cannot.

- **Stages 192–194, STORY-033:** the superuser the API used to be, the application login asked to
  do what an attacker would (every attempt refused), the trigger still standing behind the privilege,
  and the check that reports it.

- **Stages 189–191, STORY-032:** every route sent garbage (28 crashed, one stored it; now none),
  stripping proven safe by a source scan, and authorisation checked before validation.

- **Stages 186–188, STORY-031:** what the clause asks against what existed, the policy on a real
  response and the one directive it had to widen, and HTTPS enforced — redirect, refuse, probe,
  and HSTS only where the connection is real.

- **Stages 181–185, STORY-029:** engagement collected by a button and kept as one overwritten reading,
  a series per post filled by a sweep, four questions asked of it instead of one, the two
  "relationships" the first version found that were both the platform, and a page that says every
  number is mocked beside the chart.

- **Stages 166–170, STORY-025:** a publish failure the system recorded and nobody was told about, the
  notice that names the platform and the provider's own message, announced once however often the
  sweep runs, the three states a bare count would collapse, and the check that counts only failures
  somebody could have been told about.

- **Stages 161–165, STORY-024:** the isolation walk that covered 10 of 35 routes, the list derived
  from `router.stack` instead of typed out, every walked route actually answering rather than passing
  vacuously, a wider walk that found nothing and says so, and the invariant that names a route it
  cannot drive.

- **Stages 156–160, STORY-023:** three content types with only two of them measured, a theme
  satisfied by the word "work", the hype pitch that scored 0.79 and queued for ordinary approval now
  escalating on all three floors, the real pitches going from 0.10–0.25 alignment to 0.82–1.00
  without a threshold moving, and per-theme evidence as the third mirror of `draft_themes`.

- **Stages 151–155, STORY-022:** eight approve routes with no permission among them, the read-only
  compliance role approving a press release in another tenant, the split of reading-across-tenants
  from acting-across-tenants, the same requests refused afterwards, and a scan so a ninth approve
  route cannot ship unguarded.

- **Stages 145–150, STORY-021:** a dashboard that existed only while somebody was looking at it, the
  score becoming a series, a real invariant broken and the transition detected with a time on it, the
  alert going once to two reviewers by a declared path and not again on the next sweep, the episode
  closing without forgetting it happened, and `trust.assess` joining the six sweeps that already ran
  on a timer.

- **Stages 139–144, STORY-020:** the blind spot the three gate invariants share, the six ways out of
  this system with three gated and three exempt-with-reasons, an undeclared path refused at the
  adapter, the send point this story's own author forgot to declare and the suite catching it, a
  planted probe caught by the source scan, and the new invariant checked from outside.

- **Stages 133–138, STORY-019:** the audit log any signed-in author could read, the grant table that
  replaced seven `requireRole('admin')` checks, a compliance officer reading every tenant and
  refused every write, a password hash redacted on its way into a table that cannot be edited, the
  two status changes that recorded neither state, and the check whose first version demanded a
  "before" from 67 gate refusals.

Stage 16 deliberately leaves the anniversary alone so stage 22 has something to find: STORY-003
drafts when a person asks, STORY-004 drafts when the date approaches. Stage 16 *does* draft the
award as a shortlisting, so stage 27 can withdraw it when the win is recorded.

## Tests

```bash
npm run db:reset && npm test
npm run check:browser        # STORY-031: every tab, in Chrome, at 390px and 1280px, under the enforced CSP
npm run scan:deps            # STORY-034: production dependencies against the advisory database
```

`check:browser` builds the client, serves it with `vite preview` under the production policy, signs
in and loads every tab at a phone and a desktop width, and fails on any CSP violation, any page that
scrolls sideways, any table crushed until its words break, any broken image or any console error. It then re-runs two tabs under the
acceptance clause's literal `default-src 'self'` as a control, to show it can see a violation at
all. Needs Chrome (`CHROME_PATH` to override); it exits 2 — skipped, not passed — without it.

488 tests across 114 suites. For each story the leading suites map one-to-one onto its Gherkin
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
| `MIN_THEME_ALIGNMENT` | `0.5` | Below this alignment score, a press material escalates |
| `THEME_MESSAGE_TERM_TARGET` | `8` | How many of the book's own words about a theme a draft must carry to count as arguing it |
| `SOCIAL_MESSAGE_TERM_TARGET` | `3` | The same target's floor for a social post; the bar scales with the post's own length |
| `MIN_VOICE_MATCH` | `0.5` | Below this match against the author's previous posts, a social draft escalates |
| `MIN_MEMES_PER_BATCH` | `1` | Meme candidates every batch of social content must include |
| `MIN_IDENTITY_MATCH` | `0.75` | Below this fit against the book's visual identity, a meme escalates |
| `MIN_SAMPLE_PER_CELL` | `8` | Posts of each format, per platform, before the comparison says anything |
| `API_TIMEOUT_MS` | `10000` | How long an outbound call may take before it is abandoned |
| `API_MAX_ATTEMPTS` | `3` | Attempts in total, not retries after the first |
| `API_BACKOFF_MS` | `500` | First retry wait, doubling — overridden by a `Retry-After` header |
| `MAX_UNSEALED_AUDIT_ROWS` | `50` | Unsealed audit rows tolerated before the governance check complains |
| `FAST_APPROVAL_SECONDS` | `5` | A decision quicker than this looks like a rubber stamp |
| `MIN_DECISIONS_FOR_PATTERN` | `10` | Decisions a reviewer needs before their pattern means anything |
| `ENGAGEMENT_MATURITY_HOURS` | `48` | How long a post must be live before its metrics count |
| `EXPERTISE_THRESHOLD` | `0.5` | Below this fit against the *author*, a listing does not qualify on expertise |
| `MILESTONE_LEAD_TIME_DAYS` | `30` | How far ahead a milestone counts as approaching, and drafting begins |
| `DATABASE_URL` → app | `postgres://ale_app_login@localhost:5432/author_launch_engine` | What the API, worker, seed and tests connect as (STORY-033): rows only, no schema, audit log insert-only |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL`, else `postgres://localhost:5432/author_launch_engine` | The schema owner. Used by `db:migrate` / `db:reset` only |
| `APP_DB_PASSWORD` | — | Applied to `ale_app_login` by `migrate.js` where the server requires passwords. Never in a migration |
| `MESSAGE_TRANSPORT` | `postgres` | How agent messages travel (STORY-039): `postgres`, or `amqp` for RabbitMQ at `AMQP_URL` |
| `APP_URL` | `http://localhost:5173` | Where the welcome email's link points (STORY-043) |
| `INVITE_TTL_HOURS` | `72` | How long an onboarding invitation works (STORY-043) |
| `ACCESS_ALERT_THRESHOLD` | `5` | Refused requests from one account that flag it (STORY-044) |
| `ACCESS_ALERT_MINUTES` | `10` | The window those refusals are counted in (STORY-044) |
| `AUDIT_KEY` | — | The audit log's AES-256 key, base64 (STORY-049). Prefer `AUDIT_KEY_FILE` |
| `AUDIT_KEY_FILE` | `server/.keys/audit.key` | Where the key is read from; created in development, required in production (STORY-049) |
| `AMQP_URL` | — | RabbitMQ, when `MESSAGE_TRANSPORT=amqp`. CI sets it; the broker test skips without it |
| `ENFORCE_HTTPS` | `true` in production | Redirect plain-http GETs to https, refuse other methods; `/api/health` and `/api/ready` exempt (STORY-031) |
| `CORS_ORIGINS` | `http://localhost:5173` in dev, none in production | Comma-separated browser origins allowed cross-origin. Was `*` before STORY-031 |
| `ELASTICSEARCH_URL` | — | The search index (STORY-055). Empty: nothing is copied and search says it is not set up |
| `SEARCH_BATCH_SIZE` | `500` | Rows per indexing batch; each batch is read back before the mark moves (STORY-055) |
| `SEARCH_LOOKBACK_IDS` | `1000` | Ids re-read behind the mark each run, for rows that committed late (STORY-055) |
| `JWT_SECRET` | dev-only default | Session signing key. The server refuses to start with the default when `NODE_ENV=production` |
| `JWT_TTL` | `12h` | How long a session lasts |
| `WORKER_POLL_SECONDS` | `5` | How often a worker looks for due work |
| `JOB_SWEEP_SECONDS` | `300` | How often each recurring sweep is due; what its idempotency key buckets on |
| `JOB_MAX_ATTEMPTS` | `3` | Attempts before a job is handed to a human |
| `JOB_BACKOFF_SECONDS` | `30` | First retry delay; doubles each attempt |
| `JOB_STALE_SECONDS` | `300` | A job still running after this belongs to a worker that died |
| `HEARTBEAT_SECONDS` | `15` | How often each process writes "still here" (STORY-027) |
| `INSTANCE_STALE_SECONDS` | `60` | Quiet for longer than this and an instance is down — four missed beats |
| `INSTANCE_DEAD_SECONDS` | `600` | Quiet for longer than this and the row is retired as presumed dead |
| `HEALTH_CHECK_SECONDS` | `30` | How often each process checks on the others, between the worker's sweeps |
| `PUBLIC_URL` | `http://localhost:$PORT` | Where a monitor can probe this API instance's `/api/ready` from outside it |

### Content providers

`stub` (default) composes platform-shaped copy from the book's own themes and sentences. It is
deterministic and needs no network, so tests and demos are reproducible. `anthropic` calls the real
Messages API.

For press materials both providers are handed the *retrieved* grounding rather than the book: the
stub writes each key message into the copy, and the Anthropic prompt carries the passages per theme
in place of the first 2,500 characters of the book, which was never retrieval — it was whatever
happened to be at the front.

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
- **Theme alignment** (`alignToThemes`) — per theme, naming it 40% and carrying its key message 60%,
  averaged across the book's themes. Naming is worth less than the escalation floor on purpose, and
  the message half is measured against the retrieved evidence the draft was written from.

Two scores are never a model call at all, because both decide what reaches a human and so have to be
reproducible. Opportunity relevance (`scoreOpportunity`) weights having any strong theme match (55%)
above breadth across themes (30%) and loose vocabulary overlap (15%). Theme alignment is scored by
our code against the same passages the provider was given — the model is grounded in the evidence
and then measured against it, never asked to report its own alignment. The themes recorded against a
material are the verified matches rather than the provider's own claim about what it used.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` | Sign in; returns a JWT and the user (public) |
| `GET` | `/api/auth/me` | Who the current token says you are |
| `GET` | `/api/health` | Liveness plus active provider (public) |
| `POST` | `/api/authors/:id/books` | Upload book content |
| `POST` | `/api/authors/:id/social-history` | Upload prior posts |
| `POST` | `/api/authors/:id/books/:bookId/drafts` | Generate a week of drafts |
| `GET` | `/api/drafts?authorId=&status=` | List drafts, with per-theme verdicts and the floors in force |
| `GET` | `/api/authors/:id/books/:bookId/voice-grounding` | What a draft is written from: retrieved themes and the derived voice |
| `GET` | `/api/authors/:id/weekly-coverage` | Cadence proof per week |
| `POST` | `/api/drafts/:id/approve` · `/reject` | Record a human decision |
| `POST` | `/api/drafts/:id/schedule` | Queue an approved draft |
| `POST` | `/api/scheduled-posts/publish-due` | Publish through mocked adapters |
| `POST` | `/api/authors/:id/books/:bookId/opportunities/scout` | Scan directories; `{"types":["speaking"]}` narrows the search |
| `GET` | `/api/authors/:id/opportunity-rejections` | The leads the filter hid, and how close each came |
| `GET` | `/api/meme-templates` | The library, with the usability verdict on each row |
| `POST` | `/api/meme-templates` | Add a template (admin; refuses one with no licence) |
| `POST` | `/api/meme-templates/:key/retire` | Retire a template (admin; the row survives) |
| `GET` | `/api/authors/:id/books/:bookId/visual-identity` | The guide in force, and every version behind it |
| `POST` | `/api/authors/:id/books/:bookId/visual-identity` | Revise it — always a new version, never an edit |
| `GET` | `/api/integrations` | Every external service's call volume, retries and failures |
| `GET` | `/api/ready` | Readiness — 503 when this instance should not be routed to (public) |
| `GET` | `/api/deployments` | What is running, and what ran before it |
| `GET` | `/api/system/health` | Each component and instance with its latest verdict, and every outage (STORY-027) |
| `GET` | `/api/authors/:id/content-performance` | Every published post's series, totals, and what the numbers can and cannot say (STORY-029) |
| `POST` | `/api/system/health-check` | Perform the checks now — can open an outage and page (`system.operate`) |
| `GET` | `/api/authors/:id/trust-dashboard` | Health, pending approvals, recent actions, anomalies |
| `GET` | `/api/audit-integrity` | Whether the log still says what it said when written |
| `POST` | `/api/audit-integrity/verify` | Seal what is new and re-check every seal (admin) |
| `GET` | `/api/authors/:id/awaiting-approval` | One queue across all four things a human decides |
| `POST` | `/api/authors/:id/awaiting-approval/notify` | Tell reviewers what is newly waiting on them |
| `GET` | `/api/authors/:id/format-performance` | Meme vs text per platform, with what it cannot conclude |
| `POST` | `/api/authors/:id/engagement/collect` | Run a collection pass (mocked adapters) |
| `POST` | `/api/authors/:id/mix-recommendations/scan` | Ask for a proposal; it proposes, never applies |
| `POST` | `/api/mix-recommendations/:id/approve` · `/reject` | The only thing that moves the mix |
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
| `GET` | `/api/authors/:id/awards/awaiting-outcome` | Awards whose ceremony has passed with no result recorded |
| `POST` | `/api/milestones/:id/award-outcome` | Record won / not_won / shortlisted; a win drafts, a loss does not |
| `POST` | `/api/milestones/:id/press-kit` | Draft the three press materials for a milestone |
| `POST` | `/api/authors/:authorId/books/:bookId/pr-materials` | Generate PR materials on request, with no milestone (STORY-018) |
| `GET` | `/api/audit-log?authorId=` | The trail. Requires `audit.read`; scoped to your tenant without `tenant.read.all` (STORY-019) |
| `GET` | `/api/authors/:authorId/trust-history?limit=` | The score as a series, plus every episode of a check being broken (STORY-021) |
| `GET` | `/api/audit-integrity` | Tamper verification over the sealed ranges. Requires `audit.verify` |
| `GET` | `/api/press-kits?authorId=` | Kits with their materials, theme and voice scores, and distributions |
| `POST` | `/api/pr-materials/:id/approve` · `/reject` | Record a human decision |
| `POST` | `/api/press-kits/:id/distribute` | Distribute to matching press contacts (mocked) |
| `GET` | `/api/press-contacts` | The mocked press list with beats |
| `GET` | `/api/books/:id/themes` | Key message and evidence count per theme — what a draft would be grounded in |
| `GET` · `POST` | `/api/authors/:id/reviewers` | Who hears about pending work (an address book, not permissions) |
| `POST` | `/api/reviewers/:id/active` | Stop or resume notifying someone, keeping their history |
| `GET` | `/api/authors/:id/pending-review` | What is awaiting a human decision, and whether anyone was told |
| `POST` | `/api/authors/:id/notify-pending` | Notify reviewers of everything pending (what a cron would call) |
| `GET` | `/api/notifications?authorId=` | Notifications sent, with delivery status |
| `GET` | `/api/authors/:id/escalations` | What was escalated, why, by whom, and whether it is still open |
| `POST` | `/api/authors/:id/escalations/scan` | Re-derive every escalation decision now (the worker also does this on a schedule) |
| `GET` | `/api/jobs` | Run health: recent jobs, status counts, and what needs a human |
| `POST` | `/api/jobs/:id/retry` | Put a dead-lettered job back in the queue |
| `POST` | `/api/jobs/tick` | Run one worker cycle on demand |
| `GET` | `/api/audit-log?authorId=` | Read the append-only log |
| `GET` | `/api/tenants` | Every tenant, its status, and when it was onboarded (admin) |
| `POST` | `/api/tenants` | Onboard an author and their login in one transaction (admin) |
| `POST` | `/api/tenants/:id/suspend` | Suspend access without deleting the record (admin) |
| `POST` | `/api/tenants/:id/restore` | Restore a suspended tenant (admin) |
| `GET` | `/api/tenants/isolation` | Latest isolation check: tables checked, exclusions, findings |
| `POST` | `/api/tenants/isolation/verify` | Run the isolation check now against the database |
| `GET` | `/api/authors/:id/attention` | Waiting items and recent actions with timestamps and priority; what waits for the caller (STORY-057) |
| `GET` | `/api/authors/:id/governance-score?days=` | The governance score with each factor's measurement and weight (STORY-058) |
| `GET` | `/api/authors/:id/search?q=&source=&from=&to=` | Search the tenant's audit and data access logs in the index; 503 with no index (STORY-055) |
| `GET` | `/api/authors/:id/search/status` | How far the index has got; counts only for those who read across tenants (STORY-055) |

## Known gaps

These are deliberate deferrals, not oversights:

- Authentication exists as of STORY-064, but only a thin slice: no signup, no password reset, no
  refresh tokens, no lockout after repeated failures. Per-resource permissions arrived early, in
  STORY-019, because the audit log's access-control clause needed them. Seed passwords are printed
  by `npm run db:reset` and are not secret.
- **The audit log's key cannot yet be rotated.** Since STORY-049 every entry is AES-256 ciphertext
  under a key kept outside the database; each row records its key id, and the invariant
  `audit.encrypted` counts any entry under another key, but re-encrypting under a new key is not
  built. And the running application holds the key: whoever controls it reads the log.
- **Permissions are carried in the token, so a grant change waits for the next sign-in.** The guard
  that reads them runs before Express has matched a route and has to be synchronous. This is the
  same staleness `role` has had since STORY-064 — `role` was always a claim — so it adds no new
  class of problem, but revoking a permission does not end a session that already holds it.
- **The redaction list is a fixed set of key names.** It catches `password`, `token`, `api_key` and
  the rest by name, at any depth. A credential stored under a field called something else reaches
  the log, and once there it cannot be removed. The list is one regex in `services/auditLog.js`,
  deliberately readable rather than clever.
- **The outbound registry is declared, not discovered.** `outboundPaths.js` lists every way out and
  the adapters refuse an undeclared one, so a path cannot *send* without an entry. What no mechanism
  checks is whether the entry is **honest**: a new path could declare itself `EXEMPT` with a
  plausible sentence and ship ungated. The registry moves the failure from silent to visible — a
  reviewer can see the exemption and argue with it — rather than making a wrong exemption
  impossible.
- **A new gated path still needs its invariant written by hand.** `gate.outbound_declared` catches a
  gated path that names no invariant, but nobody has to name one — declaring the path `EXEMPT`
  avoids the requirement entirely. Same standing limitation as every other check here.
- **The `audit.states_recorded` check names the entity types it covers.** A new approvable thing
  gets no coverage until somebody adds it to that list — the same standing limitation as every other
  check here, and the reason its first version was wrong in the other direction (it demanded a prior
  state from 67 gate refusals).
- The session token lives in `localStorage`, so any script running on the page can read it. An
  httpOnly cookie would fix that and brings CSRF handling with it — a deliberate trade for a slice
  labelled thin, and named here rather than hidden.
- Per-tenant isolation is enforced in application middleware over `author_id` columns, not the
  separate-schema-per-tenant model the requirements describe. It is checked in three places — the
  path parameter, the query string, and the owning row when the URL names no tenant — and there is no
  database-level row policy behind it, so a route that queries a table directly without going through
  those checks bypasses them. That is not hypothetical: STORY-017 found two such routes in this
  project's own trust dashboard. They are fixed, and a cross-tenant API walk now guards the category,
  but the walk covers the routes that exist today — a new handler written the same careless way is
  caught only if someone adds it to that test. PostgreSQL row-level security would make the boundary
  structural instead of remembered, and is the honest next step for anything carrying real tenants.
- `verifyIsolation` reads the database directly rather than going through the API, which is what
  makes it able to see a cross-tenant parentage no request would reveal. It runs on demand and from
  the governance sweep; nothing runs it on a schedule with an alert behind it, so today it finds a
  breach only when somebody asks.
- Publishing, outreach sending and press distribution are triggered on demand rather than by a
  background worker. STORY-004 added the *detection* a worker would call
  (`draftApproachingKits`), but something still has to call it — the UI button, the demo, or a cron
  entry. Nothing runs on a timer yet.
- Social platform, directory, email and press-list adapters are all mocked; no live credentials are
  involved. As of STORY-016 the timeout, retry and logging policy around them is real, which is the
  part that had never been exercised — but a mock still cannot produce the failures it was written
  to survive, so that policy is tested against constructed faults rather than observed ones.
- There is no circuit breaker. A provider that is down is retried on every call rather than being
  given up on for a while, which is the right shape at this call volume and the wrong one at any
  real one.
- `api_interactions` has no retention policy. One row per attempt is the right grain and an unbounded
  one; nothing prunes it.
- Credentials are a single environment variable per provider with no rotation and no per-tenant keys.
  The agent handles *how* a call is made, not who it is made as. **Engagement metrics are mocked too**, which is the largest caveat in this README:
  STORY-069 builds the apparatus for answering "do memes outperform text" and cannot answer it. The
  collector is deliberately format-blind so no demo can imply otherwise.
- The comparison uses a normal-approximation interval, not a t-test, and no correction for testing
  four platforms at once. At `MIN_SAMPLE_PER_CELL` = 8 the minimum-sample rule is doing nearly all
  the work and the interval very little; both would need revisiting before this drove a real
  decision.
- Engagement is one snapshot per post, not a time series, so nothing can show how a post accumulated
  or distinguish a fast-fading meme from a slow-burning essay. The mocked publisher accepts a meme's caption and never sees the image, so nothing has
  tested that an image of this size and type would be accepted by a real platform.
- Meme images are SVG **drawn**, not generated. As of STORY-067 the artwork lives in the database as
  a licensed asset rather than being composed from a palette at draft time, which is what makes
  replacing it with a photograph a data change rather than a code change — but there is still no
  image model and no stock provider behind it. A generated image would need its own provenance shape
  and its own rights answer, and that is its own story.
- Every template's artwork is house-drawn or press-drawn. Nothing here exercises a third-party
  licence that is *satisfiable but demanding* — a share-alike term, or an attribution that has to
  appear in the post text rather than in the provenance record.
- The visual identity checks colour and forbidden terms. It says nothing about composition, weight,
  spacing or whether the typography it records is the typography the artwork actually uses — a
  template could declare Georgia, render in something else, and score a clean 1.00.
- `MIN_IDENTITY_MATCH` is one number over a weighted sum. A meme with the right accent in the wrong
  mode and a meme with two accents in the right mode can land on the same score for very different
  reasons; the findings say which, but the threshold cannot be tuned per finding.
- Nothing re-scores existing drafts when the guide is revised. That is deliberate — a revision must
  not reinterpret a decision a human already made — but it does mean a queue can hold memes judged
  under three different versions with nothing surfacing that fact to the reviewer.
- Brand safety is a readable list of terms plus two structural checks, not a classifier. It will
  miss an off-key joke that uses none of those words, which is the same class of blind spot
  STORY-010 named — inspectable on purpose, because it decides what a person is asked to look at.
- `image_rights` is decided once, at generation. Nothing re-checks it later, so a licence that is
  revoked after a meme was cleared stays cleared. STORY-008's monitor re-derives escalation
  decisions on a schedule and this is the obvious second thing for it to re-derive.
- Alt text is generated from the template name and the caption. It describes the *text* in the
  image, not the image, which is the honest limit of writing alt text without seeing a picture.
- Directory listings are a fixed catalogue, so a monthly rescan finds nothing new. A live adapter
  would return fresh listings over time. As of STORY-010 the adapters accept a type filter, so a
  real one could be asked for speaking listings only rather than filtered after the fact.
- `AUTHOR_FORMATS` is a fixed list of sixteen phrases. A listing that wants an author and says so in
  words not on the list — "an evening with…", a festival named after itself — scores zero standing
  and is rejected, which is the same class of blind spot this story exists to close, one level in.
  It is a readable list rather than a classifier on purpose: this decides what a human never sees,
  so a reviewer has to be able to read the rule. The rejections table is where the next such lead
  would be found.
- Expertise is scored for opportunity scouting only. Nothing else in the system knows the author has
  standing — the outreach message drafted for a lead that qualified on expertise still pitches the
  book's themes rather than the author, which is the wrong pitch for a library reading group. The
  next story that asks for it is where that belongs.
- A track record contributes to expertise by *type* — an author who has done one event scores a
  little on every event, including a protocol meetup (0.075, well under the floor). Coarse but
  harmless at these weights; it would need topic-level matching before it could carry more.
- **Nothing is deployed.** STORY-015 built readiness, release records and graceful shutdown, all
  verified locally; the Dockerfiles and compose stack have never been executed, the CI workflow ran
  once on GitHub and failed (STORY-053 found why and mirrors it in `npm run ci:local`), and there is no
  public URL (STORY-030). The list of what needs a platform is in the STORY-015 section above.
- The worker exists as of STORY-065 but has to be started (`npm run worker`) and is not supervised —
  nothing restarts it if the process dies. As of STORY-027 a worker that dies is *noticed*: it stops
  beating, the API's monitor opens an outage and pages whoever holds `system.operate`. Restarting it
  is still a person's job, and a worker never started is `not running`, not an outage.
- **The monitoring cannot see three things** (STORY-027): a database outage, because the checker
  records its findings in the database; both processes dying at once, because each notices only the
  other; and a stalled host, because a sleeping laptop stops the checker along with everything it
  checks — the first real outage this caught was that, at 1,060 seconds' lag. A real deployment
  needs one probe that lives outside both processes, hitting `/api/ready` and reading
  `/api/system/health`; that is the Prometheus in the build note, and it is not installed here. Deployment and process supervision are R5. As of STORY-011 running
  several is safe rather than merely possible: two workers used to break the producer/consumer order
  between agents silently.
- Priorities and resources are a static table in `coordination.js`, not configuration. A new job kind
  that forgets to declare either gets the middle priority and no exclusion, which is the safe default
  but a silent one — nothing warns that a kind sharing another's rows was never given its resource.
- A job deferred because its resource is busy is passed over, not queued behind the holder. With work
  that always contends, a low-priority job could in principle be passed over indefinitely; nothing
  ages a waiting job upward. Not reachable with the five kinds that exist — every resource is
  released within one job — and named rather than defended.
- The coordinator orders work; it does not cancel or reschedule it. A job whose author was deleted
  mid-window still fails its way to a dead letter rather than being withdrawn.
- The Trust and Monitoring Agent covers press materials only. Social drafts and outreach messages
  now share its policy module but are not re-derived by anything — the same one-target-at-a-time
  extension approvals, notifications and escalations have all grown by, deliberately left for a story
  that asks for it. STORY-009 sharpens this one rather than closing it: social drafts now carry
  `theme_alignment` and `voice_score` as stored numbers, so an independent re-derivation of a social
  post is newly possible and still nothing does it.
- Voice is derived and enforced for **social posts only**. Press materials and outreach emails still
  score voice as the vocabulary overlap STORY-009 replaced, so the copy going to a journalist is
  measured by the weaker of the two tests. Same one-target-at-a-time trade, named rather than hidden.
- The voice check counts what can be counted: sentence length, exclamations, marketing terms from a
  fixed list, shouting, and vocabulary overlap. It cannot hear warmth, irony or a register that is
  wrong in a way no counter registers — a post can pass every trait and still not sound like the
  author. `HYPE_TERMS` is a short inspectable list rather than a classifier on purpose: a rule the
  drafter cannot argue with, and a reviewer can read.
- Nobody is held to a voice below `MIN_POSTS_FOR_TRAIT` (3) previous posts. With two posts to go on,
  "this author never uses an exclamation mark" is a coincidence, and a new author would be escalated
  for having written nothing yet. The consequence is real: an author who uploads no history gets a
  neutral 0.6 and the voice floor never bites.
- Dead-lettered jobs are surfaced and retryable, but nobody is *told* about them. STORY-007 built
  notification for pending reviews and STORY-012 extended it to the other three approval targets;
  work the system has given up on still has no equivalent alert.
- Audit checkpoints live in the same database as the log they seal. Anyone who can disable one set
  of triggers can disable the other and re-seal a doctored range; detection survives everything short
  of that. Publishing digests off-box is the real answer and is a deployment decision.
- A detected break says a range changed, not which row. Narrowing it would mean per-row hashes, which
  is the write-path cost the checkpoint design exists to avoid.
- Nothing is *notified* when tampering is found — the verdict is logged with `needsHuman: true` and
  surfaced in the worker's run health, but the STORY-012 digest does not carry it.
- The trust dashboard is assessed on request, not on a schedule, so nothing alerts when a check
  starts failing — `governance.assessed` is written to the audit log each time it is viewed, which
  makes the score a series only for as long as somebody keeps looking.
- The governance checks are a fixed list in `governance.js`. A new outbound path added later gets no
  invariant unless somebody remembers to write one, and nothing warns that it is unwatched — the same
  shape of gap STORY-011 named for job resources.
- Anomaly detection covers three patterns and no statistical baselines. There is not enough history
  in this system for a rate-of-change detector to say anything honest, which is why there isn't one.
- Notification is email only, and one channel means one failure mode. A reviewer who does not read
  email is a reviewer who is not notified, and nothing escalates a digest that was never opened.
- A digest is sent once per item per reviewer and never repeated. That is the right default against
  noise and the wrong one against neglect: an item nobody decides is announced once and then never
  mentioned again, and nothing chases it.
- Reviewers are still an address book, not accounts, and that is intended: a publicist who gets
  emailed about a pending kit does not need a login. `reviewers.user_id` links the two where the same
  person is both. Approving now requires a session (STORY-064); being notified does not.
- Theme retrieval is lexical, not semantic. `plainto_tsquery` finds a passage that uses the theme's
  words; a passage that argues the theme in entirely different words is invisible to it. Embeddings
  would find it, at the cost of the offline, reproducible stub the tests and demo depend on.
- `book_themes.key_message` is written by a human. Nothing infers what a book argues, on purpose —
  a claim invented about the book is exactly the failure alignment exists to catch. A theme with no
  key message degrades to its retrieved passage rather than being skipped.
- Milestones are still seeded or entered by hand. STORY-004 detects an approaching one and drafts for
  it, but nothing generates the milestone itself — an anniversary does not recur onto next year's
  calendar on its own. Award *results* are recorded by a person for the same reason: the system will
  not scrape a prize site and guess.
- A press kit is distributed as one email per contact. Real newsroom workflows expect attachments
  and an embargo date, neither of which the mocked provider models.
- The build guide specifies Create React App; this uses Vite, since CRA is deprecated and
  unmaintained.
