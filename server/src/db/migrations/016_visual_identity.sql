-- STORY-068 / REQ-001 — a running visual identity for the book
--
-- STORY-067 gave every template a licence and a slot structure, and nothing
-- more. Reading the library back afterwards is what made the gap concrete:
-- eight licensed templates carrying five different accent colours — blue,
-- green, amber, purple, red — and one of them light while the rest are dark.
-- Every one is legal, on-message and reusable. Together they are a feed rather
-- than a book.
--
-- The identity is versioned rather than edited in place, and that is the whole
-- reason this is a table and not four columns on `books`. The story's third
-- clause asks that an author's revision apply to *later* memes; the corollary
-- nobody states is that it must not silently reinterpret earlier ones. A meme
-- drafted last week was judged against the rules in force last week, and a post
-- that has already gone out has to keep pointing at the version it was made to
-- satisfy — the same reason STORY-067 retires templates instead of deleting.

BEGIN;

-- Cover art, if the author supplied any. Nullable and expected to be null:
-- "any supplied cover art" is the story's own hedge, and an identity derived
-- with no cover has to say so rather than inventing a palette and presenting it
-- with the same confidence.
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_art TEXT;

CREATE TABLE IF NOT EXISTS visual_identity (
    id           BIGSERIAL PRIMARY KEY,
    author_id    BIGINT NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    book_id      BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    version      INT    NOT NULL,

    -- { "ink": "#f4f6f8", "ground": "#0d1117", "accent": "#4a9eff",
    --   "mode": "dark", "tolerance": 40 }
    -- `tolerance` is the perceptual distance an accent may drift before it
    -- counts as a different colour, stored with the guide because it is part of
    -- what the author agreed to rather than a constant in our code.
    palette      JSONB  NOT NULL,

    -- { "family": "Georgia, serif", "case": "sentence", "why": "..." }
    typography   JSONB  NOT NULL DEFAULT '{}',

    -- What the identity sounds like, and what it must not do. `do_not_use` is
    -- the half with teeth: tone words describe, rules refuse.
    tone_words   TEXT[] NOT NULL DEFAULT '{}',
    do_not_use   TEXT[] NOT NULL DEFAULT '{}',

    -- What this version was derived from, or that a human wrote it. An identity
    -- inferred from four theme labels and no cover is a guess worth revising,
    -- and the guide should say which it is rather than presenting both the same
    -- way (the rule STORY-009 applied to a voice profile nobody had evidence for).
    derived_from JSONB  NOT NULL DEFAULT '{}',

    active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   TEXT   NOT NULL DEFAULT 'system',
    note         TEXT   NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT visual_identity_one_per_version UNIQUE (book_id, version),
    CONSTRAINT visual_identity_version_positive CHECK (version > 0)
);

-- Exactly one active version per book, enforced by the database rather than by
-- whichever code path happens to write next. Two active guides is not a state
-- anything downstream could resolve: "the rules in force" would have no answer.
CREATE UNIQUE INDEX IF NOT EXISTS visual_identity_one_active
    ON visual_identity (book_id) WHERE active;

CREATE INDEX IF NOT EXISTS visual_identity_book_idx ON visual_identity (book_id, version DESC);

-- Which version a draft was judged against, and how it scored.
--
-- The version is stored, not looked up later: a meme approved under v1 and
-- published under v3 was still a v1 decision, and re-deriving it against
-- whatever is active now would rewrite the reason a human said yes.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS identity_version INT;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS identity_score NUMERIC(4,3);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS identity_findings TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_identity_score_range;
ALTER TABLE drafts ADD CONSTRAINT drafts_identity_score_range
    CHECK (identity_score IS NULL OR (identity_score >= 0 AND identity_score <= 1));

COMMENT ON TABLE visual_identity IS
    'Versioned per book. A revision creates a new version and deactivates the '
    'previous one; earlier drafts keep pointing at the version they were judged '
    'against, so an edit changes later memes and never reinterprets earlier ones.';

COMMIT;
