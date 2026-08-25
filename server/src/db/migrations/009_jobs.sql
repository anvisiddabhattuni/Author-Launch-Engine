-- STORY-065 / REQ-004 — background worker and scheduler
--
-- Four functions were written as "what a cron would call" and nothing ever
-- called them: publishDue (STORY-001), sendOutreachMessage (STORY-002),
-- draftApproachingKits (STORY-004) and notifyPendingReviews (STORY-007). The
-- platform could do all its work and could not do any of it unattended, which
-- is the gap that put this story in R1.
--
-- One table, one loop, one `kind` column choosing the handler. Recurring sweeps
-- and one-off sends are the same row shape on purpose: a sweep that fails needs
-- attempts, backoff and a dead-letter exactly as much as a send does, and a
-- health view that only knew about half the work would be worse than none.

BEGIN;

CREATE TABLE IF NOT EXISTS jobs (
    id              BIGSERIAL PRIMARY KEY,
    kind            TEXT        NOT NULL,
    -- The story's words: "idempotency key enforced". Enqueueing is
    -- ON CONFLICT DO NOTHING against this, so the same unit of work cannot be
    -- queued twice however many workers or buttons ask for it. A recurring
    -- sweep buckets the current time into its key, which is what makes "run
    -- every five minutes" mean *once* per five minutes rather than once per
    -- worker per tick.
    idempotency_key TEXT        NOT NULL UNIQUE,
    -- Null for global work. Present for anything scoped to one author, so the
    -- health view can respect the tenant boundary STORY-064 established.
    author_id       BIGINT      REFERENCES authors(id) ON DELETE CASCADE,
    payload         JSONB       NOT NULL DEFAULT '{}',
    status          TEXT        NOT NULL DEFAULT 'queued',
    run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts        INT         NOT NULL DEFAULT 0,
    max_attempts    INT         NOT NULL DEFAULT 3,
    last_error      TEXT,
    -- When a worker took it. A row still 'running' long after this is a worker
    -- that died mid-job; the reaper uses it to put the work back.
    claimed_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    result          JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT jobs_status_check CHECK (
        status IN ('queued', 'running', 'done', 'dead_letter', 'cancelled')
    ),
    CONSTRAINT jobs_attempts_sane CHECK (attempts >= 0 AND max_attempts > 0)
);

-- The claim query's index: find the oldest due, queued job.
CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs (status, run_at);
CREATE INDEX IF NOT EXISTS jobs_author_idx ON jobs (author_id);
-- Dead letters are what a human is asked to look at, so they get their own path.
CREATE INDEX IF NOT EXISTS jobs_dead_letter_idx ON jobs (status) WHERE status = 'dead_letter';

COMMENT ON TABLE jobs IS
    'Unit of scheduled work. A worker claims with FOR UPDATE SKIP LOCKED, so two '
    'workers never take the same row and a slow job never blocks a fast one.';

COMMENT ON COLUMN jobs.status IS
    'queued: due or waiting for run_at. running: claimed by a worker. done: '
    'succeeded. dead_letter: retries exhausted, a human has to look. cancelled: '
    'withdrawn before it ran.';

COMMIT;
