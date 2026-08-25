-- STORY-006 / REQ-003 — align PR drafts with the book's themes
--
-- STORY-003 already scored alignment, but only *after* the copy was written and
-- only by asking whether a theme string appeared verbatim. That measures
-- mentions, not messages: a release saying "craft" four times scored 1.00 while
-- arguing nothing the book argues. STORY-006's clause is that the agent
-- *aligns* the draft and that the draft "reflects the book's key messages and
-- themes" — a step in the pipeline, not a grade afterwards, and a claim about
-- meaning rather than about strings.
--
-- Three things become data here: what each theme actually claims (key_message),
-- the book's own passages that evidence it (the retrieval corpus RAG needs),
-- and which of both a finished material carried.

BEGIN;

-- What the book argues, one row per theme. books.themes stays as it is: it is
-- the author's list, and everything in 001-005 reads it. This table is the
-- grounded version of the same list, with room for the claim behind the label.
CREATE TABLE IF NOT EXISTS book_themes (
    id          BIGSERIAL PRIMARY KEY,
    book_id     BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    theme       TEXT   NOT NULL,
    -- The sentence a draft has to reflect to count as on-message. Empty until a
    -- human writes it; alignment then falls back to retrieved evidence alone
    -- rather than failing every book that predates this table.
    key_message TEXT   NOT NULL DEFAULT '',
    position    INT    NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT book_themes_one_per_book UNIQUE (book_id, theme)
);

CREATE INDEX IF NOT EXISTS book_themes_book_idx ON book_themes (book_id);

-- The retrieval corpus: the book split into passages, indexed for full-text
-- search. Chosen over embeddings because retrieval decides what the drafter is
-- told, and the stub provider has to stay deterministic and offline — a demo
-- that needs a network call to produce the same output twice is not a demo.
CREATE TABLE IF NOT EXISTS book_passages (
    id      BIGSERIAL PRIMARY KEY,
    book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ordinal INT    NOT NULL,
    content TEXT   NOT NULL,
    tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    CONSTRAINT book_passages_one_per_ordinal UNIQUE (book_id, ordinal)
);

CREATE INDEX IF NOT EXISTS book_passages_tsv_idx ON book_passages USING GIN (tsv);

-- Per-material, per-theme alignment. The single theme_alignment number on
-- pr_materials says a draft is 0.62 aligned; this says *which* theme it named
-- and failed to argue, which is the thing a reviewer can actually act on.
CREATE TABLE IF NOT EXISTS pr_material_themes (
    id            BIGSERIAL PRIMARY KEY,
    material_id   BIGINT  NOT NULL REFERENCES pr_materials(id) ON DELETE CASCADE,
    theme         TEXT    NOT NULL,
    key_message   TEXT    NOT NULL DEFAULT '',
    -- The theme appears verbatim. Kept as its own boolean rather than folded
    -- into the score: naming a theme and arguing it are different failures.
    named         BOOLEAN NOT NULL,
    message_score NUMERIC(4,3) NOT NULL,
    score         NUMERIC(4,3) NOT NULL,
    -- Which retrieved passages grounded this theme, and which of their
    -- distinctive words the draft actually carried through.
    passage_ids   BIGINT[] NOT NULL DEFAULT '{}',
    carried_terms TEXT[]   NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pr_material_themes_one_per_theme UNIQUE (material_id, theme),
    CONSTRAINT pr_material_themes_score_range CHECK (score >= 0 AND score <= 1),
    CONSTRAINT pr_material_themes_message_range CHECK (
        message_score >= 0 AND message_score <= 1
    )
);

CREATE INDEX IF NOT EXISTS pr_material_themes_material_idx
    ON pr_material_themes (material_id);

-- What the retrieval step actually pulled, so "the draft was grounded" is a
-- readable fact on the kit and not only a line in the audit log.
ALTER TABLE pr_kits ADD COLUMN IF NOT EXISTS grounded_themes INT NOT NULL DEFAULT 0;
ALTER TABLE pr_kits ADD COLUMN IF NOT EXISTS grounded_passages INT NOT NULL DEFAULT 0;

-- The index is a pure function of the book, so the database derives it. A
-- trigger rather than service code because books are written from the seed, the
-- API and the tests, and a retrieval corpus that exists on only one of those
-- paths is worse than none: the drafter would silently lose its grounding.
CREATE OR REPLACE FUNCTION sync_book_theme_index() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    -- Drop themes the book no longer claims; keep the key_message a human wrote
    -- for one that survived the edit.
    DELETE FROM book_themes WHERE book_id = NEW.id AND theme <> ALL (NEW.themes);

    INSERT INTO book_themes (book_id, theme, position)
    SELECT NEW.id, t.theme, t.pos
      FROM unnest(NEW.themes) WITH ORDINALITY AS t(theme, pos)
    ON CONFLICT (book_id, theme) DO UPDATE SET position = EXCLUDED.position;

    IF TG_OP = 'INSERT' OR NEW.content IS DISTINCT FROM OLD.content THEN
        DELETE FROM book_passages WHERE book_id = NEW.id;
        INSERT INTO book_passages (book_id, ordinal, content)
        SELECT NEW.id, p.ordinal, btrim(regexp_replace(p.chunk, '\s+', ' ', 'g'))
          FROM regexp_split_to_table(NEW.content, '\n[[:space:]]*\n')
               WITH ORDINALITY AS p(chunk, ordinal)
         WHERE btrim(p.chunk) <> '';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS books_sync_theme_index ON books;
CREATE TRIGGER books_sync_theme_index
    AFTER INSERT OR UPDATE OF themes, content ON books
    FOR EACH ROW EXECUTE FUNCTION sync_book_theme_index();

-- Backfill every book that already exists. Re-running the trigger body by
-- touching the row would fire other triggers; doing it directly is narrower.
INSERT INTO book_themes (book_id, theme, position)
SELECT b.id, t.theme, t.pos
  FROM books b, unnest(b.themes) WITH ORDINALITY AS t(theme, pos)
ON CONFLICT (book_id, theme) DO NOTHING;

INSERT INTO book_passages (book_id, ordinal, content)
SELECT b.id, p.ordinal, btrim(regexp_replace(p.chunk, '\s+', ' ', 'g'))
  FROM books b,
       regexp_split_to_table(b.content, '\n[[:space:]]*\n')
       WITH ORDINALITY AS p(chunk, ordinal)
 WHERE btrim(p.chunk) <> ''
ON CONFLICT (book_id, ordinal) DO NOTHING;

COMMIT;
