-- STORY-013 / REQ-006 + REQ-004 — the Audit and Security Agent
--
-- "Logs all actions" has been true since STORY-001. Every agent calls
-- `recordAction`, the table refuses UPDATE, DELETE and TRUNCATE by trigger, and
-- an inventory of what mutates state against what writes an audit row comes back
-- clean.
--
-- The other half of that agent's name had nothing behind it. The log is
-- append-only *by policy* — a trigger — and a policy can be switched off:
--
--     ALTER TABLE audit_log DISABLE TRIGGER ALL;
--     UPDATE audit_log SET actor = 'SomebodyElse' WHERE id = 1;
--     DELETE FROM audit_log WHERE id IN (...);
--     ALTER TABLE audit_log ENABLE TRIGGER ALL;
--
-- Run against this database, that rewrote who approved what and removed three
-- rows, and afterwards the log still refused every ordinary mutation and nothing
-- in the system could tell. Prevention with no detection: the guarantee holds
-- exactly as long as nobody with table rights decides otherwise, and leaves no
-- evidence either way.
--
-- Checkpoints are the answer, and deliberately not a per-row hash chain. Chaining
-- at insert time means serialising every audit write in the system behind a lock
-- on the previous row, and every action here writes one. Sealing ranges
-- periodically is what real audit systems do, costs nothing on the write path,
-- and detects the same three things: a row altered, a row removed, a row
-- inserted after the fact.

BEGIN;

CREATE TABLE IF NOT EXISTS audit_checkpoints (
    id          BIGSERIAL PRIMARY KEY,
    -- The closed range of audit_log ids this seal covers.
    from_id     BIGINT NOT NULL,
    to_id       BIGINT NOT NULL,
    -- Counted at seal time rather than derived from the range. Sequence gaps are
    -- normal — a rolled-back transaction consumes an id without leaving a row —
    -- so (to_id - from_id + 1) is not the row count and never was. Storing the
    -- real count is what makes a later deletion detectable.
    row_count   INT    NOT NULL,

    -- SHA-256 over the previous checkpoint's digest followed by every row in
    -- range, each serialised canonically. Chained, so removing a whole
    -- checkpoint breaks the next one rather than going unnoticed.
    digest      TEXT   NOT NULL,
    prev_digest TEXT   NOT NULL,

    sealed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_checkpoints_range_sane CHECK (to_id >= from_id AND row_count >= 0)
);

CREATE INDEX IF NOT EXISTS audit_checkpoints_range_idx ON audit_checkpoints (to_id DESC);

-- The seals get the same protection the log has, for the same reason: a
-- checkpoint an attacker can quietly rewrite verifies nothing.
--
-- This is not a complete answer and the README says so. Anyone who can disable
-- these triggers can disable the log's, and re-sealing a doctored range would
-- produce a consistent chain. What it buys is that tampering now requires
-- rewriting two structures in step rather than one, and that anything short of
-- that is caught. Publishing digests somewhere this database cannot reach is the
-- next step, and it is a deployment decision rather than a schema one.
DROP TRIGGER IF EXISTS audit_checkpoints_no_update ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_no_update
    BEFORE UPDATE ON audit_checkpoints
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_checkpoints_no_delete ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_no_delete
    BEFORE DELETE ON audit_checkpoints
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS audit_checkpoints_no_truncate ON audit_checkpoints;
CREATE TRIGGER audit_checkpoints_no_truncate
    BEFORE TRUNCATE ON audit_checkpoints
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

COMMENT ON TABLE audit_checkpoints IS
    'Periodic seals over ranges of audit_log. Detects a row altered, removed or '
    'inserted after the fact — the half the append-only trigger cannot do, '
    'because prevention that can be switched off leaves no evidence.';

COMMIT;
