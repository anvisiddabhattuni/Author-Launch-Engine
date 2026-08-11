-- STORY-002 / REQ-002 — identify opportunities and draft outreach messages
-- Reuses the REQ-005 audit log and REQ-006 approval gate built for STORY-001.

BEGIN;

-- Opportunities discovered in external directories. The unique key on
-- (author_id, source, external_id) makes re-scanning idempotent, so a monthly
-- count reflects distinct opportunities rather than how often we scanned.
CREATE TABLE IF NOT EXISTS opportunities (
    id               BIGSERIAL PRIMARY KEY,
    author_id        BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    source           TEXT        NOT NULL,
    external_id      TEXT        NOT NULL,
    type             TEXT        NOT NULL,
    name             TEXT        NOT NULL,
    host             TEXT        NOT NULL DEFAULT '',
    contact_email    TEXT        NOT NULL DEFAULT '',
    url              TEXT        NOT NULL DEFAULT '',
    description      TEXT        NOT NULL DEFAULT '',
    topics           TEXT[]      NOT NULL DEFAULT '{}',
    audience_size    INTEGER,
    deadline         DATE,
    relevance        NUMERIC(4,3) NOT NULL,
    matched_themes   TEXT[]      NOT NULL DEFAULT '{}',
    rationale        TEXT        NOT NULL DEFAULT '',
    -- First day of the month the opportunity was found, for the monthly
    -- cadence criterion in REQ-002.
    discovered_month DATE        NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'identified',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT opportunities_type_check CHECK (type IN ('speaking', 'podcast', 'event')),
    CONSTRAINT opportunities_status_check CHECK (status IN ('identified', 'dismissed')),
    CONSTRAINT opportunities_relevance_range CHECK (relevance >= 0 AND relevance <= 1),
    CONSTRAINT opportunities_unique_listing UNIQUE (author_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS opportunities_author_month_idx ON opportunities (author_id, discovered_month);
CREATE INDEX IF NOT EXISTS opportunities_type_idx ON opportunities (type);

-- One outreach message per opportunity, held behind the approval gate exactly
-- like a social draft.
CREATE TABLE IF NOT EXISTS outreach_messages (
    id             BIGSERIAL PRIMARY KEY,
    opportunity_id BIGINT      NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
    author_id      BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id        BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    subject        TEXT        NOT NULL,
    body           TEXT        NOT NULL,
    -- Which opportunity-specific details the message actually referenced;
    -- drives the personalisation half of the confidence score.
    personalization TEXT[]     NOT NULL DEFAULT '{}',
    confidence     NUMERIC(4,3) NOT NULL,
    rationale      TEXT        NOT NULL DEFAULT '',
    status         TEXT        NOT NULL DEFAULT 'pending_approval',
    generated_by   TEXT        NOT NULL DEFAULT 'PROutreachAgent',
    provider       TEXT        NOT NULL DEFAULT 'stub',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT outreach_status_check CHECK (
        status IN ('pending_approval', 'escalated', 'approved', 'rejected', 'sent')
    ),
    CONSTRAINT outreach_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT outreach_one_per_opportunity UNIQUE (opportunity_id)
);

CREATE INDEX IF NOT EXISTS outreach_messages_author_idx ON outreach_messages (author_id);
CREATE INDEX IF NOT EXISTS outreach_messages_status_idx ON outreach_messages (status);

CREATE TABLE IF NOT EXISTS outreach_sends (
    id           BIGSERIAL PRIMARY KEY,
    message_id   BIGINT      NOT NULL REFERENCES outreach_messages(id) ON DELETE CASCADE,
    author_id    BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    recipient    TEXT        NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'queued',
    external_id  TEXT,
    sent_at      TIMESTAMPTZ,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT outreach_sends_status_check CHECK (status IN ('queued', 'sent', 'failed')),
    CONSTRAINT outreach_sends_one_per_message UNIQUE (message_id)
);

-- Widen the approval record to cover outreach messages as well as social
-- drafts. Nullable foreign keys with an exactly-one check keep real
-- referential integrity, which a polymorphic entity_id column would lose.
ALTER TABLE approvals ALTER COLUMN draft_id DROP NOT NULL;

ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS outreach_message_id BIGINT REFERENCES outreach_messages(id) ON DELETE CASCADE;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_target;
ALTER TABLE approvals
    ADD CONSTRAINT approvals_exactly_one_target
    CHECK (num_nonnulls(draft_id, outreach_message_id) = 1);

CREATE INDEX IF NOT EXISTS approvals_outreach_idx ON approvals (outreach_message_id);

COMMIT;
