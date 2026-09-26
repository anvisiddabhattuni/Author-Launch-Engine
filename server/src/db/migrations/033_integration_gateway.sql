-- STORY-038 / REQ-009, REQ-014 — the gateway manages every integration, and
-- says when one has failed
--
-- STORY-016 built `callExternal`: timeouts, retries by status, a row per
-- attempt. Its own header says every outbound call goes through it — "the
-- social platforms, the email provider, the directory search, and the
-- Anthropic content API". Measured before this migration:
--
--   * The directory search did not. All three directories behind opportunity
--     scouting were called directly — no timeout, no retry, no row — so they
--     never appeared on the Trust tab's integrations panel, and a live
--     directory that hung would hang the scout with it.
--   * One policy for every service. A 10-second timeout suits email and kills
--     an AI generation that takes twenty.
--   * A failure was logged and nobody was told. `api.call_failed` went to the
--     audit log and stopped there. A provider that was down got three attempts
--     with backoff on every call, for as long as it stayed down.
--
-- So: a declared route per integration with its own policy, a circuit per
-- integration that stops calling a provider that has stopped answering, and an
-- alert to the operators when one opens.

BEGIN;

-- A call the gateway refused to make because the circuit was open. Its own
-- outcome, so the dashboard can tell "the provider failed" from "we did not
-- ask it" — the second is the gateway working.
ALTER TABLE api_interactions DROP CONSTRAINT IF EXISTS api_interactions_outcome_check;
ALTER TABLE api_interactions ADD CONSTRAINT api_interactions_outcome_check CHECK (
    outcome IN ('ok', 'failed', 'retrying', 'timed_out', 'gave_up', 'short_circuited')
);

-- One row per integration. In the database rather than in memory because the
-- API and the worker both call out: a circuit only one process knows is open
-- is a circuit the other keeps hammering through.
CREATE TABLE IF NOT EXISTS integration_circuits (
    service              TEXT PRIMARY KEY,
    state                TEXT        NOT NULL DEFAULT 'closed',
    -- Calls that failed after all their retries, in a row. A single success
    -- resets it: one bad minute is not an outage.
    consecutive_failures INT         NOT NULL DEFAULT 0,
    opened_at            TIMESTAMPTZ,
    last_failure_at      TIMESTAMPTZ,
    last_error           TEXT        NOT NULL DEFAULT '',
    last_success_at      TIMESTAMPTZ,
    -- Once per opening, never per failed call.
    alerted_at           TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT integration_circuits_state_check CHECK (state IN ('closed', 'open', 'half_open'))
);

COMMENT ON TABLE integration_circuits IS
    'Per-integration circuit breaker, shared by every process that calls out. '
    'Open means the gateway is refusing calls to a provider that stopped answering.';

COMMIT;
