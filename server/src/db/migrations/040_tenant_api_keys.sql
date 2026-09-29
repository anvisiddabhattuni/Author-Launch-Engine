-- STORY-045 / REQ-011 — per-tenant API keys
--
-- Measured before this story: the only API key anywhere was the application's
-- own ANTHROPIC_API_KEY, in an environment variable. A tenant's integration —
-- a script pulling approved drafts into a newsletter, say — could reach the
-- API only by signing in as a person, with that person's password and every
-- permission they hold, including approving content.
--
-- A key here belongs to exactly one tenant and acts for the person who made
-- it. The secret is shown once and stored only as its SHA-256: the table is
-- not a list of working keys. Keys expire, can be revoked, and never carry
-- the right to approve — the approval gate stays human.

BEGIN;

CREATE TABLE IF NOT EXISTS tenant_api_keys (
    id           BIGSERIAL   PRIMARY KEY,
    author_id    BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    -- Shown in lists and logs, and used to find the key; not a secret.
    prefix       TEXT        NOT NULL UNIQUE,
    secret_hash  TEXT        NOT NULL UNIQUE,
    name         TEXT        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    access       TEXT        NOT NULL CHECK (access IN ('read', 'read_write')),
    -- The person the key acts for: blocking them (STORY-044) stops it too.
    created_by   BIGINT      NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    revoked_by   BIGINT      REFERENCES users(id),
    CONSTRAINT tenant_api_keys_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days'),
    CONSTRAINT tenant_api_keys_revocation CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE INDEX IF NOT EXISTS tenant_api_keys_tenant_idx ON tenant_api_keys (author_id) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON tenant_api_keys TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE tenant_api_keys_id_seq TO ale_app;

-- Usage is recorded where every other access is (STORY-044), marked with the key.
ALTER TABLE data_access_events ADD COLUMN IF NOT EXISTS api_key_id BIGINT;

COMMIT;
