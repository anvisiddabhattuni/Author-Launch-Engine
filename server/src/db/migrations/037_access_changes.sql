-- STORY-042 / REQ-011 — role and permission changes are reviewed and approved
--
-- The acceptance clause — a user can only reach their own tenant's data — has
-- held since STORY-017 in the application and since STORY-041 in the database.
-- The story's trust line is the part that did not: "any new role or permission
-- changes are reviewed and approved by an admin". Measured before this
-- migration:
--
--   * There was no reviewed way to change access at all. Grants changed only
--     by editing `role_permissions` in SQL — a migration, or a DBA — and the
--     product recorded nothing of who asked or who agreed.
--   * One admin could mint another. POST /tenants accepted `role: "admin"`,
--     answered 201, and the new account signed in holding all eight
--     permissions. The audit log recorded "tenant.onboarded" by an agent, not
--     the person, and no second person was involved.
--   * A revoked permission kept working. Permissions are carried in the
--     session token; with `content.approve` removed from authors, an author
--     approved a draft with the token they already had. Up to twelve hours.
--
-- So: every grant, revocation and role assignment is a request; a different
-- admin approves it; only an approved request changes anything, through one
-- function; and the database — not the application — refuses the rest.

BEGIN;

INSERT INTO permissions (name, description) VALUES
  ('access.manage',
   'Propose and approve changes to roles and permissions. Never both for the same change: the approver must be someone else.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;
INSERT INTO role_permissions (role, permission) VALUES ('admin', 'access.manage') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS access_changes (
    id            BIGSERIAL   PRIMARY KEY,
    kind          TEXT        NOT NULL,
    -- grant_permission / revoke_permission: which role, which permission.
    role          TEXT        REFERENCES roles(name),
    permission    TEXT        REFERENCES permissions(name),
    -- assign_role: which account, to which role.
    user_id       BIGINT      REFERENCES users(id) ON DELETE CASCADE,
    new_role      TEXT        REFERENCES roles(name),
    reason        TEXT        NOT NULL,
    requested_by  BIGINT      REFERENCES users(id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status        TEXT        NOT NULL DEFAULT 'pending',
    decided_by    BIGINT      REFERENCES users(id),
    decided_at    TIMESTAMPTZ,
    decision_note TEXT        NOT NULL DEFAULT '',
    applied_at    TIMESTAMPTZ,
    CONSTRAINT access_changes_kind_check CHECK (kind IN ('grant_permission', 'revoke_permission', 'assign_role')),
    CONSTRAINT access_changes_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'bootstrap')),
    CONSTRAINT access_changes_shape CHECK (
        (kind IN ('grant_permission', 'revoke_permission') AND role IS NOT NULL AND permission IS NOT NULL AND user_id IS NULL)
     OR (kind = 'assign_role' AND user_id IS NOT NULL AND new_role IS NOT NULL AND role IS NULL AND permission IS NULL)
    ),
    CONSTRAINT access_changes_has_reason CHECK (length(trim(reason)) >= 10),
    -- The rule this story is about, where no code path can skip it: whoever
    -- decides is not whoever asked.
    CONSTRAINT access_changes_two_people CHECK (decided_by IS NULL OR requested_by IS NULL OR decided_by <> requested_by),
    -- Approving or rejecting takes a decider; withdrawing your own request
    -- does not, and must not need a second person to allow it.
    CONSTRAINT access_changes_decision_complete CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL))
);

-- One open request per target. Two pending "grant X to Y" rows could both be
-- approved, and one would describe a change that never happened.
CREATE UNIQUE INDEX IF NOT EXISTS access_changes_one_pending_grant
    ON access_changes (kind, role, permission) WHERE status = 'pending' AND user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS access_changes_one_pending_assignment
    ON access_changes (user_id) WHERE status = 'pending' AND kind = 'assign_role';

-- A 'bootstrap' row records an account the seed or a migration created with a
-- privileged role, before anyone existed to approve it. Only the owner may
-- write one — otherwise "bootstrap" is a way round the review.
CREATE OR REPLACE FUNCTION access_changes_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'bootstrap' AND current_user = 'ale_app_login' THEN
        RAISE EXCEPTION 'A bootstrap access record can only be written by the schema owner';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS access_changes_guard ON access_changes;
CREATE TRIGGER access_changes_guard BEFORE INSERT OR UPDATE ON access_changes
    FOR EACH ROW EXECUTE FUNCTION access_changes_guard();

-- Bumped by every applied change. Sessions carry the version they were issued
-- under; a session behind it has its access re-read before it is trusted, so a
-- revocation takes effect on the next request, not twelve hours later.
CREATE TABLE IF NOT EXISTS access_version (
    id      BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    version BIGINT  NOT NULL DEFAULT 1,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO access_version (id) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- The only way an approved change is applied. Runs with the owner's rights,
-- checks what it is told rather than trusting it, and bumps the version.
CREATE OR REPLACE FUNCTION ale_apply_access_change(change_id BIGINT)
RETURNS access_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
    c access_changes;
BEGIN
    SELECT * INTO c FROM access_changes WHERE id = change_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'No access change %', change_id; END IF;
    IF c.status <> 'approved' THEN RAISE EXCEPTION 'Access change % is %, not approved', change_id, c.status; END IF;
    IF c.applied_at IS NOT NULL THEN RAISE EXCEPTION 'Access change % was already applied', change_id; END IF;
    IF c.decided_by IS NULL OR c.decided_by = c.requested_by THEN
        RAISE EXCEPTION 'Access change % was not approved by a second person', change_id;
    END IF;

    IF c.kind = 'grant_permission' THEN
        INSERT INTO role_permissions (role, permission) VALUES (c.role, c.permission) ON CONFLICT DO NOTHING;
    ELSIF c.kind = 'revoke_permission' THEN
        DELETE FROM role_permissions WHERE role = c.role AND permission = c.permission;
    ELSE
        UPDATE users SET role = c.new_role WHERE id = c.user_id;
    END IF;

    UPDATE access_changes SET applied_at = now() WHERE id = change_id RETURNING * INTO c;
    UPDATE access_version SET version = version + 1, changed_at = now();
    RETURN c;
END;
$fn$;
REVOKE ALL ON FUNCTION ale_apply_access_change(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ale_apply_access_change(BIGINT) TO ale_app;

-- The application can no longer change access directly. It could before: the
-- app login had INSERT and DELETE on role_permissions and UPDATE on every
-- column of users, so "reviewed and approved" would have been a convention.
REVOKE INSERT, UPDATE, DELETE ON role_permissions FROM ale_app;
REVOKE UPDATE ON users FROM ale_app;
GRANT UPDATE (name, email, password_hash, active, author_id) ON users TO ale_app;
GRANT SELECT, INSERT, UPDATE ON access_changes TO ale_app;
GRANT SELECT ON access_version TO ale_app, ale_readonly;

-- Tenants see neither: an access request names people across tenants.
INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('access_changes', FALSE, 'Requests to change who may do what, across every tenant (STORY-042). Operators only.'),
  ('access_version', TRUE,  'A single number that moves when access changes. No tenant data.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
