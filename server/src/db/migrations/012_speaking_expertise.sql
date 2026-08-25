-- STORY-010 / REQ-002 + REQ-004 — the PR and Outreach Agent identifies speaking
-- opportunities that fit the book's themes *and the author's expertise*
--
-- STORY-002 already scanned the directories, so this story is the clause it did
-- not honour. Relevance was scored against one thing: whether a listing's
-- topics repeated one of the four theme labels on the book being promoted.
-- Nothing anywhere in the system modelled the author.
--
-- The cost was a real lead, silently. "Library Author Nights — evening talks
-- where authors discuss their books with local reading groups" scores exactly
-- 0.000 against 'deep work, craft, attention, resilience' and is discarded. It
-- is an ideal speaking slot for an author; it simply never repeats a theme. The
-- listing does not want a lecture on attention, it wants an author — and until
-- now the system had no way to represent that an author is what we have.
--
-- Two things become data here: how well a listing fits the author as opposed to
-- the book, and which listings the filter hid.

BEGIN;

-- Fit against the author rather than the book. Kept as its own column beside
-- `relevance` rather than blended into it, because they are different reasons
-- to say yes and a reviewer deciding on a lead needs to know which one applies:
-- "this event is about your subject" and "this event wants someone like you"
-- call for different pitches.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS expertise NUMERIC(4,3) NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS expertise_matched TEXT[] NOT NULL DEFAULT '{}';
-- Which test the lead actually passed: themes, expertise, or both. A queryable
-- answer to "why is this in my queue", and the only way to see that a whole
-- category of lead arrives on one basis alone.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS qualified_by TEXT NOT NULL DEFAULT 'themes';
-- One sortable number so a queue can be ranked without the UI re-deriving it.
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS fit NUMERIC(4,3) NOT NULL DEFAULT 0;

ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_expertise_range;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_expertise_range
    CHECK (expertise >= 0 AND expertise <= 1);
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_fit_range;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_fit_range
    CHECK (fit >= 0 AND fit <= 1);
ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_qualified_by_check;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_qualified_by_check
    CHECK (qualified_by IN ('themes', 'expertise', 'both'));

-- What the filter hid.
--
-- STORY-002 counted rejections and threw the listings away — the audit log said
-- "rejected 5" and nothing else. That is the one part of the scan nobody can
-- check: an identified opportunity is visible and can be judged wrong, but a
-- lead the filter dropped for a bad reason leaves no trace to notice. Library
-- Author Nights was invisible for four stories.
--
-- Keyed on the listing rather than the scan, so a re-scan updates the verdict
-- instead of accumulating a row per month per listing.
CREATE TABLE IF NOT EXISTS opportunity_rejections (
    id            BIGSERIAL PRIMARY KEY,
    author_id     BIGINT  NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    source        TEXT    NOT NULL,
    external_id   TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    url           TEXT    NOT NULL DEFAULT '',
    topics        TEXT[]  NOT NULL DEFAULT '{}',
    relevance     NUMERIC(4,3) NOT NULL,
    expertise     NUMERIC(4,3) NOT NULL DEFAULT 0,
    -- Both floors it failed to clear, stored so the decision can be re-derived
    -- later against a policy that has since changed — the same property
    -- STORY-008 needed to re-judge press materials.
    relevance_floor NUMERIC(4,3) NOT NULL,
    expertise_floor NUMERIC(4,3) NOT NULL,
    rationale     TEXT    NOT NULL DEFAULT '',
    last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT opportunity_rejections_one_per_listing UNIQUE (author_id, source, external_id)
);

CREATE INDEX IF NOT EXISTS opportunity_rejections_author_idx
    ON opportunity_rejections (author_id, relevance DESC);

COMMIT;
