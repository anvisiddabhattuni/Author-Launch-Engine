-- STORY-046 / REQ-012 — a model fitted to each book
--
-- Measured before this story: generation adapted to a book each time it ran —
-- retrieving passages for its themes (STORY-006), deriving the author's voice
-- (STORY-007) — and kept nothing. Nothing ran when a book was uploaded; there
-- was nowhere to give supplementary material; and retrieval found a theme only
-- where the book used the theme's own word. A chapter arguing "attention"
-- through focus and distraction, never saying "attention", was invisible to it.
--
-- Claude models cannot be fine-tuned through the public API, and the offline
-- provider is templates. So "fine-tuned" here means what can be done honestly:
-- parameters fitted to this book's text — for each theme, the words this book
-- uses to argue it, learned from the passages that name it — evaluated on
-- passages held out with the theme's own word removed, stored here, versioned,
-- and used by generation.

BEGIN;

-- Supplementary materials: they inform what to look for; only the book's own
-- text is evidence.
CREATE TABLE IF NOT EXISTS book_materials (
    id          BIGSERIAL   PRIMARY KEY,
    book_id     BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id   BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL CHECK (kind IN ('synopsis', 'excerpt', 'author_note', 'press_quote', 'review')),
    content     TEXT        NOT NULL CHECK (length(trim(content)) > 0),
    added_by    TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS book_materials_book_idx ON book_materials (book_id);

CREATE TABLE IF NOT EXISTS book_models (
    id           BIGSERIAL   PRIMARY KEY,
    book_id      BIGINT      NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    author_id    BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    version      INT         NOT NULL,
    status       TEXT        NOT NULL CHECK (status IN ('current', 'superseded')),
    -- SHA-256 of everything it was fitted on. Same inputs, same model: a refit
    -- with nothing changed is refused rather than minting a new version.
    input_digest TEXT        NOT NULL,
    parameters   JSONB       NOT NULL,
    metrics      JSONB       NOT NULL,
    trigger      TEXT        NOT NULL CHECK (trigger IN ('book_uploaded', 'material_added', 'inputs_changed', 'first_draft', 'manual')),
    trained_by   TEXT        NOT NULL,
    trained_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT book_models_version UNIQUE (book_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS book_models_one_current ON book_models (book_id) WHERE status = 'current';

-- Parameters are the record of what the model learned: a version is never
-- rewritten, only superseded.
CREATE OR REPLACE FUNCTION book_models_freeze() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.parameters IS DISTINCT FROM OLD.parameters OR NEW.metrics IS DISTINCT FROM OLD.metrics
       OR NEW.input_digest IS DISTINCT FROM OLD.input_digest OR NEW.version IS DISTINCT FROM OLD.version
       OR (OLD.status = 'superseded' AND NEW.status <> 'superseded') THEN
        RAISE EXCEPTION 'book_models: a fitted version is never rewritten; fit a new one'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS book_models_frozen ON book_models;
CREATE TRIGGER book_models_frozen BEFORE UPDATE ON book_models
    FOR EACH ROW EXECUTE FUNCTION book_models_freeze();

GRANT SELECT, INSERT ON book_materials TO ale_app;
GRANT SELECT, INSERT, UPDATE ON book_models TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE book_materials_id_seq, book_models_id_seq TO ale_app;

COMMIT;
