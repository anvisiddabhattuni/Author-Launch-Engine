-- STORY-015 / REQ-008 + REQ-004 — the Infrastructure and Deployment Agent
--
-- The acceptance clause asks for deployment to a public demo URL using Docker,
-- and that half cannot be done from here: there is no cloud account, no
-- credentials, and Docker is not installed on this machine. Pretending
-- otherwise by committing a Dockerfile and calling the story done would be the
-- worst outcome — a green tick over an untested claim.
--
-- What *is* buildable and verifiable here is the half the trust clause names:
-- "deployment logs are maintained for rollback and audit purposes". A release
-- that cannot be identified cannot be rolled back to, and every operational
-- question during an incident starts with "what is actually running".
--
-- The other genuinely local piece is readiness. `/health` has always answered
-- for the process; nothing has ever answered "is this instance safe to send
-- traffic to", and those are different questions with different consequences —
-- an instance whose code expects a migration that has not been applied is up
-- and must not be routed to.

BEGIN;

CREATE TABLE IF NOT EXISTS deployments (
    id             BIGSERIAL PRIMARY KEY,
    -- What is running. `commit` is the answer to the first question of any
    -- incident, and the reason a release record exists at all.
    version        TEXT NOT NULL,
    commit_sha     TEXT NOT NULL DEFAULT '',
    environment    TEXT NOT NULL DEFAULT 'development',

    -- The schema this release expects, recorded at boot. A rollback that moves
    -- the code back without the schema is the rollback that takes the site
    -- down, and this is what makes that visible before it is attempted.
    migrations_expected INT NOT NULL DEFAULT 0,
    migrations_applied  INT NOT NULL DEFAULT 0,

    status         TEXT NOT NULL DEFAULT 'starting',
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at       TIMESTAMPTZ,
    stopped_at     TIMESTAMPTZ,
    -- Why it stopped, when it stopped on purpose. A clean shutdown and a crash
    -- look identical in a status column, and are very different events.
    stop_reason    TEXT NOT NULL DEFAULT '',
    -- Which process this is, so two instances of one release are two rows.
    instance       TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    CONSTRAINT deployments_status_check CHECK (
        status IN ('starting', 'ready', 'degraded', 'stopped', 'crashed')
    )
);

CREATE INDEX IF NOT EXISTS deployments_recent_idx ON deployments (started_at DESC);
-- The question asked most often: what is live in this environment right now.
CREATE INDEX IF NOT EXISTS deployments_live_idx
    ON deployments (environment, started_at DESC) WHERE stopped_at IS NULL;

COMMENT ON TABLE deployments IS
    'One row per running instance. Answers "what is running, since when, against '
    'which schema" — the first question of any incident and the precondition for '
    'a rollback that does not make things worse.';

COMMIT;
