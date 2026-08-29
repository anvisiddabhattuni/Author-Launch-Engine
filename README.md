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
| 2. CI/CD pipeline | `.github/workflows/ci.yml` — **never run** |
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

Prints 116 stages with evidence at each one.

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

Stage 16 deliberately leaves the anniversary alone so stage 22 has something to find: STORY-003
drafts when a person asks, STORY-004 drafts when the date approaches. Stage 16 *does* draft the
award as a shortlisting, so stage 27 can withdraw it when the win is recorded.

## Tests

```bash
npm run db:reset && npm test
```

446 tests across 106 suites. For each story the leading suites map one-to-one onto its Gherkin
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
| `MAX_UNSEALED_AUDIT_ROWS` | `50` | Unsealed audit rows tolerated before the governance check complains |
| `FAST_APPROVAL_SECONDS` | `5` | A decision quicker than this looks like a rubber stamp |
| `MIN_DECISIONS_FOR_PATTERN` | `10` | Decisions a reviewer needs before their pattern means anything |
| `ENGAGEMENT_MATURITY_HOURS` | `48` | How long a post must be live before its metrics count |
| `EXPERTISE_THRESHOLD` | `0.5` | Below this fit against the *author*, a listing does not qualify on expertise |
| `MILESTONE_LEAD_TIME_DAYS` | `30` | How far ahead a milestone counts as approaching, and drafting begins |
| `JWT_SECRET` | dev-only default | Session signing key. The server refuses to start with the default when `NODE_ENV=production` |
| `JWT_TTL` | `12h` | How long a session lasts |
| `WORKER_POLL_SECONDS` | `5` | How often a worker looks for due work |
| `JOB_SWEEP_SECONDS` | `300` | How often each recurring sweep is due; what its idempotency key buckets on |
| `JOB_MAX_ATTEMPTS` | `3` | Attempts before a job is handed to a human |
| `JOB_BACKOFF_SECONDS` | `30` | First retry delay; doubles each attempt |
| `JOB_STALE_SECONDS` | `300` | A job still running after this belongs to a worker that died |

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
| `GET` | `/api/ready` | Readiness — 503 when this instance should not be routed to (public) |
| `GET` | `/api/deployments` | What is running, and what ran before it |
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
| `GET` | `/api/press-kits?authorId=` | Kits with their materials, scores and distributions |
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

## Known gaps

These are deliberate deferrals, not oversights:

- Authentication exists as of STORY-064, but only a thin slice: two roles, no signup, no password
  reset, no refresh tokens, no lockout after repeated failures. Per-resource permissions are
  STORY-022 in R5. Seed passwords are printed by `npm run db:reset` and are not secret.
- The session token lives in `localStorage`, so any script running on the page can read it. An
  httpOnly cookie would fix that and brings CSRF handling with it — a deliberate trade for a slice
  labelled thin, and named here rather than hidden.
- Per-tenant isolation is enforced in application middleware over `author_id` columns, not the
  separate-schema-per-tenant model the requirements describe. It is checked in three places — the
  path parameter, the query string, and the owning row when the URL names no tenant — and there is no
  database-level row policy behind it, so a route that queries a table directly without going through
  those checks would bypass them.
- Publishing, outreach sending and press distribution are triggered on demand rather than by a
  background worker. STORY-004 added the *detection* a worker would call
  (`draftApproachingKits`), but something still has to call it — the UI button, the demo, or a cron
  entry. Nothing runs on a timer yet.
- Social platform, directory, email and press-list adapters are all mocked; no live credentials are
  involved. **Engagement metrics are mocked too**, which is the largest caveat in this README:
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
  verified locally; the Dockerfiles, compose stack and CI workflow have never been executed, and
  there is no public URL. The list of what needs a platform is in the STORY-015 section above.
- The worker exists as of STORY-065 but has to be started (`npm run worker`) and is not supervised —
  nothing restarts it if the process dies, and a machine with no worker running looks identical to a
  machine with nothing to do. Deployment and process supervision are R5. As of STORY-011 running
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
