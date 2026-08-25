-- STORY-009 / REQ-001 + REQ-004 — the Content Drafting Agent drafts from the
-- book's themes and the author's previous posts
--
-- STORY-001 already gave the agent both inputs. It passed them to the provider,
-- which ignored them, and then graded itself on how well it had used them. The
-- grade could not fail: "grounding" asked whether a theme *label* appeared, and
-- "voice" measured vocabulary overlap with the author's prior posts, which any
-- text about the same book shares. Copy doing everything the author's own voice
-- profile says to avoid — exclamation marks, growth-hacking language, hype —
-- scored 0.994 and queued as the best draft in the system.
--
-- This is STORY-006's finding at the other end of the pipeline, so it gets
-- STORY-006's answer: retrieve before drafting, and verify against the same
-- evidence afterwards. Three things become data here — which themes a post
-- carried and how, how close it sits to how the author actually writes, and
-- what the drafter was given before it wrote.

BEGIN;

-- Per-draft, per-theme verdicts. The mirror of pr_material_themes: the single
-- theme_alignment number says a post is 0.62 aligned, this says *which* theme
-- it name-checked and failed to argue — the only form of the finding a reviewer
-- can act on.
CREATE TABLE IF NOT EXISTS draft_themes (
    id            BIGSERIAL PRIMARY KEY,
    draft_id      BIGINT  NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    theme         TEXT    NOT NULL,
    key_message   TEXT    NOT NULL DEFAULT '',
    named         BOOLEAN NOT NULL,
    message_score NUMERIC(4,3) NOT NULL,
    score         NUMERIC(4,3) NOT NULL,
    -- A theme the post claimed that the book does not claim. Kept as a flag
    -- rather than dropped: a post inventing a theme for the book is a finding,
    -- and silently discarding the claim would hide it.
    known         BOOLEAN NOT NULL DEFAULT TRUE,
    passage_ids   BIGINT[] NOT NULL DEFAULT '{}',
    carried_terms TEXT[]   NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT draft_themes_one_per_theme UNIQUE (draft_id, theme),
    CONSTRAINT draft_themes_score_range CHECK (score >= 0 AND score <= 1),
    CONSTRAINT draft_themes_message_range CHECK (message_score >= 0 AND message_score <= 1)
);

CREATE INDEX IF NOT EXISTS draft_themes_draft_idx ON draft_themes (draft_id);

-- The two scores that now have to clear a floor of their own, stored beside the
-- blended confidence rather than buried in it. REQ-001's criterion is about the
-- book's themes and the author's voice specifically, so a post that fails
-- either one cannot pass on the strength of the other (the same reason
-- pr_materials.theme_alignment is its own column since STORY-003).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS theme_alignment NUMERIC(4,3) NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS voice_score NUMERIC(4,3) NOT NULL DEFAULT 0;
-- Which derived traits the draft broke, e.g. {exclamations,sentence_length}.
-- Named traits rather than a sentence, so the escalation reason is queryable.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS voice_violations TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_theme_alignment_range;
ALTER TABLE drafts ADD CONSTRAINT drafts_theme_alignment_range
    CHECK (theme_alignment >= 0 AND theme_alignment <= 1);
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_voice_score_range;
ALTER TABLE drafts ADD CONSTRAINT drafts_voice_score_range
    CHECK (voice_score >= 0 AND voice_score <= 1);

-- What retrieval handed the drafter, so "this post was grounded" is a readable
-- fact on the row and not only a line in the audit log (as pr_kits carries).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS grounded_passages INT NOT NULL DEFAULT 0;

COMMIT;
