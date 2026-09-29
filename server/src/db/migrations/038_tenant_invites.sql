-- STORY-043 / REQ-011 — onboarding by invitation
--
-- STORY-017 built onboarding as an API call, and STORY-041/042 made it create
-- the tenant's schema and refuse elevated roles. Measured against this story:
--
--   * No screen. The story asks for one for the admin; there was only the API.
--   * No email to the new author.
--   * The audit row named `TenantManagementAgent`, not the admin who did it —
--     the story's trust line asks for the admin's id.
--   * And the one the story does not name: the admin chose the author's
--     password. The admin knew the author's credential, and it had to reach the
--     author some other way — pasted into a chat, most likely. An onboarding
--     that is "quick and secure" cannot start with somebody else knowing your
--     password.
--
-- So the account is created with no password at all, and the author gets a
-- one-time link to set their own: stored as a hash, single use, expiring.

BEGIN;

-- An account that exists and cannot sign in until its owner sets a password.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_invites (
    id           BIGSERIAL   PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id    BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    -- SHA-256 of the token. The token itself exists only in the email; a copy
    -- of this table is not a set of working invitations.
    token_hash   TEXT        NOT NULL UNIQUE,
    created_by   BIGINT      REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    -- A resend replaces the previous invitation; the old link stops working.
    revoked_at   TIMESTAMPTZ,
    CONSTRAINT tenant_invites_expiry_after_creation CHECK (expires_at > created_at)
);

-- One live invitation per account: a resend must retire the last one first.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_invites_one_live
    ON tenant_invites (user_id) WHERE used_at IS NULL AND revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON tenant_invites TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE tenant_invites_id_seq TO ale_app;

COMMIT;
