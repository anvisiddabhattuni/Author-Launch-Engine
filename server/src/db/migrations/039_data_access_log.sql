-- STORY-044 / REQ-011 — tenant data access audit
--
-- Measured before this story: the audit log records what changed (approvals,
-- onboarding, access changes) and nothing that was only *read*. A request for
-- another tenant's data was refused — 403 by `tenantParam`, `assertOwns`, or
-- the tenant's database role (STORY-041) — and the refusal went nowhere. A
-- security officer asking "who has looked at Mira's drafts?" or "has anyone
-- been trying doors?" had no answer; the request counter (STORY-027) keeps
-- only timings and status codes, in memory.
--
-- So every request that reaches tenant data is recorded here: who (user, role,
-- their own tenant), whose data (tenant, or all tenants for a cross-tenant
-- read), what (method, route, path), how it ended (allowed, denied, …) and
-- which database role served it.

BEGIN;

CREATE TABLE IF NOT EXISTS data_access_events (
    id              BIGSERIAL   PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Who. No foreign key: the record of an access outlives the account.
    user_id         BIGINT,
    user_email      TEXT,
    user_role       TEXT,
    actor_author_id BIGINT,
    -- Whose data. Named author_id so each tenant's schema (STORY-041) gets a
    -- view of the accesses to its own data, and nobody else's.
    author_id       BIGINT,
    scope           TEXT        NOT NULL CHECK (scope IN ('tenant', 'all_tenants', 'own_account')),
    method          TEXT        NOT NULL,
    route           TEXT        NOT NULL,
    path            TEXT        NOT NULL,
    status          INT         NOT NULL,
    outcome         TEXT        NOT NULL CHECK (outcome IN ('allowed', 'denied', 'not_found', 'invalid', 'unauthenticated', 'error')),
    reason          TEXT,
    db_role         TEXT,
    duration_ms     NUMERIC(10,1),
    ip              TEXT,
    -- The acceptance clause, as constraints: every event is traceable to a
    -- user — except an attempt with no session, which has none to name — and
    -- an event about one tenant's data names the tenant.
    CONSTRAINT data_access_events_has_user CHECK (outcome = 'unauthenticated' OR user_id IS NOT NULL),
    CONSTRAINT data_access_events_has_tenant CHECK ((scope = 'tenant') = (author_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS data_access_events_tenant_idx ON data_access_events (author_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS data_access_events_user_idx ON data_access_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS data_access_events_refused_idx
    ON data_access_events (occurred_at DESC) WHERE outcome <> 'allowed';

-- Append-only, the same two walls as audit_log: no privilege to change it,
-- and a trigger behind that for anyone who has one.
CREATE OR REPLACE FUNCTION data_access_events_block_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'data_access_events is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS data_access_events_no_update ON data_access_events;
CREATE TRIGGER data_access_events_no_update BEFORE UPDATE ON data_access_events
    FOR EACH ROW EXECUTE FUNCTION data_access_events_block_mutation();
DROP TRIGGER IF EXISTS data_access_events_no_delete ON data_access_events;
CREATE TRIGGER data_access_events_no_delete BEFORE DELETE ON data_access_events
    FOR EACH ROW EXECUTE FUNCTION data_access_events_block_mutation();
DROP TRIGGER IF EXISTS data_access_events_no_truncate ON data_access_events;
CREATE TRIGGER data_access_events_no_truncate BEFORE TRUNCATE ON data_access_events
    FOR EACH STATEMENT EXECUTE FUNCTION data_access_events_block_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON data_access_events FROM ale_app;
GRANT SELECT, INSERT ON data_access_events TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE data_access_events_id_seq TO ale_app;

-- Mitigation: blocking an account has to bite on the next request, not when
-- its token expires. Sessions re-read the account only when the access
-- version has moved (STORY-042), and only the owner moves it — so blocking
-- and unblocking are owner functions the application may call.
CREATE OR REPLACE FUNCTION ale_set_account_active(p_user BIGINT, p_active BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    changed BOOLEAN;
BEGIN
    UPDATE users SET active = p_active WHERE id = p_user AND active IS DISTINCT FROM p_active;
    changed := FOUND;
    IF changed THEN
        UPDATE access_version SET version = version + 1, changed_at = now();
    END IF;
    RETURN changed;
END;
$$;
REVOKE ALL ON FUNCTION ale_set_account_active(BIGINT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ale_set_account_active(BIGINT, BOOLEAN) TO ale_app;

COMMIT;
