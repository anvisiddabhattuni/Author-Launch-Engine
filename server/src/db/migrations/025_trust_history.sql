-- STORY-021 / REQ-007 — the trust dashboard gets a memory, and a voice
--
-- STORY-014 built the dashboard and it satisfies both of this story's
-- acceptance clauses: it aggregates health, pending approvals, recent actions
-- and anomalies, and anomalies are detected, logged and displayed. Measured
-- before writing this, all four were there and three detectors were running.
--
-- What REQ-007 also asks is that users "monitor and **analyse** system
-- performance and trust metrics", and analysis needs more than one reading.
-- Today every load computes a fresh snapshot and compares it to nothing:
--
--   * no table stores an assessment — there were four `governance.assessed`
--     audit rows, one per time somebody happened to open the page;
--   * no recurring job assesses trust — six sweeps run on a timer and not one
--     of them is this;
--   * nothing says a check *started* failing, so an invariant that breaks at
--     2am is discovered whenever a human next looks.
--
-- A dashboard nobody is looking at reports nothing. That is the gap: not a
-- missing panel but a missing *dimension*, and the questions it makes
-- unanswerable are the ones an operator actually asks — "when did this start?"
-- and "is this getting worse?"
--
-- The audit log already stores the score as a series, and a comment in
-- trustMonitoringAgent says so. That was true and it is not enough: the audit
-- log is append-only and unindexed for this, every row is a blob of metadata,
-- and asking it "which checks changed state since last time" means parsing
-- JSON across the whole table. A read-model is the right shape for a question
-- asked on every page load.

BEGIN;

-- One row per assessment. `checks` keeps the full per-check verdict so a later
-- reader can answer "what exactly was failing then" without re-deriving it from
-- code that has since changed — the same reason escalations store the
-- thresholds in force at the time rather than looking them up now.
CREATE TABLE IF NOT EXISTS trust_assessments (
    id                BIGSERIAL PRIMARY KEY,
    -- Null for a system-wide sweep. CASCADE rather than the no-FK treatment
    -- audit_log gets, and the difference is worth stating: the audit log is
    -- *the* record of what was done and must outlive the account that did it.
    -- This table is a derived read-model of how one tenant's system was
    -- scoring. The requirements ask for GDPR compliance including "the ability
    -- to request deletion", and keeping a deleted tenant's score history is
    -- retaining their data for our convenience.
    --
    -- It also keeps STORY-017's isolation check strict. That check flagged
    -- these tables the moment they existed, and the easy fix was to widen its
    -- exclusion list — which is how a security check gets quietly hollowed out
    -- one convenience at a time.
    author_id         BIGINT REFERENCES authors(id) ON DELETE CASCADE,
    status            TEXT    NOT NULL,
    -- 0..1, and NUMERIC(4,3) to match how every other score in this schema is
    -- stored (theme_alignment, voice_score, message_score). `scoreOf` returns a
    -- fraction; storing it as a percentage here would make the dashboard and
    -- the history disagree about what the same number means.
    -- Nullable: with no checks at all there is no score, and 0 would read as
    -- "everything failed" rather than "nothing was measured".
    score             NUMERIC(4,3),
    passed            INT     NOT NULL,
    total             INT     NOT NULL,
    failed_invariants INT     NOT NULL DEFAULT 0,
    failed_quality    INT     NOT NULL DEFAULT 0,
    anomalies_found   INT     NOT NULL DEFAULT 0,
    checks            JSONB   NOT NULL DEFAULT '[]',
    assessed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trust_assessments_status_values
        CHECK (status IN ('breach', 'degraded', 'healthy')),
    CONSTRAINT trust_assessments_score_range
        CHECK (score IS NULL OR (score >= 0 AND score <= 1))
);

CREATE INDEX IF NOT EXISTS trust_assessments_recent_idx
    ON trust_assessments (author_id, assessed_at DESC);

-- A check changing state is the event an operator wants, and it is not
-- derivable from the assessments table alone without comparing adjacent rows on
-- every read. Stored when it happens, once, so "failing since" is a lookup
-- rather than a scan.
--
-- `recovered_at` null means still failing. The row is written on the
-- transition into failure and closed on the transition out, so a check that
-- fails, recovers and fails again produces two rows rather than one row that
-- forgets the first episode.
CREATE TABLE IF NOT EXISTS trust_check_episodes (
    id            BIGSERIAL PRIMARY KEY,
    author_id     BIGINT REFERENCES authors(id) ON DELETE CASCADE,
    check_id      TEXT    NOT NULL,
    severity      TEXT    NOT NULL,
    label         TEXT    NOT NULL DEFAULT '',
    violations    INT     NOT NULL DEFAULT 0,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    recovered_at  TIMESTAMPTZ,
    -- Whether a human was told. An alert that was never sent and an alert
    -- nobody read are different failures, and only the first is ours.
    alerted_at    TIMESTAMPTZ,
    CONSTRAINT trust_check_episodes_severity_values
        CHECK (severity IN ('invariant', 'quality'))
);

-- At most one open episode per check per scope. The transition detector relies
-- on this: "is this check already failing" has to be one row, or a sweep that
-- runs twice opens two episodes and the dashboard reports one outage as two.
CREATE UNIQUE INDEX IF NOT EXISTS trust_check_episodes_one_open
    ON trust_check_episodes (COALESCE(author_id, -1), check_id)
    WHERE recovered_at IS NULL;

COMMIT;
