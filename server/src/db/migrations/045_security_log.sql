-- STORY-051 / REQ-013 — a separate, encrypted security log of audit log access
--
-- Measured before this story: attempts to read the audit logs landed in the
-- data access log (STORY-044) — in the clear, beside every other request, and
-- readable by anyone who reads that. Nothing kept "who tried to read the audit
-- trail" apart, and nothing protected that record the way STORY-049 protects
-- the trail itself.
--
-- Now every attempt on an audit route — the routes STORY-050 declares, allowed
-- or refused — is also written here: a separate log, encrypted with the same
-- AES-256 key as the audit log (the key is still never in the database),
-- append-only, and readable only through the reviewer's route. Each entry
-- carries the request id of its data access record, so the two can be checked
-- against each other.

BEGIN;

ALTER TABLE data_access_events ADD COLUMN IF NOT EXISTS request_id UUID;
ALTER TABLE data_access_events ADD COLUMN IF NOT EXISTS audit_route BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS security_log_sealed (
    id          BIGSERIAL   PRIMARY KEY,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id  UUID        NOT NULL UNIQUE,
    method      TEXT        NOT NULL,
    route       TEXT        NOT NULL,
    outcome     TEXT        NOT NULL CHECK (outcome IN ('allowed', 'denied', 'not_found', 'invalid', 'unauthenticated', 'error')),
    status      INT         NOT NULL,
    user_id     BIGINT,
    -- Named apart from author_id, as for the audit log: no tenant sees this log.
    tenant_id   BIGINT,
    key_id      TEXT        NOT NULL,
    -- Who and how, encrypted: email, name, role, address, browser, path, reason, API key.
    payload     BYTEA       NOT NULL
);
CREATE INDEX IF NOT EXISTS security_log_when_idx ON security_log_sealed (occurred_at DESC);
CREATE INDEX IF NOT EXISTS security_log_refused_idx ON security_log_sealed (occurred_at DESC) WHERE outcome <> 'allowed';

DROP TRIGGER IF EXISTS security_log_no_update ON security_log_sealed;
CREATE TRIGGER security_log_no_update BEFORE UPDATE ON security_log_sealed
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
DROP TRIGGER IF EXISTS security_log_no_delete ON security_log_sealed;
CREATE TRIGGER security_log_no_delete BEFORE DELETE ON security_log_sealed
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
DROP TRIGGER IF EXISTS security_log_no_truncate ON security_log_sealed;
CREATE TRIGGER security_log_no_truncate BEFORE TRUNCATE ON security_log_sealed
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

CREATE VIEW security_log AS
SELECT s.id, s.occurred_at, s.request_id, s.method, s.route, s.outcome, s.status, s.user_id, s.tenant_id,
       e.entry ->> 'email'     AS user_email,
       e.entry ->> 'name'      AS user_name,
       e.entry ->> 'role'      AS user_role,
       e.entry ->> 'ip'        AS ip,
       e.entry ->> 'userAgent' AS user_agent,
       e.entry ->> 'path'      AS path,
       e.entry ->> 'reason'    AS reason,
       (e.entry ->> 'apiKeyId')::bigint AS api_key_id,
       e.entry AS details
  FROM security_log_sealed s
  CROSS JOIN LATERAL (SELECT audit_open(s.payload) AS entry) e;

CREATE OR REPLACE FUNCTION security_log_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO security_log_sealed (occurred_at, request_id, method, route, outcome, status, user_id, tenant_id, key_id, payload)
    VALUES (COALESCE(NEW.occurred_at, now()), NEW.request_id, NEW.method, NEW.route, NEW.outcome, NEW.status,
            NEW.user_id, NEW.tenant_id, current_setting('ale.audit_key_id', true),
            audit_seal(COALESCE(NEW.details, '{}'::jsonb)))
    RETURNING id, occurred_at INTO NEW.id, NEW.occurred_at;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION security_log_insert() FROM PUBLIC;
CREATE TRIGGER security_log_encrypt INSTEAD OF INSERT ON security_log
    FOR EACH ROW EXECUTE FUNCTION security_log_insert();
CREATE TRIGGER security_log_view_no_update INSTEAD OF UPDATE ON security_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER security_log_view_no_delete INSTEAD OF DELETE ON security_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- Access-controlled: the application writes and reads through the view only;
-- the read-only reporting role, which reads everything else, reads none of it.
REVOKE ALL ON security_log_sealed FROM ale_app, ale_readonly;
REVOKE ALL ON security_log FROM ale_readonly;
GRANT SELECT, INSERT ON security_log TO ale_app;

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('security_log_sealed', FALSE, 'Who tried to read the audit logs, encrypted (STORY-051). Security reviewers only, through their route.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
