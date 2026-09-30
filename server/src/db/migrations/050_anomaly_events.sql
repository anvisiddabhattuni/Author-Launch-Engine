-- Anomalies, escalated to a person (STORY-059 / REQ-015, REQ-006).
--
-- STORY-014's detectors computed findings when someone opened the dashboard,
-- and forgot them afterwards: nothing was told, nothing had a status, and the
-- same finding could be "new" on every page load. Here a finding becomes an
-- event with a life: detected → escalated (people told, and who) →
-- acknowledged → resolved or dismissed. One open event per thing: a pattern
-- that persists adds to `occurrences` rather than raising a second alarm.
--
-- The acceptance clause is a time: escalated within five minutes. So both
-- times are stored, and the gap is something a check can count.
BEGIN;

CREATE TABLE IF NOT EXISTS anomaly_events (
    id               BIGSERIAL   PRIMARY KEY,
    author_id        BIGINT      REFERENCES authors(id) ON DELETE CASCADE,
    detector         TEXT        NOT NULL,
    -- What makes two detections the same anomaly: detector + subject.
    fingerprint      TEXT        NOT NULL,
    severity         TEXT        NOT NULL CHECK (severity IN ('high', 'medium')),
    summary          TEXT        NOT NULL,
    details          JSONB       NOT NULL DEFAULT '{}',
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    occurrences      INT         NOT NULL DEFAULT 1,
    status           TEXT        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    escalated_at     TIMESTAMPTZ,
    escalated_to     TEXT[]      NOT NULL DEFAULT '{}',
    escalation_failed TEXT[]     NOT NULL DEFAULT '{}',
    acknowledged_by  TEXT,
    acknowledged_at  TIMESTAMPTZ,
    resolved_by      TEXT,
    resolved_at      TIMESTAMPTZ,
    resolution_note  TEXT,
    CONSTRAINT anomaly_ack_pair CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
    CONSTRAINT anomaly_resolved_pair CHECK ((resolved_by IS NULL) = (resolved_at IS NULL)),
    CONSTRAINT anomaly_closed_has_who CHECK (status NOT IN ('resolved', 'dismissed') OR resolved_by IS NOT NULL)
);
-- One live event per anomaly.
CREATE UNIQUE INDEX IF NOT EXISTS anomaly_events_one_live
    ON anomaly_events (fingerprint) WHERE status IN ('open', 'acknowledged');
CREATE INDEX IF NOT EXISTS anomaly_events_author_idx ON anomaly_events (author_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS anomaly_events_unescalated_idx ON anomaly_events (detected_at) WHERE escalated_at IS NULL;

-- Audit rows' tenant and time since a moment, for the volume detector — the
-- clear columns only, like STORY-055's readers; nothing is decrypted.
CREATE OR REPLACE FUNCTION audit_rows_since(since TIMESTAMPTZ)
RETURNS TABLE (tenant_id BIGINT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT s.tenant_id, s.created_at FROM audit_log_sealed s WHERE s.created_at > since
$$;
REVOKE ALL ON FUNCTION audit_rows_since(TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_rows_since(TIMESTAMPTZ) TO ale_app;

GRANT SELECT, INSERT, UPDATE ON anomaly_events TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE anomaly_events_id_seq TO ale_app;

COMMIT;
