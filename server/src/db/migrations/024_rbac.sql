-- STORY-019 / REQ-005 — the audit log gets access control, and the log stops
-- being a place a secret could be written and never removed
--
-- 008_auth.sql said it plainly, in its own comment: "This is not RBAC: there
-- are no per-resource permissions here, only the one distinction the tenant
-- boundary needs." That was true and honest for STORY-064, which needed exactly
-- one distinction. STORY-019's second acceptance clause asks for the thing that
-- comment says does not exist: "Given a user tries to access the audit log;
-- When the user has appropriate RBAC permissions; Then the user can access the
-- log; otherwise, access is denied."
--
-- Measured before writing this: `GET /api/audit-log` had no role check at all.
-- Any signed-in author read it. The 403 an author gets asking for another
-- tenant's rows comes from `enforceTenant` — that is tenant scoping, which
-- answers "whose rows?", not "may this role read audit data?". Two different
-- questions, and only one of them was being asked. STORY-017 found the same
-- shape in the trust dashboard: a guard answering a question next to the one
-- you meant.
--
-- So permissions become rows rather than role names spelled into each route.
-- 008 predicted this: "adding a third role later is a row rather than a
-- migration to every check." This migration adds a third role and takes that
-- claim at its word — `compliance` reads every tenant's audit log and verifies
-- its integrity, and can manage nothing. If that requires touching any route,
-- the claim was false.

BEGIN;

-- What a role may do, as data. Named `resource.action` so the set stays
-- readable in a grant table rather than becoming a bitmask nobody can audit.
CREATE TABLE IF NOT EXISTS permissions (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO permissions (name, description) VALUES
    ('audit.read',      'Read the audit log. Scoped to the caller''s own tenant unless tenant.read.all is also held.'),
    ('audit.verify',    'Run and read the tamper-verification over the sealed audit ranges.'),
    ('tenant.read.all', 'Address any tenant. The distinction `enforceTenant` used to read off role = admin.'),
    ('tenant.manage',   'Onboard, suspend and restore tenants.'),
    ('templates.manage','Add and retire meme templates in the shared library.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- The third role, and the test of 008's claim. A compliance officer is exactly
-- the "authorized personnel for review and compliance checks" REQ-005 names:
-- they must read across every tenant and must not be able to change anything.
-- Under role checks that person had to be made an admin — which is how "read
-- the audit log" quietly becomes "suspend a tenant".
INSERT INTO roles (name, description) VALUES
    ('compliance', 'Reads every tenant''s audit log and verifies its integrity. Changes nothing.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS role_permissions (
    role       TEXT NOT NULL REFERENCES roles(name)       ON DELETE CASCADE,
    permission TEXT NOT NULL REFERENCES permissions(name) ON DELETE CASCADE,
    PRIMARY KEY (role, permission)
);

-- An author reads their own audit trail: it is the record of decisions made
-- about their own work, and REQ-005's purpose is that the record is reviewable.
-- What they do not get is anyone else's, or the integrity verdict over the
-- whole log.
INSERT INTO role_permissions (role, permission) VALUES
    ('author',     'audit.read'),

    ('compliance', 'audit.read'),
    ('compliance', 'audit.verify'),
    ('compliance', 'tenant.read.all'),

    ('admin',      'audit.read'),
    ('admin',      'audit.verify'),
    ('admin',      'tenant.read.all'),
    ('admin',      'tenant.manage'),
    ('admin',      'templates.manage')
ON CONFLICT DO NOTHING;

-- The same conflation, one layer down.
--
-- 008 wrote `CHECK (role = 'admin' OR author_id IS NOT NULL)` — "only an admin
-- may have no tenant". What it meant was "an account with no tenant must be
-- able to read across tenants", and while `admin` was the only such role those
-- two sentences were indistinguishable. Adding `compliance` separated them, and
-- the constraint rejected the first compliance user created.
--
-- It has to become a trigger rather than a better CHECK: a CHECK constraint may
-- not contain a subquery, and the rule is now a question about a grant. Same
-- mechanism the audit log already uses to enforce append-only, so this is the
-- house pattern rather than a new one.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_author_needs_tenant;

CREATE OR REPLACE FUNCTION users_require_tenant_unless_global()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.author_id IS NULL AND NOT EXISTS (
        SELECT 1 FROM role_permissions
         WHERE role = NEW.role AND permission = 'tenant.read.all'
    ) THEN
        RAISE EXCEPTION
            'user %: role "%" has no tenant and cannot read across tenants, so it could see nothing at all',
            NEW.email, NEW.role
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_tenant_required ON users;
CREATE TRIGGER users_tenant_required
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION users_require_tenant_unless_global();

COMMIT;
