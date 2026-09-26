-- STORY-029 / REQ-007 — content performance is tracked, not sampled
--
-- STORY-069 built engagement collection and one analysis over it: does a meme
-- outperform a text post. This story's clause is wider — "metrics are tracked
-- and displayed", then "analysed" for "insights on content effectiveness" —
-- and measured against it, what exists is thinner than it looks:
--
--   * Collection runs when a human presses a button. Zero recurring sweeps; two
--     collections ever, both from the demo. "Tracked" means on a timer.
--   * One reading per post, overwritten on each collection. There is no
--     history, so "how did this post do over its first three days" and "is it
--     still earning or has it stalled" are unanswerable — a post that stopped
--     at 200 impressions and one still climbing look identical.
--   * Exactly one question is asked of the data. Nothing asks whether the
--     system's own scores predict engagement, whether the scheduler's "optimal
--     windows" (STORY-001) pay off, or which platform works — three premises
--     this product acts on every week and has never checked.
--
-- So: a time series beside the snapshot, a sweep that fills it, and a module
-- that asks several questions of it — each in the STORY-069 shape, stating its
-- sample and declining to conclude below it.

BEGIN;

-- The history. One row per post per collection, never updated.
--
-- `engagement` stays as it was: the latest reading per post, which is what the
-- format comparison needs (one consistent reading each) and what the mix
-- recommender freezes as evidence. This table is what the snapshot forgets.
CREATE TABLE IF NOT EXISTS content_metrics (
    id                 BIGSERIAL PRIMARY KEY,
    scheduled_post_id  BIGINT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
    draft_id           BIGINT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    author_id          BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    platform           TEXT   NOT NULL,
    format             TEXT   NOT NULL,
    collected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    hours_live         NUMERIC(8,2) NOT NULL,
    impressions        INT    NOT NULL,
    likes              INT    NOT NULL DEFAULT 0,
    shares             INT    NOT NULL DEFAULT 0,
    comments           INT    NOT NULL DEFAULT 0,
    engagement_rate    NUMERIC(8,6) NOT NULL,
    -- Where the numbers came from. Every row today says 'mock', and a reader
    -- of a chart is entitled to that fact beside the chart rather than in a
    -- README. The day a platform adapter is real, its rows say so too.
    source             TEXT   NOT NULL DEFAULT 'mock',
    CONSTRAINT content_metrics_format_check CHECK (format IN ('text', 'meme')),
    CONSTRAINT content_metrics_impressions_positive CHECK (impressions > 0),
    CONSTRAINT content_metrics_source_check CHECK (source IN ('mock', 'platform', 'backfill'))
);

CREATE INDEX IF NOT EXISTS content_metrics_post_idx
    ON content_metrics (scheduled_post_id, collected_at);
CREATE INDEX IF NOT EXISTS content_metrics_author_idx
    ON content_metrics (author_id, collected_at DESC);

-- The one reading each existing post has becomes the first point of its
-- series. Marked as a backfill: it is a genuine reading, taken at the time
-- `engagement` says, but the series before it is lost and a chart should not
-- pretend otherwise.
INSERT INTO content_metrics
    (scheduled_post_id, draft_id, author_id, platform, format, collected_at, hours_live,
     impressions, likes, shares, comments, engagement_rate, source)
SELECT scheduled_post_id, draft_id, author_id, platform, format, collected_at, hours_live,
       impressions, likes, shares, comments, engagement_rate, 'backfill'
  FROM engagement e
 WHERE NOT EXISTS (SELECT 1 FROM content_metrics cm WHERE cm.scheduled_post_id = e.scheduled_post_id);

COMMENT ON TABLE content_metrics IS
    'Every engagement reading ever taken, one row per post per collection. The '
    'engagement table is the latest of these per post; this is the history.';

COMMIT;
