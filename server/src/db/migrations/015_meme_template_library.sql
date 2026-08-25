-- STORY-067 / REQ-001 — a reusable, rights-checked meme template library
--
-- Added after Ram asked for memes to be "a significant theme", not a single
-- story. STORY-066 shipped five templates as a hardcoded array in
-- `memeTemplates.js`, which is fine for proving the idea and wrong for owning
-- one: an author cannot add a template to a source file, cannot retire one that
-- has stopped working, and cannot see what the generator is choosing from.
--
-- Two things change here beyond "put it in a table".
--
--   Named caption slots. A STORY-066 template had an implicit shape described in
--   a comment, and the drafter had a hardcoded caption function per layout. A
--   slot is now a named, addressable position with its own limit and its own
--   role, so a template can be added without a code change to go with it.
--
--   Rejections are recorded. STORY-066 filtered unlicensed templates out with
--   `usableTemplates()` and said nothing — the same silence STORY-010 found in
--   the opportunity scanner, where a filter decided what nobody would ever see
--   and kept no record of it. This story's second acceptance clause asks for the
--   attempt to be logged, and that is the clause that makes the rule auditable
--   rather than merely true.

BEGIN;

CREATE TABLE IF NOT EXISTS meme_templates (
    id            BIGSERIAL PRIMARY KEY,
    -- Stable string id, so a seed can be re-run and a draft's stored
    -- `media.template` keeps pointing at the same thing across databases.
    key           TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    layout        TEXT    NOT NULL,

    -- The addressable positions a caption fills, in order. Each carries its own
    -- character limit and the role it plays, so the drafter is told what the
    -- slot is *for* rather than inferring it from the layout name:
    --   [{ "name": "setup", "role": "the expectation", "maxChars": 60,
    --      "x": 40, "y": 190, "size": 40, "anchor": "start", "wrap": 32 }]
    caption_slots JSONB   NOT NULL DEFAULT '[]',

    -- The artwork itself. Stored rather than generated at draft time (STORY-066
    -- composed the whole picture from a palette), because a template you cannot
    -- point at is not a template — it is a function, and it cannot be licensed,
    -- previewed or retired independently of the code that draws it.
    image_ref     TEXT    NOT NULL,
    -- Where it came from, in words a person can check.
    source        TEXT    NOT NULL DEFAULT '',

    -- NULL means nobody recorded the rights. That is deliberately different
    -- from a licence that forbids use: one is a gap in our paperwork and one is
    -- a decision by the rights-holder, and STORY-066 already treats them
    -- differently (unresolved vs refused). The generator refuses both.
    licence       JSONB,

    -- Retiring rather than deleting. A meme drafted last month points at its
    -- template, and deleting the row would strand the provenance on a post that
    -- has already gone out.
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    retired_at    TIMESTAMPTZ,
    retired_reason TEXT   NOT NULL DEFAULT '',

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT meme_templates_slots_present CHECK (jsonb_array_length(caption_slots) > 0),
    -- A retired template says when and why; an active one claims neither.
    CONSTRAINT meme_templates_retirement_consistent CHECK (
        (active AND retired_at IS NULL) OR (NOT active AND retired_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS meme_templates_active_idx ON meme_templates (active, key);

-- Which template a draft was composed from, as a real reference rather than a
-- string inside `media`. The JSONB copy stays — a post that has gone out should
-- carry the provenance it went out with, even if the template is later edited —
-- but a foreign key is what makes "which drafts used this template" answerable.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS meme_template_id BIGINT
    REFERENCES meme_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS drafts_meme_template_idx ON drafts (meme_template_id);

COMMENT ON TABLE meme_templates IS
    'Reusable meme formats with recorded provenance. A template with no licence '
    'is never offered to the generator, and the refusal is written to the audit '
    'log rather than being a silent filter.';

COMMIT;
