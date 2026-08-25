-- STORY-011 / REQ-003 + REQ-004 — the Coordination and Governance Agent manages
-- tasks across agents
--
-- STORY-065 built the queue that runs every agent's scheduled work, and built it
-- to support more than one worker: "SKIP LOCKED is what lets more than one
-- worker run". It does. What it has no way to say is that some of that work
-- must not run at the same time as other work, or that some of it matters more.
--
-- Both gaps are demonstrable on the shipped system:
--
--   Ordering. `press.draft_approaching` PRODUCES the press materials that
--   `trust.monitor_escalations` and `reviews.notify_pending` CONSUME. Nothing
--   anywhere says so. With one worker the order happens to be right, because
--   RECURRING is declared producer-first and the jobs get ascending ids. With
--   two workers they run simultaneously: six materials are created and the
--   monitor examines *zero* of them, because it read the table while the
--   drafter's transaction was still open. The work then sits unexamined and
--   nobody is told until the next sweep window.
--
--   Priority. Claiming is FIFO on (run_at, id). A human approves an outreach
--   email and the send queues behind every internal sweep in the window — one
--   per author per kind. The one piece of outbound, time-sensitive,
--   human-authorised work in the queue is the last thing the worker reaches.
--
-- Two columns fix both, and the exclusion is enforced by the database rather
-- than by the claim query alone, for the same reason the audit log's
-- append-only rule is a trigger and not a code convention.

BEGIN;

-- Higher runs first. A plain integer rather than an enum: the useful operation
-- is comparison, and a deployment that needs to slot something between two
-- existing bands should not need a migration to do it.
--
-- Default 50 puts anything unclassified in the middle — below outbound work a
-- human is waiting on, above the housekeeping sweeps. An unknown job should not
-- silently outrank a send, and should not be starved by a sweep either.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 50;

-- What this job needs exclusive use of while it runs, or NULL for work that
-- contends with nothing. Scoped strings rather than a foreign key, because the
-- thing being protected is a *pipeline* for one tenant — "author:7:press" — not
-- a row anyone could point at.
--
-- Scoping by author is what keeps this from serialising the whole queue: two
-- authors' press pipelines are different resources and still run in parallel.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS resource TEXT;

-- Why the coordinator gave this job the priority it did, and what it is waiting
-- behind. Written at dispatch so a queue that looks stuck can be explained
-- without re-deriving the decision from code that may since have changed.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS coordination JSONB NOT NULL DEFAULT '{}';

-- Mutual exclusion, enforced by the database.
--
-- The claim query also checks that a resource is free, but that check and the
-- UPDATE that acts on it are two steps: under READ COMMITTED two workers can
-- both see a resource idle and both claim a job needing it. This index makes
-- the second one fail instead, and `claim` treats that failure as "nothing
-- claimable right now" rather than as a job error.
--
-- Partial on status so a resource is only held while a job is actually running:
-- queued, done and dead-lettered rows hold nothing.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_per_resource
    ON jobs (resource) WHERE status = 'running' AND resource IS NOT NULL;

-- The claim query now orders by priority first, so it needs the index to match.
DROP INDEX IF EXISTS jobs_claimable_idx;
CREATE INDEX IF NOT EXISTS jobs_claimable_idx
    ON jobs (status, priority DESC, run_at, id);

COMMENT ON COLUMN jobs.priority IS
    'Higher runs first. Outbound work a human authorised outranks producing '
    'work, which outranks the consumers that react to what it produced.';

COMMENT ON COLUMN jobs.resource IS
    'Held exclusively while running. Two jobs naming the same resource never '
    'run at once; two authors naming their own still run in parallel.';

COMMIT;
