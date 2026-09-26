-- STORY-033 / REQ-005, REQ-006, REQ-008 — the database says no on its own
--
-- STORY-019 built role-based access in the application: permissions, grants,
-- `requirePermission`. Measured before this migration, the database under it
-- had none of that:
--
--   * The API connected as `anvi` — a Postgres **superuser** that owns all 46
--     tables. Anything that got code running in the API process could drop any
--     table, read any tenant, or grant itself anything.
--   * The audit log's append-only promise (STORY-001's triggers) held only
--     against callers who could not turn the triggers off — and the table's
--     owner can: `ALTER TABLE audit_log DISABLE TRIGGER ALL`. The demo's
--     STORY-013 stages do exactly that, through the application's own pool.
--     The account that writes the log could erase it.
--
-- Application-level RBAC decides what a *user* may do. It cannot help once the
-- process itself is compromised, because the process holds every key. This is
-- the second wall: a role the application runs as, which can read and write
-- rows and cannot change the schema, cannot disable a trigger, and cannot
-- update or delete a single audit row whatever the code asks for.
--
-- Roles are cluster-wide, so they are created if missing rather than dropped
-- and recreated — a second database on the same server (the test database,
-- say) must not have its roles pulled out from under it. Grants are per
-- database and are re-applied here every time the schema is rebuilt.

BEGIN;

DO $$
BEGIN
    -- What the API and the worker run as. Rows, not schema.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ale_app') THEN
        CREATE ROLE ale_app NOLOGIN;
    END IF;
    -- For reporting and for a compliance reviewer with a SQL client: reads
    -- everything, writes nothing. The database counterpart of STORY-019's
    -- `compliance` role.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ale_readonly') THEN
        CREATE ROLE ale_readonly NOLOGIN;
    END IF;
    -- The login the application uses. A separate login, not `SET ROLE` on the
    -- owner's connection: a superuser session that has SET ROLE can RESET
    -- ROLE, so an injected statement would simply switch back. Only a login
    -- that never held the power is a boundary.
    --
    -- No password here. A migration is committed to the repository, and a
    -- password in it is a published password. Locally, Homebrew Postgres
    -- trusts localhost; anywhere else, `APP_DB_PASSWORD` is applied by
    -- migrate.js out of band (see README).
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ale_app_login') THEN
        CREATE ROLE ale_app_login LOGIN IN ROLE ale_app;
    END IF;
END
$$;

-- Nothing by default. PUBLIC can create objects in `public` on older
-- Postgres; 15+ removed that, and saying it here keeps it true on any server.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ale_app, ale_readonly;

-- The application: rows in every table, and nothing structural. No TRUNCATE —
-- emptying a table in one statement is never something the product does.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ale_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ale_app;

-- Append-only, enforced by privilege as well as by trigger. The trigger stops
-- a mistaken UPDATE; the privilege stops a deliberate one, because a role
-- without UPDATE cannot be granted it by the code it runs, and does not own
-- the table, so it cannot disable the trigger either.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ale_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_checkpoints FROM ale_app;
-- Which migrations ran is the owner's record. The app reads it for readiness.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ale_app;

-- Read-only, everywhere.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ale_readonly;

-- Tables created by later migrations get the same, without anyone
-- remembering. A table that should be append-only has to say so with a
-- REVOKE of its own, and the test suite lists which tables are, so a new one
-- that forgets is caught.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ale_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ale_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ale_readonly;

COMMIT;
