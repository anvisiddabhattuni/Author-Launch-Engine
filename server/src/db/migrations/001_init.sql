-- Author Launch Engine — initial schema
-- STORY-001 / REQ-001 (draft + schedule social content)
-- REQ-005 (append-only audit log), REQ-006 (approval gates)

BEGIN;

-- Authors are the tenant boundary. Every content row carries author_id so a
-- tenant filter can be applied on every read (REQ-011 per-tenant isolation).
CREATE TABLE IF NOT EXISTS authors (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT        NOT NULL,
    email         TEXT        NOT NULL UNIQUE,
    -- Tone descriptors distilled from the author's prior posts; the drafting
    -- agent scores candidate drafts against these.
    voice_profile JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    title      TEXT        NOT NULL,
    content    TEXT        NOT NULL,
    themes     TEXT[]      NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS books_author_idx ON books (author_id);

-- Prior posts supplied by the author. Used to derive the voice profile and to
-- avoid repeating angles the author has already published.
CREATE TABLE IF NOT EXISTS social_history (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    platform   TEXT        NOT NULL,
    content    TEXT        NOT NULL,
    engagement JSONB       NOT NULL DEFAULT '{}'::jsonb,
    posted_at  TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS social_history_author_idx ON social_history (author_id);

-- A draft never reaches a social platform directly: it must pass the approval
-- gate, then be scheduled. status drives that state machine.
CREATE TABLE IF NOT EXISTS drafts (
    id            BIGSERIAL PRIMARY KEY,
    author_id     BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id       BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    platform      TEXT        NOT NULL,
    content       TEXT        NOT NULL,
    themes_used   TEXT[]      NOT NULL DEFAULT '{}',
    confidence    NUMERIC(4,3) NOT NULL,
    rationale     TEXT        NOT NULL DEFAULT '',
    status        TEXT        NOT NULL DEFAULT 'pending_approval',
    -- ISO week bucket (Monday) used to prove the "3 posts per week" criterion.
    week_of       DATE        NOT NULL,
    generated_by  TEXT        NOT NULL DEFAULT 'ContentDraftingAgent',
    provider      TEXT        NOT NULL DEFAULT 'stub',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT drafts_status_check CHECK (
        status IN ('pending_approval', 'escalated', 'approved', 'rejected', 'scheduled')
    ),
    CONSTRAINT drafts_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS drafts_author_week_idx ON drafts (author_id, week_of);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status);

-- Every human decision on a draft, kept even when a draft is later re-decided.
CREATE TABLE IF NOT EXISTS approvals (
    id         BIGSERIAL PRIMARY KEY,
    draft_id   BIGINT      NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    decision   TEXT        NOT NULL,
    reviewer   TEXT        NOT NULL,
    notes      TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT approvals_decision_check CHECK (decision IN ('approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS approvals_draft_idx ON approvals (draft_id);

CREATE TABLE IF NOT EXISTS scheduled_posts (
    id            BIGSERIAL PRIMARY KEY,
    draft_id      BIGINT      NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    author_id     BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    platform      TEXT        NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'queued',
    external_id   TEXT,
    published_at  TIMESTAMPTZ,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_posts_status_check CHECK (status IN ('queued', 'published', 'failed')),
    -- A draft can only occupy one slot in the publishing queue.
    CONSTRAINT scheduled_posts_draft_unique UNIQUE (draft_id)
);

CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx ON scheduled_posts (status, scheduled_for);

-- Per-platform posting windows, seeded from the author's own engagement data
-- where available. Drives "optimal times" in the scheduling criterion.
CREATE TABLE IF NOT EXISTS platform_windows (
    platform    TEXT    PRIMARY KEY,
    -- Local hours-of-day, best first.
    best_hours  INTEGER[] NOT NULL,
    -- ISO weekday numbers (1 = Monday) the platform performs best on.
    best_days   INTEGER[] NOT NULL DEFAULT '{1,2,3,4,5}',
    max_chars   INTEGER NOT NULL
);

-- REQ-005: append-only audit log. Rows record who/what/when plus before-after.
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor       TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    entity_type TEXT        NOT NULL,
    entity_id   TEXT,
    author_id   BIGINT,
    before      JSONB,
    after       JSONB,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- Append-only is enforced in the database, not just in application code, so a
-- bug or a direct psql session cannot rewrite history.
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
    BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- Row-level triggers do not fire for TRUNCATE, so guard it separately.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

COMMIT;
