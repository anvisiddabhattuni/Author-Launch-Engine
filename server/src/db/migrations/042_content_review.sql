-- STORY-047 / REQ-012 — reviewing drafts against the book
--
-- Measured before this story: a draft was scored against the book's themes
-- (STORY-006/009) and against the author's *social posts* for voice
-- (STORY-007) — never against the book's own style, the "stylistic elements
-- extracted from the book" the story names. And a reviewer had two buttons,
-- approve and reject: a draft that was nearly right could only be thrown away.
--
-- Now each draft is compared with the book when it is ready for review — its
-- themes in the book's own words (STORY-046's model) and its style against the
-- book's — the comparison is kept, and a reviewer can request changes: the
-- draft is set aside with the reviewer's note and a revision, linked to it,
-- comes back through the same review and the same approval gate.

BEGIN;

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_status_check
    CHECK (status IN ('pending_approval', 'escalated', 'approved', 'rejected', 'scheduled', 'changes_requested'));

ALTER TABLE drafts ADD COLUMN IF NOT EXISTS revision_of BIGINT REFERENCES drafts(id);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS change_request TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS changes_requested_by TEXT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS changes_requested_at TIMESTAMPTZ;
-- A request for changes says what to change.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_change_request_explained;
ALTER TABLE drafts ADD CONSTRAINT drafts_change_request_explained
    CHECK (status <> 'changes_requested' OR (length(trim(coalesce(change_request, ''))) >= 10 AND changes_requested_by IS NOT NULL));
CREATE INDEX IF NOT EXISTS drafts_revision_of_idx ON drafts (revision_of) WHERE revision_of IS NOT NULL;

-- One comparison per draft. A draft's text never changes — a revision is a
-- new draft with its own — so neither does its comparison.
CREATE TABLE IF NOT EXISTS content_reviews (
    id            BIGSERIAL   PRIMARY KEY,
    draft_id      BIGINT      NOT NULL UNIQUE REFERENCES drafts(id) ON DELETE CASCADE,
    author_id     BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id       BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    model_version INT,
    verdict       TEXT        NOT NULL CHECK (verdict IN ('aligned', 'check', 'misaligned')),
    comparison    JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON content_reviews TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE content_reviews_id_seq TO ale_app;

COMMIT;
