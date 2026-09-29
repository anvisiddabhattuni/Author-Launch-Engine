-- STORY-039 / REQ-010 — agents tell each other things
--
-- Measured before this migration: eleven agents, and not one message between
-- them. They reach each other two ways. Direct function calls — the caller
-- waits, and a failure in the callee is the caller's failure. And polling:
-- a recurring sweep that scans a table every five minutes for something to do.
--
-- Polling is reliable — a sweep finds whatever is there — and it is slow and
-- anonymous. When the Trust and Monitoring Agent escalates a draft, the
-- reviewer's email waits for the next `trust.monitor_escalations` sweep, up to
-- 300 seconds, and nothing records that one agent told another anything. The
-- audit log says an escalation was raised and, separately, that an email went
-- out; which caused which is inferred from timestamps.
--
-- This is the queue. Postgres rather than RabbitMQ, which the story names:
-- RabbitMQ is not installed here, and a message written in the *same
-- transaction* as the state change it describes cannot be lost between the two
-- — the outbox pattern. A broker alone cannot give that; a broker in front of
-- this table can, which is why `messageBus.js` has a transport seam for one.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_messages (
    id            BIGSERIAL   PRIMARY KEY,
    -- Stable across redelivery, so a consumer can tell a repeat from a new one.
    message_id    UUID        NOT NULL UNIQUE,
    topic         TEXT        NOT NULL,
    sender        TEXT        NOT NULL,
    recipient     TEXT        NOT NULL,
    payload       JSONB       NOT NULL DEFAULT '{}',
    author_id     BIGINT      REFERENCES authors(id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'queued',
    attempts      INT         NOT NULL DEFAULT 0,
    max_attempts  INT         NOT NULL DEFAULT 5,
    -- Not deliverable before this. Doubles as the visibility deadline: a
    -- message delivered and never acknowledged becomes available again here,
    -- so a consumer that dies mid-handler does not lose it.
    available_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ,
    acked_at      TIMESTAMPTZ,
    last_error    TEXT        NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_messages_status_check
        CHECK (status IN ('queued', 'delivered', 'acked', 'dead_letter')),
    CONSTRAINT agent_messages_not_to_self CHECK (sender <> recipient)
);

-- The question a consumer asks on every poll: what is waiting for me.
CREATE INDEX IF NOT EXISTS agent_messages_inbox_idx
    ON agent_messages (recipient, available_at) WHERE status IN ('queued', 'delivered');
CREATE INDEX IF NOT EXISTS agent_messages_recent_idx ON agent_messages (created_at DESC);

COMMENT ON TABLE agent_messages IS
    'Messages between agents. Written in the sender''s transaction, delivered at least '
    'once, acknowledged by the recipient, dead-lettered after max_attempts.';

COMMIT;
