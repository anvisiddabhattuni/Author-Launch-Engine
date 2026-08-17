-- STORY-005 / REQ-003 — draft PR materials for book awards
--
-- STORY-003 could already draft for an award milestone, but only ever as a
-- *shortlisting*: the copy said "has been shortlisted" whatever had happened, and
-- the prize name was scraped out of the milestone title with a regex. STORY-005's
-- criterion is "given a book has won an award", which the schema could not even
-- represent. Two things become data here: the outcome, and the prize.

BEGIN;

-- The prize itself. It used to be recovered from the title with
-- `replace(/^.*shortlisted for (the )?/i, '')`, which produced a mangled
-- headline the moment a title was phrased any other way.
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS award_name TEXT;

-- What actually happened. Only an award has an outcome, and NULL reads as
-- 'shortlisted': putting an award on the calendar is itself the news that the
-- book is in the running. Whether it won is a separate fact a human records.
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS outcome TEXT;

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_outcome_values;
ALTER TABLE milestones ADD CONSTRAINT milestones_outcome_values
    CHECK (outcome IS NULL OR outcome IN ('shortlisted', 'won', 'not_won'));

ALTER TABLE milestones DROP CONSTRAINT IF EXISTS milestones_outcome_only_awards;
ALTER TABLE milestones ADD CONSTRAINT milestones_outcome_only_awards
    CHECK (outcome IS NULL OR type = 'award');

COMMENT ON COLUMN milestones.outcome IS
    'Awards only: shortlisted (default when null), won, or not_won. A win is the '
    'only outcome that changes the announcement; not_won produces no material.';

-- One-time rescue of data that was living inside prose. NULLIF collapses the
-- no-match case, where regexp_replace returns the whole title unchanged.
UPDATE milestones
   SET award_name = NULLIF(regexp_replace(title, '^.*shortlisted for (the )?', '', 'i'), title)
 WHERE type = 'award' AND award_name IS NULL;

UPDATE milestones SET outcome = 'shortlisted' WHERE type = 'award' AND outcome IS NULL;

-- A shortlist release and a win release are two announcements about one award,
-- and a real author gets both. `pr_kits_one_per_milestone` made the second
-- impossible, so it is replaced by a narrower rule: at most one kit per
-- milestone may be *in progress*. A distributed kit is history and a superseded
-- one is a withdrawn draft; neither should block the next announcement.
ALTER TABLE pr_kits DROP CONSTRAINT IF EXISTS pr_kits_status_check;
ALTER TABLE pr_kits ADD CONSTRAINT pr_kits_status_check
    CHECK (status IN ('drafting', 'distributed', 'superseded'));

ALTER TABLE pr_kits DROP CONSTRAINT IF EXISTS pr_kits_one_per_milestone;
CREATE UNIQUE INDEX IF NOT EXISTS pr_kits_one_drafting_per_milestone
    ON pr_kits (milestone_id) WHERE status = 'drafting';

-- Superseded copy is kept rather than deleted: it is what the agent proposed at
-- the time, and the audit log references it.
ALTER TABLE pr_kits ADD COLUMN IF NOT EXISTS superseded_by BIGINT
    REFERENCES pr_kits(id) ON DELETE SET NULL;
ALTER TABLE pr_kits ADD COLUMN IF NOT EXISTS superseded_reason TEXT;

COMMIT;
