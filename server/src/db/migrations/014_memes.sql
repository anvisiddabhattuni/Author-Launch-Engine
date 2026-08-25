-- STORY-066 / REQ-001 — memes as a content format alongside text posts
--
-- Added after Ram's review of the backlog: "On platforms like X, memes might get
-- more traction than text." Scoped against the existing REQ-001 rather than
-- opening a new requirement, so the traceability matrix stays intact.
--
-- A meme is a `drafts` row with a different format, not a table of its own.
-- That is the whole design decision. Everything a text post already gets — the
-- approval gate in `scheduleDraft`, the append-only audit trail, escalation,
-- the weekly cadence count, the STORY-011 coordination resource — applies to a
-- meme with no second copy of any of it. A `memes` table would have needed its
-- own gate, and a second gate is a gate with a hole in it.
--
-- The story's second acceptance clause is "identical to the gate on text
-- posts". The cheapest way to be identical to something is to be it.

BEGIN;

-- 'text' or 'meme'. Defaulted so every row that predates this story is a text
-- post, which is what they are.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'text';
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_format_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_format_check CHECK (format IN ('text', 'meme'));

-- The image half of the unit. `content` stays the caption, so every existing
-- reader — the scheduler's length check, the voice scorer, the theme
-- alignment — keeps working on a meme without knowing it is one.
--
-- JSONB rather than columns because provenance shape varies by source: a
-- template carries an id and a licence, a generated image carries a model and a
-- prompt, and a future stock provider would carry neither.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS media JSONB;

-- What the brand-safety and image-rights check found, by name.
--
-- Named findings rather than a sentence, for the same reason `voice_violations`
-- is (STORY-009): the reviewer needs to know *which* rule tripped, and a queue
-- is worth querying by reason.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS safety_findings TEXT[] NOT NULL DEFAULT '{}';

-- Whether the image's rights are established, unresolved, or refused.
--
-- Its own column rather than a finding, because it is the one thing that blocks
-- publication *even after a human approves* — the same rule a superseded press
-- kit follows since STORY-005. A reviewer can accept a brand-safety risk on the
-- author's behalf. Nobody at this company can grant a licence they do not have.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS image_rights TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_image_rights_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_image_rights_check
    CHECK (image_rights IN ('not_applicable', 'cleared', 'unresolved', 'refused'));

-- A meme must carry its image; a text post must not pretend to.
ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_meme_has_media;
ALTER TABLE drafts ADD CONSTRAINT drafts_meme_has_media CHECK (
    (format = 'text' AND media IS NULL)
    OR (format = 'meme' AND media IS NOT NULL AND media ? 'imageRef')
);

CREATE INDEX IF NOT EXISTS drafts_format_idx ON drafts (author_id, format);

-- Which platforms a meme is worth routing to.
--
-- The story asks for meme candidates to "route preferentially to visual-first
-- platforms such as X". That is a property of the platform, so it belongs on
-- the platform row rather than in a list inside the drafting agent — a hard
-- coded set of platform names in code is the thing that goes stale when a
-- platform is added.
ALTER TABLE platform_windows ADD COLUMN IF NOT EXISTS visual_first BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE platform_windows SET visual_first = TRUE WHERE platform IN ('twitter', 'instagram');

COMMENT ON COLUMN drafts.image_rights IS
    'cleared: licence established and permits this use. unresolved: provenance '
    'is missing or incomplete — publication is refused even if approved. '
    'refused: the licence is known and forbids this use. not_applicable: text.';

COMMIT;
