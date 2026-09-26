-- STORY-027 / REQ-007 — health checks are performed, logged, and acted on
--
-- STORY-015 built `/health` and `/ready` and the `deployments` table, and the
-- acceptance clause here — "when health checks are performed, system status is
-- logged and displayed" — reads as though it were done. Measured before writing
-- this:
--
--   * Nothing performs a health check. Both endpoints answer when asked and
--     the answer is discarded. The audit log has 24 `deployment.*` rows and no
--     row that says a check was ever run.
--   * `deployments` decides an instance is running by whether it wrote a stop
--     row. An instance killed with SIGKILL, or a host that loses power, cannot
--     write one — so the table's answer to "what is running" is really "what
--     has not said goodbye", and it will say `ready` about a dead process
--     forever.
--   * The worker has no row in `deployments` at all. The process that runs
--     every sweep in the system is invisible to the release record.
--   * There is nobody to tell. Every alert this system sends goes to a tenant's
--     `reviewers`, and an outage belongs to no tenant.
--
-- So: instances say they are alive on a timer, a monitor decides who has
-- stopped saying so, each decision is a row, a component changing state is an
-- outage with a start and an end, and the people told about it are the ones
-- holding a permission that says they want to be.
--
-- The same shape as STORY-021's trust episodes — the transition is the event,
-- alerted once — because it was right there and the reasons have not changed.

BEGIN;

-- ---------------------------------------------------------------------------
-- Instances: which process this is, and when it last said so.
-- ---------------------------------------------------------------------------

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS component TEXT NOT NULL DEFAULT 'api';
ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_component_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_component_check
    CHECK (component IN ('api', 'worker'));

-- The heartbeat. Written by the instance itself every few seconds; read by
-- whichever process is doing the checking. An instance whose heartbeat is
-- older than the monitor's tolerance is down whatever its `status` says,
-- because `status` is what it last *claimed* and this is when it last *spoke*.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
-- Rows written before this migration never sent one. Backfilled to the last
-- moment they were known to be alive rather than to now(), so the monitor's
-- first run judges them honestly instead of granting a fresh lease to a row
-- that has been dead since yesterday.
UPDATE deployments SET last_seen_at = COALESCE(ready_at, started_at) WHERE last_seen_at IS NULL;

-- Where an API instance can be probed from outside its own process. Empty for
-- the worker, which serves nothing — its liveness is its heartbeat.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS url TEXT NOT NULL DEFAULT '';

-- What the instance has been doing: request count, error rate, latency over
-- its recent window. Carried on the heartbeat so the dashboard can say "up,
-- and answering in 12ms with 0.4% errors" rather than only "up". An API that
-- answers every request with a 500 is up.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS stats JSONB NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Health checks: one row per target per run. "System status is logged."
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS health_checks (
    id            BIGSERIAL PRIMARY KEY,
    checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Which process ran the check. The API and the worker both do, so that
    -- each can notice the other is gone; a check with no checker on record
    -- cannot answer "who was watching when this happened".
    checked_by    TEXT        NOT NULL DEFAULT '',
    component     TEXT        NOT NULL,
    -- 'database', or the instance string of the deployment checked.
    target        TEXT        NOT NULL,
    deployment_id BIGINT      REFERENCES deployments(id) ON DELETE CASCADE,
    status        TEXT        NOT NULL,
    latency_ms    INT,
    -- Why, in words a person reads: "heartbeat 94s old", "ready", "503:
    -- schema behind". The status is for the dashboard's pill; this is for the
    -- person deciding what to do about it.
    detail        TEXT        NOT NULL DEFAULT '',
    CONSTRAINT health_checks_component_check
        CHECK (component IN ('database', 'api', 'worker')),
    CONSTRAINT health_checks_status_check
        CHECK (status IN ('up', 'degraded', 'down'))
);

CREATE INDEX IF NOT EXISTS health_checks_recent_idx ON health_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS health_checks_target_idx ON health_checks (target, checked_at DESC);

COMMENT ON TABLE health_checks IS
    'One row per target per health-check run. Every status the dashboard shows '
    'has a row here saying when it was measured, by which process, and why.';

-- ---------------------------------------------------------------------------
-- Outages: a component changing state is the event. Alerted once.
-- ---------------------------------------------------------------------------

-- Per *component*, not per instance. The infrastructure team is told "the
-- worker is down", not "worker instance host:41822 is down" — one instance of
-- three dying is a degraded component, and a page for it at 3am is how a
-- pager gets muted.
CREATE TABLE IF NOT EXISTS outages (
    id           BIGSERIAL PRIMARY KEY,
    component    TEXT        NOT NULL,
    -- When it was last known to be up, and when the monitor noticed. The gap
    -- between them is the number that says how good the monitoring is; an
    -- outage that started at 02:00 and was detected at 09:00 was not being
    -- monitored, whatever the dashboard said.
    down_since   TIMESTAMPTZ NOT NULL,
    detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    detected_by  TEXT        NOT NULL DEFAULT '',
    resolved_at  TIMESTAMPTZ,
    alerted_at   TIMESTAMPTZ,
    reason       TEXT        NOT NULL DEFAULT '',
    CONSTRAINT outages_component_check
        CHECK (component IN ('database', 'api', 'worker'))
);

-- One open outage per component, whoever noticed first. The API's monitor and
-- the worker's sweep can both detect the same failure in the same minute, and
-- ON CONFLICT DO NOTHING against this is what makes that one episode rather
-- than two alerts.
CREATE UNIQUE INDEX IF NOT EXISTS outages_one_open_per_component
    ON outages (component) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS outages_recent_idx ON outages (detected_at DESC);

COMMENT ON TABLE outages IS
    'A component that stopped answering, from when to when, and whether anyone '
    'was told. Resolved when a check finds it up again — never by time passing.';

-- ---------------------------------------------------------------------------
-- Who gets told. A permission, because a role name cannot answer it.
-- ---------------------------------------------------------------------------

-- "Alerts are sent to the infrastructure team." Every other alert here goes to
-- a tenant's reviewers, and an outage has no tenant. The recipients are the
-- accounts that hold this — granted to admin, and grantable to an on-call role
-- later without touching a route (STORY-019's argument, again).
INSERT INTO permissions (name, description) VALUES
    ('system.operate',
     'Run health checks on demand and be told when a component goes down. The infrastructure team, as a capability rather than a job title.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role, permission) VALUES
    ('admin', 'system.operate')
ON CONFLICT DO NOTHING;

COMMIT;
