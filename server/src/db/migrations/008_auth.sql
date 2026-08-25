-- STORY-064 / REQ-005 — login and basic permissions (thin slice)
--
-- Every story so far has assumed an identity the system never had. The masthead
-- rendered "Signed in as …" over `authors[0]`. Approvals recorded a reviewer
-- name typed into a text box, so the audit log held a *claim* about who decided,
-- not a fact. And every list route took its tenant from a query parameter the
-- caller supplied, so any client could read any author's data by changing a
-- number in the URL.
--
-- This is the identity foundation the whole approval-gate model was already
-- built on top of. Deliberately thin: full RBAC stays STORY-022 in R5. What
-- lands here is a real session, two roles, and an approval that can name a
-- person the system actually authenticated.

BEGIN;

-- Minimal role lookup rather than a free-text column, so the set is closed and
-- adding a third role later is a row rather than a migration to every check.
-- This is not RBAC: there are no per-resource permissions here, only the one
-- distinction the tenant boundary needs.
CREATE TABLE IF NOT EXISTS roles (
    name        TEXT PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO roles (name, description) VALUES
    ('author', 'Signs in to one tenant. Sees and decides on that author''s work only.'),
    ('admin',  'Operator. May read across tenants; still cannot approve anonymously.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- Who can sign in. Separate from `reviewers` on purpose: a publicist who gets
-- emailed about a pending kit does not need a login, and STORY-007's address
-- book must not quietly become the access list. Where the same person is both,
-- reviewers.user_id links them rather than duplicating them.
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    name          TEXT        NOT NULL,
    -- scrypt, salted per user. Stored as "scrypt$N$r$p$salt$hash" so the work
    -- factors travel with the hash and can be raised without invalidating rows
    -- that were written under the old ones.
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL REFERENCES roles(name),
    -- The tenant this user belongs to. An admin may have none, which is what
    -- lets them read across tenants; an author without one could see nothing at
    -- all, which is a broken account rather than a safe default.
    author_id     BIGINT      REFERENCES authors(id) ON DELETE CASCADE,
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_author_needs_tenant CHECK (role = 'admin' OR author_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS users_author_idx ON users (author_id);

-- The same human, if they both sign in and get notified. Nullable because most
-- reviewers will never have an account, which is the entire reason the two
-- tables are not one.
ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Who actually decided, as opposed to who the form said decided.
--
-- `reviewer` is kept, not replaced. Rows written before this story hold a name
-- somebody typed, and rewriting them to point at a user would be inventing a
-- fact the system never established — the same refusal as not guessing an award
-- result. New decisions carry both: the authenticated identity, and the display
-- name that identity had at the time.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS approvals_user_idx ON approvals (user_id);

COMMENT ON COLUMN approvals.reviewer IS
    'Display name of the decider. Before STORY-064 this was free text typed into '
    'the UI and was the only record of who decided; from STORY-064 it is the name '
    'of the authenticated user in user_id. Historical rows are left as written.';

COMMIT;
