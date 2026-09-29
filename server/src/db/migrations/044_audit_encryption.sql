-- STORY-049 / REQ-013 — the audit log, encrypted with AES-256
--
-- STORY-019 declined this, for three reasons, all still true of the obvious
-- way to do it (encrypting in application code):
--   1. the tamper seals (STORY-013) hash row contents;
--   2. governance checks and 40 files read the log in SQL — by action, by
--      tenant, and inside metadata;
--   3. the key would sit in the env file beside DATABASE_URL.
--
-- So the encryption is in the storage, and the application keeps its view:
--
--   audit_log_sealed   the table. Routing columns in the clear (id, actor,
--                      action, entity, tenant, time) so the log can still be
--                      filtered and joined; the entry itself — before, after,
--                      metadata — as one AES-256 ciphertext (pgcrypto,
--                      OpenPGP symmetric, with an integrity check).
--   audit_log          a view of the same columns, decrypted on read and
--                      encrypted on insert. Every existing reader and writer is
--                      unchanged, and the seals hash the same rows they always
--                      did — so editing a ciphertext breaks them.
--
-- The key is not in the database. Each connection the application opens is
-- handed it as a session setting (services/auditKey.js); a connection without
-- it reads empty entries and cannot write one at all.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Encrypts one entry. Refuses without a key: an entry is never stored in the clear.
CREATE OR REPLACE FUNCTION audit_seal(entry JSONB) RETURNS BYTEA
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
    k TEXT := current_setting('ale.audit_key', true);
BEGIN
    IF k IS NULL OR k = '' THEN
        RAISE EXCEPTION 'audit_log: this connection has no encryption key, and an entry is never stored unencrypted'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN pgp_sym_encrypt(entry::text, k, 'cipher-algo=aes256, compress-algo=0, s2k-mode=1');
END;
$$;

-- Decrypts one entry. No key: nothing (NULL). A ciphertext that does not open
-- with the key — edited, or written under another key — says so rather than
-- failing every read of the log.
CREATE OR REPLACE FUNCTION audit_open(sealed BYTEA) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
    k TEXT := current_setting('ale.audit_key', true);
BEGIN
    IF sealed IS NULL OR k IS NULL OR k = '' THEN
        RETURN NULL;
    END IF;
    RETURN pgp_sym_decrypt(sealed, k)::jsonb;
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('metadata', jsonb_build_object('undecryptable', true));
END;
$$;

-- The storage: the old table, renamed, its triggers and indexes with it.
ALTER TABLE audit_log RENAME TO audit_log_sealed;
-- Named apart from author_id so no tenant schema builds a view of raw
-- ciphertext; tenants read their own entries through audit_log, decrypted.
ALTER TABLE audit_log_sealed RENAME COLUMN author_id TO tenant_id;
ALTER TABLE audit_log_sealed ADD COLUMN IF NOT EXISTS payload BYTEA;
ALTER TABLE audit_log_sealed ADD COLUMN IF NOT EXISTS key_id TEXT;

-- Entries already written are encrypted in place — the one time the
-- append-only triggers are lifted, by the schema owner, inside this migration.
ALTER TABLE audit_log_sealed DISABLE TRIGGER audit_log_no_update;
UPDATE audit_log_sealed
   SET payload = audit_seal(jsonb_build_object('before', before, 'after', after, 'metadata', metadata)),
       key_id  = current_setting('ale.audit_key_id', true);
ALTER TABLE audit_log_sealed ENABLE TRIGGER audit_log_no_update;

-- The clear text goes. CASCADE: the tenant schemas' views of the old table,
-- which the migration runner rebuilds over the new view once this commits.
ALTER TABLE audit_log_sealed DROP COLUMN before CASCADE;
ALTER TABLE audit_log_sealed DROP COLUMN after CASCADE;
ALTER TABLE audit_log_sealed DROP COLUMN metadata CASCADE;
ALTER TABLE audit_log_sealed ALTER COLUMN payload SET NOT NULL;
ALTER TABLE audit_log_sealed ALTER COLUMN key_id SET NOT NULL;

-- The view every reader and writer already uses. Same columns, same order.
CREATE VIEW audit_log AS
SELECT s.id,
       s.actor,
       s.action,
       s.entity_type,
       s.entity_id,
       s.tenant_id AS author_id,
       NULLIF(e.entry -> 'before', 'null'::jsonb) AS before,
       NULLIF(e.entry -> 'after', 'null'::jsonb) AS after,
       e.entry -> 'metadata' AS metadata,
       s.created_at
  FROM audit_log_sealed s
  CROSS JOIN LATERAL (SELECT audit_open(s.payload) AS entry) e;

ALTER VIEW audit_log ALTER COLUMN id SET DEFAULT nextval('audit_log_id_seq');
ALTER VIEW audit_log ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;
ALTER VIEW audit_log ALTER COLUMN created_at SET DEFAULT now();

-- Writing through the view encrypts. SECURITY DEFINER: the application
-- cannot touch the storage table at all, only this path into it.
CREATE OR REPLACE FUNCTION audit_log_insert() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    NEW.id := COALESCE(NEW.id, nextval('audit_log_id_seq'));
    NEW.created_at := COALESCE(NEW.created_at, now());
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb);
    INSERT INTO audit_log_sealed (id, actor, action, entity_type, entity_id, tenant_id, payload, key_id, created_at)
    VALUES (NEW.id, NEW.actor, NEW.action, NEW.entity_type, NEW.entity_id, NEW.author_id,
            audit_seal(jsonb_build_object('before', NEW.before, 'after', NEW.after, 'metadata', NEW.metadata)),
            current_setting('ale.audit_key_id', true), NEW.created_at);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION audit_log_insert() FROM PUBLIC;

CREATE TRIGGER audit_log_encrypt INSTEAD OF INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_insert();
-- The view is as append-only as the table under it, with the same words.
CREATE TRIGGER audit_log_view_no_update INSTEAD OF UPDATE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_view_no_delete INSTEAD OF DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

REVOKE ALL ON audit_log_sealed FROM ale_app, ale_readonly;
GRANT SELECT, INSERT ON audit_log TO ale_app;
GRANT SELECT ON audit_log TO ale_readonly;

-- How much of the log is encrypted, under which key, and whether it opens —
-- for the governance check and readiness, which cannot read the storage table.
CREATE OR REPLACE FUNCTION audit_encryption_status()
RETURNS TABLE (entries BIGINT, current_key BIGINT, other_keys BIGINT, unopened BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE key_id = current_setting('ale.audit_key_id', true)),
           COUNT(*) FILTER (WHERE key_id IS DISTINCT FROM current_setting('ale.audit_key_id', true)),
           COUNT(*) FILTER (WHERE audit_open(payload) ? 'metadata' AND audit_open(payload) -> 'metadata' ? 'undecryptable')
      FROM audit_log_sealed;
$$;
GRANT EXECUTE ON FUNCTION audit_encryption_status() TO ale_app, ale_readonly;

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('audit_log_sealed', FALSE, 'The audit log''s encrypted storage (STORY-049). Tenants read their own entries through audit_log, decrypted.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
