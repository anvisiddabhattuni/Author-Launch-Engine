-- The search index (STORY-055 / REQ-015, REQ-001, REQ-002).
--
-- The trust dashboard's logs and metrics are copied into Elasticsearch so they
-- can be searched and charted at volume. Two things here make that copy safe.
--
-- 1. What the index may see. STORY-049 encrypted each audit entry's before,
--    after and metadata, because they carry what was written and to whom. The
--    index gets only the columns that were already stored in the clear — who,
--    did what, to which record, for which tenant, when — through functions that
--    read the storage tables *without* decrypting. The encrypted part never
--    leaves Postgres; a search hit links back to the row by id. The same for
--    the security log (no email, no IP) and the data access log.
--
-- 2. How the copy is checked. `search_sync` keeps, per source, how far the
--    index has got and what the last reconciliation found. A batch advances the
--    mark only after every document in it has been read back from the index and
--    its digest matched; reconciliation compares counts and fills any gap.
BEGIN;

CREATE TABLE IF NOT EXISTS search_sync (
    source          TEXT        PRIMARY KEY,
    index_name      TEXT        NOT NULL,
    last_id         BIGINT      NOT NULL DEFAULT 0,
    indexed_total   BIGINT      NOT NULL DEFAULT 0,
    last_run_at     TIMESTAMPTZ,
    last_batch      INT         NOT NULL DEFAULT 0,
    last_took_ms    INT,
    -- Reconciliation: rows in Postgres up to the mark, documents in the index.
    reconciled_at   TIMESTAMPTZ,
    source_count    BIGINT,
    index_count     BIGINT,
    repaired_total  BIGINT      NOT NULL DEFAULT 0,
    -- When the index was found missing and rebuilt from the start.
    rebuilt_at      TIMESTAMPTZ,
    last_error      TEXT
);
GRANT SELECT, INSERT, UPDATE ON search_sync TO ale_app;

-- Audit rows for the index: the clear columns only. SECURITY DEFINER because
-- the application cannot read the storage table (STORY-049), and reading
-- through the view would decrypt every row just to throw the result away.
CREATE OR REPLACE FUNCTION audit_index_rows(after_id BIGINT, max_rows INT, upto_id BIGINT DEFAULT NULL)
RETURNS TABLE (id BIGINT, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, author_id BIGINT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT s.id, s.actor, s.action, s.entity_type, s.entity_id, s.tenant_id, s.created_at
      FROM audit_log_sealed s
     WHERE s.id > after_id AND (upto_id IS NULL OR s.id <= upto_id)
     ORDER BY s.id
     LIMIT max_rows
$$;
CREATE OR REPLACE FUNCTION audit_index_count(upto_id BIGINT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COUNT(*) FROM audit_log_sealed WHERE id <= upto_id
$$;

-- Entries since a time, for one tenant or all: the metrics snapshot's count.
CREATE OR REPLACE FUNCTION audit_entries_since(since TIMESTAMPTZ, tenant BIGINT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COUNT(*) FROM audit_log_sealed WHERE created_at > since AND (tenant IS NULL OR tenant_id = tenant)
$$;

CREATE OR REPLACE FUNCTION security_index_rows(after_id BIGINT, max_rows INT, upto_id BIGINT DEFAULT NULL)
RETURNS TABLE (id BIGINT, occurred_at TIMESTAMPTZ, method TEXT, route TEXT, outcome TEXT, status INT, user_id BIGINT, author_id BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT s.id, s.occurred_at, s.method, s.route, s.outcome, s.status, s.user_id, s.tenant_id
      FROM security_log_sealed s
     WHERE s.id > after_id AND (upto_id IS NULL OR s.id <= upto_id)
     ORDER BY s.id
     LIMIT max_rows
$$;
CREATE OR REPLACE FUNCTION security_index_count(upto_id BIGINT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COUNT(*) FROM security_log_sealed WHERE id <= upto_id
$$;

REVOKE ALL ON FUNCTION audit_index_rows(BIGINT, INT, BIGINT), audit_index_count(BIGINT), audit_entries_since(TIMESTAMPTZ, BIGINT),
                       security_index_rows(BIGINT, INT, BIGINT), security_index_count(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_index_rows(BIGINT, INT, BIGINT), audit_index_count(BIGINT), audit_entries_since(TIMESTAMPTZ, BIGINT),
                          security_index_rows(BIGINT, INT, BIGINT), security_index_count(BIGINT) TO ale_app;

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('search_sync', FALSE, 'How far the search index has got, per source (STORY-055). System state, staff only.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
