-- STORY-017 / REQ-010 + REQ-004 — the Tenant Management Agent
--
-- The build note suggests PostgreSQL schemas or separate databases. This system
-- uses neither: isolation is an `author_id` column on 22 tables, enforced in
-- application middleware. That was already written down as a known gap, and
-- this story is where it gets tested rather than restated.
--
-- Tested, it failed. `tenantParam` guards the *address* of a route —
-- /authors/1/... is refused to author 2 — and says nothing about the rows the
-- handler then goes and fetches. Signing in as one author and asking for that
-- author's own trust dashboard returned the last twenty audit rows across every
-- tenant, including another author's. The middleware was working exactly as
-- designed; the leak was in a handler written two stories later that queried a
-- table directly.
--
-- So the useful thing here is not another guard at the edge. It is onboarding
-- that produces a tenant with its access already correct, and a check that
-- looks for the leak from outside the code that is supposed to prevent it.

BEGIN;

-- A tenant is an author. Making that explicit rather than inventing a parallel
-- table: every one of those 22 tables already keys on `author_id`, and a second
-- identity for the same thing is a migration with no benefit and a join.
ALTER TABLE authors ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMPTZ;
ALTER TABLE authors ADD COLUMN IF NOT EXISTS tenant_status TEXT NOT NULL DEFAULT 'active';

ALTER TABLE authors DROP CONSTRAINT IF EXISTS authors_tenant_status_check;
ALTER TABLE authors ADD CONSTRAINT authors_tenant_status_check
    CHECK (tenant_status IN ('active', 'suspended'));

-- Suspending rather than deleting, for the reason everything else in this
-- system is retired rather than deleted: a suspended tenant's drafts, approvals
-- and audit rows are still the record of what happened, and a foreign key that
-- cascades them away destroys the evidence along with the account.
COMMENT ON COLUMN authors.tenant_status IS
    'active or suspended. Suspension stops a tenant being served without '
    'deleting what it did — the audit trail outlives the account.';

-- What an isolation check found, when it ran.
--
-- Stored rather than computed on demand only, because the useful question is
-- "has this ever failed", and a check nobody kept the results of can only
-- answer "is it failing right now".
CREATE TABLE IF NOT EXISTS isolation_checks (
    id           BIGSERIAL PRIMARY KEY,
    author_id    BIGINT REFERENCES authors(id) ON DELETE CASCADE,
    -- Rows visible to this tenant that belong to another one. Zero is the only
    -- acceptable answer and the column exists to record when it was not.
    leaked_rows  INT    NOT NULL DEFAULT 0,
    tables_checked INT  NOT NULL DEFAULT 0,
    findings     JSONB  NOT NULL DEFAULT '[]',
    checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT isolation_checks_leaked_sane CHECK (leaked_rows >= 0)
);

CREATE INDEX IF NOT EXISTS isolation_checks_recent_idx ON isolation_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS isolation_checks_failures_idx
    ON isolation_checks (checked_at DESC) WHERE leaked_rows > 0;

COMMIT;
