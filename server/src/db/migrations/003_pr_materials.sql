-- STORY-003 / REQ-003 — draft PR materials for book milestones
-- Reuses the REQ-005 audit log and REQ-006 approval gate from STORY-001/002.

BEGIN;

-- The trigger for a press kit. REQ-003 names launches, anniversaries and awards
-- as the milestones worth announcing, so the type is a closed set rather than
-- free text — the drafting angle is chosen from it.
CREATE TABLE IF NOT EXISTS milestones (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id    BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    type       TEXT        NOT NULL,
    title      TEXT        NOT NULL,
    event_date DATE        NOT NULL,
    -- Free-text specifics (venue, award body, edition) the drafter can quote.
    details    TEXT        NOT NULL DEFAULT '',
    location   TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT milestones_type_check CHECK (type IN ('launch', 'anniversary', 'award')),
    -- Re-seeding or re-posting the same milestone must not create a duplicate.
    CONSTRAINT milestones_unique_event UNIQUE (book_id, type, event_date)
);

CREATE INDEX IF NOT EXISTS milestones_author_idx ON milestones (author_id);
CREATE INDEX IF NOT EXISTS milestones_date_idx ON milestones (event_date);

-- A press kit is the unit that gets distributed; the individual materials are
-- what a human approves. Keeping them separate is what lets one rejected piece
-- hold back the whole send.
CREATE TABLE IF NOT EXISTS pr_kits (
    id           BIGSERIAL PRIMARY KEY,
    milestone_id BIGINT      NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
    author_id    BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id      BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    status       TEXT        NOT NULL DEFAULT 'drafting',
    generated_by TEXT        NOT NULL DEFAULT 'PROutreachAgent',
    provider     TEXT        NOT NULL DEFAULT 'stub',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pr_kits_status_check CHECK (status IN ('drafting', 'distributed')),
    CONSTRAINT pr_kits_one_per_milestone UNIQUE (milestone_id)
);

CREATE INDEX IF NOT EXISTS pr_kits_author_idx ON pr_kits (author_id);

-- One row per piece of the kit. theme_alignment is stored separately from
-- confidence because the acceptance criterion is specifically about alignment
-- with the book's themes — burying it inside a blended score would make the
-- criterion unverifiable.
CREATE TABLE IF NOT EXISTS pr_materials (
    id              BIGSERIAL PRIMARY KEY,
    kit_id          BIGINT      NOT NULL REFERENCES pr_kits(id) ON DELETE CASCADE,
    author_id       BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id         BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    type            TEXT        NOT NULL,
    headline        TEXT        NOT NULL,
    body            TEXT        NOT NULL,
    themes_used     TEXT[]      NOT NULL DEFAULT '{}',
    theme_alignment NUMERIC(4,3) NOT NULL,
    confidence      NUMERIC(4,3) NOT NULL,
    rationale       TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'pending_approval',
    generated_by    TEXT        NOT NULL DEFAULT 'PROutreachAgent',
    provider        TEXT        NOT NULL DEFAULT 'stub',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pr_materials_type_check CHECK (
        type IN ('press_release', 'author_bio', 'fact_sheet')
    ),
    CONSTRAINT pr_materials_status_check CHECK (
        status IN ('pending_approval', 'escalated', 'approved', 'rejected', 'distributed')
    ),
    CONSTRAINT pr_materials_alignment_range CHECK (theme_alignment >= 0 AND theme_alignment <= 1),
    CONSTRAINT pr_materials_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT pr_materials_one_per_type UNIQUE (kit_id, type)
);

CREATE INDEX IF NOT EXISTS pr_materials_kit_idx ON pr_materials (kit_id);
CREATE INDEX IF NOT EXISTS pr_materials_status_idx ON pr_materials (status);

-- Stand-in media list. beats are matched against the book's themes so a kit
-- goes to the reporters who plausibly cover it.
CREATE TABLE IF NOT EXISTS press_contacts (
    id         BIGSERIAL PRIMARY KEY,
    outlet     TEXT   NOT NULL,
    name       TEXT   NOT NULL,
    email      TEXT   NOT NULL UNIQUE,
    beats      TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pr_distributions (
    id          BIGSERIAL PRIMARY KEY,
    kit_id      BIGINT      NOT NULL REFERENCES pr_kits(id) ON DELETE CASCADE,
    author_id   BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    contact_id  BIGINT      REFERENCES press_contacts(id) ON DELETE SET NULL,
    recipient   TEXT        NOT NULL,
    outlet      TEXT        NOT NULL DEFAULT '',
    status      TEXT        NOT NULL DEFAULT 'queued',
    external_id TEXT,
    sent_at     TIMESTAMPTZ,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pr_distributions_status_check CHECK (status IN ('queued', 'sent', 'failed')),
    -- One send per outlet per kit; a repeated distribute must not re-mail press.
    CONSTRAINT pr_distributions_one_per_recipient UNIQUE (kit_id, recipient)
);

CREATE INDEX IF NOT EXISTS pr_distributions_kit_idx ON pr_distributions (kit_id);

-- Third approval target. The nullable-FK-plus-exactly-one pattern from
-- migration 002 extends by one column and one name in the check, which is the
-- whole reason it was chosen over a polymorphic entity_id.
ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS pr_material_id BIGINT REFERENCES pr_materials(id) ON DELETE CASCADE;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_target;
ALTER TABLE approvals
    ADD CONSTRAINT approvals_exactly_one_target
    CHECK (num_nonnulls(draft_id, outreach_message_id, pr_material_id) = 1);

CREATE INDEX IF NOT EXISTS approvals_pr_material_idx ON approvals (pr_material_id);

COMMIT;
