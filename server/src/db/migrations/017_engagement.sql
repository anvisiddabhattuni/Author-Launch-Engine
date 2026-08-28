-- STORY-069 / REQ-001 — does a meme actually outperform a text post?
--
-- The last of the four meme stories, and the one that closes the loop on the
-- reason the other three exist. Ram's note was "on platforms like X, memes might
-- get more traction than text". STORY-066 made memes, 067 gave them a library,
-- 068 gave them a look, and not one of them can say whether the premise holds.
--
-- The honest shape of this story is a dashboard that usually answers "not yet".
-- Its trust clause says the view "refuses to imply significance it does not
-- have", which is the whole design: it would be trivial to divide two averages
-- and print a winner, and that number would be noise at every sample size this
-- system will realistically have for months.
--
-- Engagement here is mocked, and the mock is deliberately format-blind. A
-- generator quietly tuned to make memes win would turn the demo into a claim
-- about the world rather than a demonstration of the apparatus.

BEGIN;

-- Carried onto the published record rather than joined from the draft.
-- Engagement is about what actually went out: if a draft were edited later, the
-- format the post was published as should not move with it.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'text';
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_format_check;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_format_check
    CHECK (format IN ('text', 'meme'));

-- One row per published post, refreshed on each collection run.
--
-- A snapshot rather than a time series: the comparison needs one consistent
-- reading per post, and keeping every reading would invite comparing a
-- three-week-old text post against a meme collected an hour after publishing —
-- which is the methodological trap this story is most likely to fall into.
CREATE TABLE IF NOT EXISTS engagement (
    id                 BIGSERIAL PRIMARY KEY,
    scheduled_post_id  BIGINT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
    draft_id           BIGINT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    author_id          BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,

    -- Tagged on the metric itself, as the story's first clause asks. Denormalised
    -- on purpose: this table is read by an aggregate that must not have to join
    -- two levels to know what it is counting.
    platform           TEXT   NOT NULL,
    format             TEXT   NOT NULL,

    published_at       TIMESTAMPTZ NOT NULL,
    collected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- How long the post had been live when this reading was taken. The comparison
    -- excludes posts too young to have settled, and cannot do that without it.
    hours_live         NUMERIC(8,2) NOT NULL,
    collections        INT    NOT NULL DEFAULT 1,

    impressions        INT    NOT NULL,
    likes              INT    NOT NULL DEFAULT 0,
    shares             INT    NOT NULL DEFAULT 0,
    comments           INT    NOT NULL DEFAULT 0,
    -- (likes + shares + comments) / impressions. Stored rather than derived so
    -- the aggregate is one scan and the arithmetic is inspectable per row.
    engagement_rate    NUMERIC(8,6) NOT NULL,

    CONSTRAINT engagement_one_per_post UNIQUE (scheduled_post_id),
    CONSTRAINT engagement_format_check CHECK (format IN ('text', 'meme')),
    CONSTRAINT engagement_impressions_positive CHECK (impressions > 0)
);

CREATE INDEX IF NOT EXISTS engagement_compare_idx
    ON engagement (author_id, platform, format);

-- A proposal, not a change.
--
-- The story's third clause is that a recommendation "never silently changes what
-- gets published". Making it a row with a status is what makes that testable:
-- an unapproved recommendation is a suggestion sitting in a table, and the
-- drafter never reads it.
CREATE TABLE IF NOT EXISTS mix_recommendations (
    id              BIGSERIAL PRIMARY KEY,
    author_id       BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    platform        TEXT   NOT NULL,
    -- What the evidence favours, and what acting on it would mean.
    favours         TEXT   NOT NULL,
    current_memes   INT    NOT NULL,
    suggested_memes INT    NOT NULL,
    -- The numbers behind it, frozen at the moment it was made. A recommendation
    -- read next month has to be answerable from itself: re-deriving the evidence
    -- against data that has since moved would explain a different decision.
    evidence        JSONB  NOT NULL DEFAULT '{}',
    status          TEXT   NOT NULL DEFAULT 'pending_approval',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mix_recommendations_status_check CHECK (
        status IN ('pending_approval', 'approved', 'rejected', 'superseded')
    ),
    CONSTRAINT mix_recommendations_favours_check CHECK (favours IN ('meme', 'text')),
    CONSTRAINT mix_recommendations_suggestion_sane CHECK (suggested_memes >= 0)
);

-- One open proposal per platform. Two live suggestions for the same platform is
-- not a state a reviewer could act on coherently.
CREATE UNIQUE INDEX IF NOT EXISTS mix_recommendations_one_open
    ON mix_recommendations (author_id, platform) WHERE status = 'pending_approval';

-- The fourth thing a human approves, added the way the other three were.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS mix_recommendation_id BIGINT
    REFERENCES mix_recommendations(id) ON DELETE CASCADE;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_exactly_one_target;
ALTER TABLE approvals ADD CONSTRAINT approvals_exactly_one_target CHECK (
    num_nonnulls(draft_id, outreach_message_id, pr_material_id, mix_recommendation_id) = 1
);

-- What an approved recommendation actually moves.
--
-- Without this the approval would be ceremonial: the point of the third clause
-- is that approving changes the mix and not approving changes nothing, and that
-- is only testable if there is something for it to change.
ALTER TABLE authors ADD COLUMN IF NOT EXISTS memes_per_batch INT;

COMMENT ON COLUMN engagement.hours_live IS
    'Age of the post at collection. The comparison drops posts younger than the '
    'maturity window, because a meme measured an hour after publishing against a '
    'three-week-old text post is not a comparison.';

COMMENT ON TABLE mix_recommendations IS
    'Advisory. The drafting agent reads authors.memes_per_batch, which only an '
    'approved recommendation changes — an unapproved one sits here and does '
    'nothing.';

COMMIT;
