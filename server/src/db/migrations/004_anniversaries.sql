-- STORY-004 / REQ-003 — draft PR materials for a book anniversary
--
-- STORY-003 already drafts for anniversary milestones. What was missing is a
-- way to know *which* anniversary a milestone is: the copy was hardcoded to the
-- first, so a second or third anniversary would have gone out factually wrong.
-- An anniversary is a function of the publication date, so record that.

BEGIN;

ALTER TABLE books ADD COLUMN IF NOT EXISTS published_on DATE;

COMMENT ON COLUMN books.published_on IS
    'Publication date. Anniversaries are counted from here, so a milestone can '
    'state which anniversary it marks instead of assuming the first.';

COMMIT;
