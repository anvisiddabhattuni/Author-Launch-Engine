-- STORY-016 / REQ-009 + REQ-004 — the API Integration Agent
--
-- "Interfaces with external APIs" is already true in the sense the acceptance
-- clause tests: adapters exist for the social platforms, email and the
-- directories, each written to the shape of a real client so swapping one in is
-- a change confined to one file, and the demo makes 48 outbound calls.
--
-- Two things were missing, and both are the kind a mock hides.
--
-- The trust clause asks that all API interactions be logged for traceability.
-- None were. The audit log records `post.published` and `outreach.sent` — the
-- *business* events — and never the interaction: which service, which
-- operation, how long it took, what came back, whether it was retried. Those
-- are different facts, and when a platform starts failing it is the second one
-- that tells you.
--
-- And no outbound call had a timeout, a retry policy, or any notion that a 429
-- means something different from a 400. A bare `fetch` in Node has no timeout
-- at all: against a provider that accepts the connection and never answers, it
-- hangs indefinitely — verified, and it hung the process that was testing it.
-- A mock never fails the way a real API fails, so the code around it had never
-- had to be right.

BEGIN;

CREATE TABLE IF NOT EXISTS api_interactions (
    id           BIGSERIAL PRIMARY KEY,

    -- Who was called and what for. `service` is the integration; `operation` is
    -- the thing being asked of it, so a rate limit on one operation is
    -- distinguishable from the whole provider being down.
    service      TEXT NOT NULL,
    operation    TEXT NOT NULL,

    -- One row per *attempt*, not per call. A call that succeeded on its third
    -- try and a call that succeeded first time are very different pictures of a
    -- provider, and collapsing them loses exactly the signal worth having.
    call_id      TEXT NOT NULL,
    attempt      INT  NOT NULL DEFAULT 1,

    outcome      TEXT NOT NULL,
    status       INT,
    duration_ms  INT  NOT NULL,
    -- Whether the failure was worth trying again, as classified at the time.
    -- Stored rather than re-derived: the policy may change, and a decision has
    -- to stay answerable in the terms it was actually made under.
    retryable    BOOLEAN,
    error        TEXT NOT NULL DEFAULT '',

    author_id    BIGINT REFERENCES authors(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT api_interactions_outcome_check CHECK (
        outcome IN ('ok', 'failed', 'retrying', 'timed_out', 'gave_up')
    ),
    CONSTRAINT api_interactions_duration_sane CHECK (duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS api_interactions_service_idx
    ON api_interactions (service, created_at DESC);
CREATE INDEX IF NOT EXISTS api_interactions_call_idx ON api_interactions (call_id);
-- The query an incident starts with: what has been failing, lately.
CREATE INDEX IF NOT EXISTS api_interactions_failures_idx
    ON api_interactions (created_at DESC) WHERE outcome <> 'ok';

COMMENT ON TABLE api_interactions IS
    'One row per attempt at an outbound call. The business event says a post was '
    'published; this says the platform answered 200 in 1.2s on the second try, '
    'which is the fact you need when a provider starts degrading.';

COMMIT;
