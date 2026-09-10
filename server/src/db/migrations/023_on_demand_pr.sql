-- STORY-018 / REQ-011 + REQ-004 — the AI Content Generation Agent generates PR
-- materials on request, in the author's measured voice
--
-- Two gaps, both in the acceptance criterion.
--
-- "When PR material generation is requested" — it could not be. Press materials
-- existed only as a byproduct of a milestone: `draftPressKit` took a milestone
-- id and nothing else, and `milestone_id` was NOT NULL. A publicist promoting a
-- book with no launch, anniversary or award in the calendar had no path at all,
-- which is most of a book's life. So a kit gets an occasion instead of always
-- getting a milestone, and "no occasion but the book itself" becomes one of the
-- occasions rather than a missing row.
--
-- "and author's voice" — press copy was never measured against it. `assess()`
-- was called without `voice`, so MIN_VOICE_MATCH could not gate a press
-- material; the only voice number was a word-overlap worth 0.15 of confidence
-- that gated nothing. That is the same finding STORY-009 made about social
-- posts, at the other end of the pipeline, and it gets the same answer:
-- measure, store the verdict, and let the floor act on it. The columns mirror
-- drafts.voice_score / drafts.voice_violations deliberately — one shape for one
-- question, so a reviewer reading a press release and a reviewer reading a post
-- are reading the same number.

BEGIN;

-- A kit without a milestone. Nullable rather than a sentinel milestone row:
-- inventing a "milestone" with no date to hang an on-demand kit off would put a
-- fiction in the table the schedule reads from.
ALTER TABLE pr_kits ALTER COLUMN milestone_id DROP NOT NULL;

ALTER TABLE pr_kits
    ADD COLUMN IF NOT EXISTS occasion     TEXT NOT NULL DEFAULT 'milestone',
    ADD COLUMN IF NOT EXISTS angle        TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS requested_by TEXT;

-- Every existing kit was drafted for a milestone, so the default is already the
-- truth for every row and there is nothing to backfill.
ALTER TABLE pr_kits
    DROP CONSTRAINT IF EXISTS pr_kits_occasion_values;
ALTER TABLE pr_kits
    ADD CONSTRAINT pr_kits_occasion_values
    CHECK (occasion IN ('milestone', 'on_demand'));

-- The two halves cannot disagree. Without this an on-demand kit could carry a
-- milestone id, and every query that decides how to label a kit would have two
-- answers to choose between.
ALTER TABLE pr_kits
    DROP CONSTRAINT IF EXISTS pr_kits_occasion_matches_milestone;
ALTER TABLE pr_kits
    ADD CONSTRAINT pr_kits_occasion_matches_milestone
    CHECK ((occasion = 'on_demand') = (milestone_id IS NULL));

-- `pr_kits_one_drafting_per_milestone` (005) is ON (milestone_id) WHERE
-- status = 'drafting'. Postgres treats NULLs as distinct in a unique index, so
-- the moment milestone_id became nullable that index stopped constraining
-- on-demand kits — it does not weaken, it simply does not apply. The on-demand
-- equivalent of "one kit in progress" is per book, because the book is what the
-- kit is about when there is no milestone.
CREATE UNIQUE INDEX IF NOT EXISTS pr_kits_one_drafting_on_demand_per_book
    ON pr_kits (book_id) WHERE status = 'drafting' AND milestone_id IS NULL;

-- The voice verdict, on the material rather than only in the log, for the same
-- reason theme_alignment is: a floor nothing was measured against is not a
-- floor, and a reviewer deciding on a release needs to see the number that
-- escalated it.
ALTER TABLE pr_materials
    ADD COLUMN IF NOT EXISTS voice_score      NUMERIC(4,3),
    ADD COLUMN IF NOT EXISTS voice_violations TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE pr_materials
    DROP CONSTRAINT IF EXISTS pr_materials_voice_score_range;
ALTER TABLE pr_materials
    ADD CONSTRAINT pr_materials_voice_score_range
    CHECK (voice_score IS NULL OR (voice_score >= 0 AND voice_score <= 1));

-- Materials written before this story have no voice verdict and will never get
-- one — backfilling a score nothing measured would be inventing evidence. The
-- governance check reads this watermark so those rows are reported as history
-- rather than as a standing failure.
CREATE TABLE IF NOT EXISTS pr_voice_watermark (
    id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    material_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO pr_voice_watermark (id, material_id)
VALUES (1, COALESCE((SELECT MAX(id) FROM pr_materials), 0))
ON CONFLICT (id) DO NOTHING;

COMMIT;
