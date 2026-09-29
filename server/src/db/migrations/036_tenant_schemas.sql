-- STORY-041 / REQ-011 — each tenant's data in a schema of its own
--
-- Measured before this migration: the database enforced no separation between
-- tenants at all. The application connects as one login that can read every
-- author's rows, and isolation lives entirely in each query's
-- `WHERE author_id = …` — which is exactly what STORY-017 found missing from
-- two routes, and what STORY-024 found checked for 10 routes of 35.
--
-- The story asks for a separate schema per author. Taken literally — every
-- table copied per tenant — it means every query routed to the right copy,
-- every migration applied N times, and every cross-tenant read (compliance,
-- the operator views, the sweeps) rewritten as a union over N schemas. That is
-- a rewrite of the data layer, and it is not what isolation needs.
--
-- What is built instead: per tenant, a schema `tenant_<id>` of views over the
-- shared tables, each showing only that tenant's rows, and a role
-- `ale_tenant_<id>` that can read *only* that schema — no privilege on the
-- shared tables at all. An author's reads run as that role with that schema
-- first on the search path, so an unqualified `drafts` is their `drafts`, and
-- a query that forgets its WHERE clause still cannot see anybody else: the
-- database refuses, not the query.
--
-- Rebuilt from the catalogue each time it runs, so a table added by a later
-- migration is covered without anyone remembering — migrate.js re-provisions
-- every tenant after applying migrations.

BEGIN;

-- The tables no tenant owns, and why a tenant may read them. Anything not
-- here, with no author_id and no owning parent, is refused to tenants — and
-- `tests/tenantSchemas.test.js` fails until it is classified, so a new table
-- is a decision, not a default.
CREATE TABLE IF NOT EXISTS tenant_shared_tables (
    table_name TEXT PRIMARY KEY,
    readable   BOOLEAN NOT NULL,
    why        TEXT    NOT NULL
);

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('platform_windows',   TRUE,  'Reference data: when each platform is best posted to. The same for everyone.'),
  ('meme_templates',     TRUE,  'The licensed template library (STORY-067), shared by design.'),
  ('press_contacts',     TRUE,  'The press directory every kit is distributed to (STORY-003).'),
  ('roles',              TRUE,  'Names of roles. No tenant data.'),
  ('permissions',        TRUE,  'Names of permissions. No tenant data.'),
  ('role_permissions',   TRUE,  'Which role holds which permission (STORY-019). Shown on the masthead.'),
  ('integration_circuits', TRUE, 'Whether each integration is answering (STORY-038). System state, no tenant rows.'),
  ('deployments',        TRUE,  'What is running (STORY-015). Readable by anyone signed in since STORY-027.'),
  ('health_checks',      TRUE,  'Health verdicts (STORY-027). System state.'),
  ('outages',            TRUE,  'Outages (STORY-027). System state.'),
  ('pr_voice_watermark', TRUE,  'A single id marking where voice scoring began (STORY-018).'),
  ('outreach_grounding_watermark', TRUE, 'A single id marking where outreach grounding began (STORY-023).'),
  ('tenant_shared_tables', TRUE, 'This list.'),
  ('tenant_system_rows', TRUE, 'Which tables show their system-wide rows to tenants, and why.'),
  ('audit_checkpoints',  FALSE, 'Seals over the whole log, every tenant''s rows together. Verification is a system act (STORY-013).'),
  ('schema_migrations',  FALSE, 'The owner''s record of what ran. Not a tenant''s business.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

-- Every tenant role is a member of this one, which holds the grants on the
-- shared tables. Granted per tenant, those grants grew each shared table's
-- permission list by one entry per author forever — and two tenants provisioned
-- at the same moment collided editing the same list ("tuple concurrently
-- updated", found by two test suites onboarding at once).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ale_tenant') THEN
        CREATE ROLE ale_tenant NOLOGIN;
    END IF;
END
$$;

-- Tables whose rows with no author are system-wide work every tenant may see —
-- a global sweep, a call with no tenant, a message between system agents. A
-- missing author means something different elsewhere: in `users` it is a staff
-- account, in `audit_log` it can be a failed login naming an email. The first
-- version showed every null row to every tenant, and STORY-042's first test
-- found an author reading every admin's account. So null rows are private
-- unless a table is listed here, with the reason.
CREATE TABLE IF NOT EXISTS tenant_system_rows (
    table_name TEXT PRIMARY KEY,
    why        TEXT NOT NULL
);
INSERT INTO tenant_system_rows (table_name, why) VALUES
  ('jobs',           'A global sweep acts on every tenant''s work; GET /jobs has always shown them beside the tenant''s own (STORY-065).'),
  ('api_interactions', 'System-wide calls — the health probe, a directory search with no author — shown beside the tenant''s own (STORY-016).'),
  ('agent_messages', 'Messages between system agents that concern no single tenant (STORY-039).')
ON CONFLICT (table_name) DO UPDATE SET why = EXCLUDED.why;

CREATE OR REPLACE FUNCTION ale_provision_tenant(tenant BIGINT)
RETURNS TABLE (object TEXT, kind TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
    sch   TEXT := 'tenant_' || tenant;
    rol   TEXT := 'ale_tenant_' || tenant;
    t     RECORD;
    fks   TEXT;
    done  TEXT[] := '{}';
    progress BOOLEAN;
BEGIN
    -- One provisioning at a time: they share the group role's grants and the
    -- application login's memberships.
    PERFORM pg_advisory_xact_lock(hashtext('ale_provision_tenant'));

    IF NOT EXISTS (SELECT 1 FROM authors WHERE id = tenant) THEN
        RAISE EXCEPTION 'No author % to provision', tenant;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = rol) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', rol);
    END IF;
    -- The application login may become this role for a request, and nothing
    -- more: membership, not ownership.
    EXECUTE format('GRANT %I TO ale_app_login', rol);
    EXECUTE format('GRANT ale_tenant TO %I', rol);

    -- Rebuilt, not patched: a later migration can add, drop or reorder
    -- columns, and a view over SELECT * does not follow on its own.
    EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', sch);
    EXECUTE format('CREATE SCHEMA %I', sch);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', sch, rol);

    -- The tenant itself.
    EXECUTE format('CREATE VIEW %I.authors WITH (security_barrier) AS SELECT * FROM public.authors WHERE id = %s', sch, tenant);
    done := done || 'authors'::text;
    object := sch || '.authors'; kind := 'tenant row'; RETURN NEXT;

    -- Tables — and views, like escalation_targets (029) — that carry the
    -- tenant directly. The first version walked tables only, and the
    -- escalations page was refused its own view. Where author_id is nullable
    -- the null rows are system-wide — a global sweep, a system alert — and the
    -- application has always shown those to every tenant; the view does too.
    -- (A view's columns are never NOT NULL in the catalogue, so a view is
    -- treated as nullable: it shows the system rows its source table has.)
    FOR t IN
        SELECT c.relname,
               -- "Not null" here means "no system rows": either the column
               -- cannot be null, or null rows are private to nobody-but-staff.
               ((a.attnotnull AND c.relkind = 'r')
                 OR NOT EXISTS (SELECT 1 FROM tenant_system_rows sr WHERE sr.table_name = c.relname)) AS attnotnull
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'author_id' AND NOT a.attisdropped
         WHERE c.relkind IN ('r', 'v') AND c.relname <> 'authors'
         ORDER BY c.relkind, c.relname
    LOOP
        EXECUTE format(
            'CREATE VIEW %I.%I WITH (security_barrier) AS SELECT * FROM public.%I WHERE author_id = %s%s',
            sch, t.relname, t.relname, tenant, CASE WHEN t.attnotnull THEN '' ELSE ' OR author_id IS NULL' END);
        done := done || t.relname::text;
        object := sch || '.' || t.relname;
        kind := CASE WHEN t.attnotnull THEN 'tenant rows' ELSE 'tenant and system-wide rows' END;
        RETURN NEXT;
    END LOOP;

    -- Tables owned through a parent (draft_themes → drafts, approvals → any of
    -- four). A row is the tenant's if any foreign key lands on a row the
    -- tenant's own view of the parent contains. Repeated until nothing new is
    -- covered, so a grandchild follows its child.
    LOOP
        progress := FALSE;
        FOR t IN
            SELECT c.relname,
                   string_agg(format('EXISTS (SELECT 1 FROM %I.%I p WHERE p.%I = x.%I)',
                                     sch, pc.relname, pa.attname, ca.attname), ' OR ') AS cond
              FROM pg_constraint k
              JOIN pg_class c   ON c.oid = k.conrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
              JOIN pg_class pc  ON pc.oid = k.confrelid
              JOIN pg_attribute ca ON ca.attrelid = k.conrelid  AND ca.attnum = k.conkey[1]
              JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = k.confkey[1]
             WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
               AND c.relkind = 'r'
               AND NOT (c.relname = ANY(done))
               -- An explicit classification wins over a foreign key: access
               -- requests reference users, and were being offered to tenants
               -- through them despite being declared operators-only.
               AND NOT EXISTS (SELECT 1 FROM tenant_shared_tables s WHERE s.table_name = c.relname)
               AND pc.relname = ANY(done)
             GROUP BY c.relname
        LOOP
            EXECUTE format('CREATE VIEW %I.%I WITH (security_barrier) AS SELECT x.* FROM public.%I x WHERE %s',
                           sch, t.relname, t.relname, t.cond);
            done := done || t.relname::text;
            object := sch || '.' || t.relname; kind := 'owned through a parent'; RETURN NEXT;
            progress := TRUE;
        END LOOP;
        EXIT WHEN NOT progress;
    END LOOP;

    EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', sch, rol);

    -- Shared reference tables, read in place — through the group role, so
    -- this tenant adds nothing to their permission lists. Declared, never
    -- assumed; a grant on a table since reclassified as unreadable is taken
    -- back.
    FOR t IN
        SELECT s.table_name, s.readable FROM tenant_shared_tables s
          JOIN pg_class c ON c.relname = s.table_name AND c.relkind = 'r'
                         AND c.relnamespace = 'public'::regnamespace
         WHERE NOT (s.table_name = ANY(done))
    LOOP
        IF t.readable THEN
            IF NOT has_table_privilege('ale_tenant', 'public.' || t.table_name, 'SELECT') THEN
                EXECUTE format('GRANT SELECT ON public.%I TO ale_tenant', t.table_name);
            END IF;
            object := 'public.' || t.table_name; kind := 'shared, readable'; RETURN NEXT;
        ELSE
            EXECUTE format('REVOKE ALL ON public.%I FROM ale_tenant', t.table_name);
        END IF;
    END LOOP;
END;
$fn$;

-- The one piece of DDL the application may cause. Not the owner's
-- connection — handing the API that would undo STORY-033 — but permission to
-- execute this function, which runs with the owner's rights and can do exactly
-- one thing: build the schema and role for an author that exists.
REVOKE ALL ON FUNCTION ale_provision_tenant(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ale_provision_tenant(BIGINT) TO ale_app;
GRANT SELECT ON tenant_shared_tables TO ale_app, ale_readonly;

COMMIT;
