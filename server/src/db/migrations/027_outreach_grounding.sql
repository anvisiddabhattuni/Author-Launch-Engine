-- STORY-023 / REQ-006 — the third content type gets the treatment the other two
-- already had
--
-- The story asks the AI Content Generation Agent to draft "social media posts,
-- outreach messages, and PR materials" aligned with the book's themes and the
-- author's voice. Two of those three were already there:
--
--   social posts   retrieved themes (STORY-009) + measured voice (STORY-009)
--   PR materials   retrieved themes (STORY-006) + measured voice (STORY-018)
--   outreach       neither
--
-- Outreach still runs the scoring both of the others replaced. It has a number
-- called "grounding" and a number called "voice", which is what made it look
-- done, and both are the pre-STORY-006 versions:
--
--   `groundingScore` counts a theme as hit if ANY SINGLE WORD of it appears
--   anywhere in the text. The theme "deep work" is satisfied by the word "work"
--   — including in "I would love to work with you". It then floors at 0.55 for
--   a single hit, so one accidental preposition-adjacent match scores 0.66.
--
--   `voiceScore` is vocabulary overlap with prior posts: 0.4 + overlap * 1.5.
--   This is the exact function 011_social_grounding.sql describes scoring 0.994
--   on copy that broke every rule the author's own voice profile states.
--
-- Neither is a floor. `assess({ confidence })` is called with no themeAlignment
-- and no voice, so neither number can escalate anything; they are blended into
-- one confidence score and outvoted by personalisation.
--
-- Measured before writing this. A pitch reading "Hi Dana! I would absolutely
-- LOVE to work with The Focus Podcast in London!!! This is an incredible,
-- game-changing, guaranteed-viral opportunity you simply cannot miss." scores
-- confidence 0.79 and queues for ordinary approval. Its grounding of 0.66 comes
-- entirely from the word "work". The real voice check scores the same text
-- 0.16, with violations on exclamations, hype, shouting and vocabulary.
--
-- This is the channel that emails a named stranger at a podcast with the
-- author's name on it, and it was the least checked of the three.

BEGIN;

-- The verdicts, stored rather than blended away. Same columns as `drafts` and
-- `pr_materials` carry, because it is the same question asked of the same kind
-- of thing, and a reviewer moving between the three screens should not have to
-- learn three vocabularies.
ALTER TABLE outreach_messages
    ADD COLUMN IF NOT EXISTS theme_alignment  NUMERIC(4,3),
    ADD COLUMN IF NOT EXISTS voice_score      NUMERIC(4,3),
    ADD COLUMN IF NOT EXISTS voice_violations TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS themes_used      TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS grounded_passages INT NOT NULL DEFAULT 0;

ALTER TABLE outreach_messages
    DROP CONSTRAINT IF EXISTS outreach_messages_theme_alignment_range;
ALTER TABLE outreach_messages
    ADD CONSTRAINT outreach_messages_theme_alignment_range
    CHECK (theme_alignment IS NULL OR (theme_alignment >= 0 AND theme_alignment <= 1));

ALTER TABLE outreach_messages
    DROP CONSTRAINT IF EXISTS outreach_messages_voice_score_range;
ALTER TABLE outreach_messages
    ADD CONSTRAINT outreach_messages_voice_score_range
    CHECK (voice_score IS NULL OR (voice_score >= 0 AND voice_score <= 1));

-- Per-theme evidence, the third mirror of the same table. `draft_themes` (011)
-- and `pr_material_themes` (006) exist for the reason this one does: the single
-- alignment number says a pitch is 0.62 aligned, and these say *which* theme it
-- named and failed to argue — the only form of the finding a reviewer can act
-- on.
CREATE TABLE IF NOT EXISTS outreach_message_themes (
    id            BIGSERIAL PRIMARY KEY,
    message_id    BIGINT  NOT NULL REFERENCES outreach_messages(id) ON DELETE CASCADE,
    theme         TEXT    NOT NULL,
    key_message   TEXT    NOT NULL DEFAULT '',
    named         BOOLEAN NOT NULL,
    message_score NUMERIC(4,3) NOT NULL,
    score         NUMERIC(4,3) NOT NULL,
    passage_ids   BIGINT[] NOT NULL DEFAULT '{}',
    carried_terms TEXT[]   NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT outreach_message_themes_one_per_message UNIQUE (message_id, theme),
    CONSTRAINT outreach_message_themes_message_score_range
        CHECK (message_score >= 0 AND message_score <= 1),
    CONSTRAINT outreach_message_themes_score_range
        CHECK (score >= 0 AND score <= 1)
);

CREATE INDEX IF NOT EXISTS outreach_message_themes_message_idx
    ON outreach_message_themes (message_id);

-- Messages drafted before this story were never scored this way and are not
-- backfilled — a score nothing measured would be inventing the evidence. Same
-- watermark treatment 023 gave press voice scores, and for the same reason: a
-- governance check that can never be cleared is one people learn to scroll past.
CREATE TABLE IF NOT EXISTS outreach_grounding_watermark (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    message_id  BIGINT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO outreach_grounding_watermark (id, message_id)
VALUES (1, COALESCE((SELECT MAX(id) FROM outreach_messages), 0))
ON CONFLICT (id) DO NOTHING;

COMMIT;
