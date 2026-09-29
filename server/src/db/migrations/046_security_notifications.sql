-- STORY-052 / REQ-013 — telling the security officer about unauthorized attempts on the audit logs
--
-- Measured before this story: a refused attempt on an audit log was recorded
-- (STORY-044, and from STORY-051 in the security log) and nobody was told. The
-- one alert that existed — five refusals of any kind in ten minutes (STORY-044)
-- — went to admins, after the fifth, about data access in general.
--
-- Now the first refused attempt on an audit log tells every security officer
-- (whoever holds audit.verify) at once, with who, what, when, from where and
-- why it was refused. Further attempts from the same person or address inside
-- ten minutes join that alert rather than sending another. An officer
-- acknowledges it; it stays on the record either way.

BEGIN;

CREATE TABLE IF NOT EXISTS security_notifications (
    id               BIGSERIAL   PRIMARY KEY,
    subject_key      TEXT        NOT NULL,
    subject_label    TEXT        NOT NULL,
    user_id          BIGINT,
    first_log_id     BIGINT      NOT NULL,
    route            TEXT        NOT NULL,
    outcome          TEXT        NOT NULL,
    reason           TEXT,
    attempts         INT         NOT NULL DEFAULT 1 CHECK (attempts >= 1),
    routes_tried     TEXT[]      NOT NULL DEFAULT '{}',
    first_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Who it was meant for, who actually received it, and who it failed for —
    -- not "notified" when a send failed (STORY-038).
    recipients       TEXT[]      NOT NULL DEFAULT '{}',
    delivered        TEXT[]      NOT NULL DEFAULT '{}',
    failed           TEXT[]      NOT NULL DEFAULT '{}',
    acknowledged_by  TEXT,
    acknowledged_at  TIMESTAMPTZ,
    note             TEXT,
    CONSTRAINT security_notifications_ack CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL))
);
CREATE INDEX IF NOT EXISTS security_notifications_open_idx ON security_notifications (last_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS security_notifications_subject_idx ON security_notifications (subject_key, last_at DESC);

GRANT SELECT, INSERT, UPDATE ON security_notifications TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE security_notifications_id_seq TO ale_app;

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('security_notifications', FALSE, 'Alerts to security officers about attempts on the audit logs (STORY-052). Staff only.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
