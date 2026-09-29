-- STORY-048 / REQ-012 — a feedback loop from reviewers to generation
--
-- Measured before this story: every reviewer decision was recorded (approvals,
-- STORY-005; changes requested, STORY-047) and nothing learned from any of
-- them. A passage reviewers turned down on Monday was quoted again on Tuesday.
-- The one adaptation that existed — the meme/text mix (STORY-069) — learns
-- from engagement numbers, not from what reviewers said.
--
-- Now reviewers can rate a draft and say why, their decisions count as
-- feedback too, and the book's model (STORY-046) is refitted with it:
-- per-passage and per-theme preferences, bounded, needing two judgments before
-- they move anything, versioned, and on the audit log with what changed.

BEGIN;

CREATE TABLE IF NOT EXISTS content_feedback (
    id          BIGSERIAL   PRIMARY KEY,
    draft_id    BIGINT      NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    author_id   BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id     BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    rating      INT         CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT,
    given_by    TEXT        NOT NULL,
    user_id     BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT content_feedback_says_something CHECK (rating IS NOT NULL OR length(trim(coalesce(comment, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS content_feedback_book_idx ON content_feedback (book_id, created_at DESC);

GRANT SELECT, INSERT ON content_feedback TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE content_feedback_id_seq TO ale_app;

ALTER TABLE book_models DROP CONSTRAINT IF EXISTS book_models_trigger_check;
ALTER TABLE book_models ADD CONSTRAINT book_models_trigger_check
    CHECK (trigger IN ('book_uploaded', 'material_added', 'inputs_changed', 'first_draft', 'manual', 'feedback'));

COMMIT;
