-- Text messages through Twilio (STORY-037 / REQ-009, REQ-013).
--
-- A reviewer may give a mobile number; when approvals are waiting they get a
-- short text as well as the email digest. Every text is a row here — what was
-- sent, to whom, why, how many attempts it took and what Twilio said — so
-- "was the reviewer told?" has an answer that does not depend on Twilio's logs.
--
-- A text that fails because Twilio is down is not lost: it waits in
-- 'retrying' with a time for the next attempt, and a job sends it then.
BEGIN;

ALTER TABLE reviewers ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE reviewers DROP CONSTRAINT IF EXISTS reviewers_phone_e164;
-- E.164: a plus, a country code, up to fifteen digits. What Twilio accepts.
ALTER TABLE reviewers ADD CONSTRAINT reviewers_phone_e164 CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');

CREATE TABLE IF NOT EXISTS sms_messages (
    id               BIGSERIAL   PRIMARY KEY,
    author_id        BIGINT      REFERENCES authors(id) ON DELETE CASCADE,
    reviewer_id      BIGINT      REFERENCES reviewers(id) ON DELETE SET NULL,
    to_number        TEXT        NOT NULL CHECK (to_number ~ '^\+[1-9][0-9]{7,14}$'),
    body             TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 320),
    purpose          TEXT        NOT NULL,
    via              TEXT        NOT NULL,
    batch_id         UUID,
    status           TEXT        NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'sent', 'retrying', 'failed')),
    attempts         INT         NOT NULL DEFAULT 0,
    twilio_sid       TEXT,
    last_error       TEXT,
    next_attempt_at  TIMESTAMPTZ,
    sent_at          TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT sms_sent_has_sid CHECK (status <> 'sent' OR twilio_sid IS NOT NULL),
    CONSTRAINT sms_failure_named CHECK (status NOT IN ('retrying', 'failed') OR last_error IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS sms_messages_author_idx ON sms_messages (author_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON sms_messages TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE sms_messages_id_seq TO ale_app;

COMMIT;
