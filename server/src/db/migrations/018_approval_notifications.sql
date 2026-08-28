-- STORY-012 / REQ-005 + REQ-004 — the Approval and Notification Agent handles
-- approvals for all drafts
--
-- Half of this story has worked since STORY-001. Nothing reaches a platform
-- without a human decision: `scheduleDraft`, `sendOutreachMessage` and
-- `distributePressKit` each refuse unapproved work, and the gate has grown to
-- four targets without ever being forked.
--
-- The other half is the word "and". The clause is that the agent holds the draft
-- *and sends a notification*, and notification exists for exactly one of the
-- four things a human approves. This table's own constraint says so:
--
--     CONSTRAINT notifications_exactly_one_target CHECK (num_nonnulls(pr_kit_id) = 1)
--
-- There is no column for a draft. A social post can sit in `pending_approval`
-- for a week and there is no mechanism by which anyone could be told — not a
-- bug in the notifier, an absence in the schema. On a freshly seeded database
-- with five social drafts and three outreach messages waiting, the number of
-- notifications that have ever been sent about any of them is zero, and could
-- not be anything else.
--
-- Grown one target at a time, the way `approvals` was in 002, 003 and 017.

BEGIN;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS draft_id BIGINT
    REFERENCES drafts(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS outreach_message_id BIGINT
    REFERENCES outreach_messages(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS mix_recommendation_id BIGINT
    REFERENCES mix_recommendations(id) ON DELETE CASCADE;

-- `escalation_id` is in this list because STORY-008 added it in 010. Redefining
-- a constraint means restating every target it has grown, and the first draft of
-- this migration copied the version from 007 — silently dropping escalation
-- notifications, which the suite caught immediately. A grown constraint has to
-- be read from the live schema, not from the migration that first created it.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_exactly_one_target;
ALTER TABLE notifications ADD CONSTRAINT notifications_exactly_one_target CHECK (
    num_nonnulls(
        pr_kit_id, escalation_id, draft_id, outreach_message_id, mix_recommendation_id
    ) = 1
);

-- One announcement per reviewer per item, matching what STORY-007 already
-- guarantees for kits. This is what stops a sweep every five minutes from
-- telling the same person about the same draft 288 times a day — which would be
-- worse than not telling them at all, because it trains them to stop reading.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_draft_reviewer
    ON notifications (draft_id, reviewer_id) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_outreach_reviewer
    ON notifications (outreach_message_id, reviewer_id) WHERE outreach_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_mix_reviewer
    ON notifications (mix_recommendation_id, reviewer_id) WHERE mix_recommendation_id IS NOT NULL;

-- Which send a row belongs to.
--
-- STORY-007's model is one email per kit, which is right for a press kit: they
-- are rare and each is a decision on its own. It is wrong for social drafts,
-- which arrive four at a time every week — the same model there is four emails
-- a week per reviewer, and a reviewer with four emails about four drafts reads
-- none of them. Rows stay per-item so idempotency and the audit trail keep
-- working; `batch_id` is what lets one email carry all of them.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS batch_id TEXT;

CREATE INDEX IF NOT EXISTS notifications_batch_idx ON notifications (batch_id);

COMMENT ON COLUMN notifications.batch_id IS
    'Rows written by one digest share this. One email, many items — per-item '
    'rows keep the idempotency guarantee that stops an item being announced '
    'twice.';

COMMIT;
