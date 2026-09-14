-- STORY-025 / REQ-006 — somebody is told when a post fails to publish
--
-- The story's second acceptance clause: "Given an API call fails; When a post is
-- being scheduled; Then the system logs the error **and notifies the user**."
--
-- The log half has worked since STORY-001 and was made thorough by STORY-016.
-- Measured before writing this, a publish failure produces:
--
--   scheduled_posts.status = 'failed', with the provider's message   yes
--   a post.failed audit row with before/after                        yes
--   a row visible on the Schedule tab, if somebody opens it          yes
--   a notification to anyone                                         NO
--   a governance check that would notice                             NO
--   a place in any queue a human works from                          NO
--
-- So the failure is *recorded* and nobody is *told*. An author whose post
-- silently failed believes it went out, and the only way to learn otherwise is
-- to go looking at a table they have no reason to open. That is the worst shape
-- for an outbound failure: the system knows, and the person it happened to does
-- not.
--
-- The notification schema has no column for a scheduled post, which is why this
-- could not have been a bug in the notifier — it is an absence in the schema,
-- the same finding 018 recorded about drafts. Grown one target at a time, the
-- way `approvals` was in 002, 003 and 017 and `notifications` was in 018.

BEGIN;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS scheduled_post_id BIGINT
    REFERENCES scheduled_posts(id) ON DELETE CASCADE;

-- Read from the live schema rather than copied from 018: that migration records
-- its own first draft silently dropping escalation notifications by restating a
-- constraint from an older version of itself. The full target list as it stands
-- today, plus the new one.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_exactly_one_target;
ALTER TABLE notifications ADD CONSTRAINT notifications_exactly_one_target CHECK (
    num_nonnulls(
        pr_kit_id, escalation_id, draft_id, outreach_message_id,
        mix_recommendation_id, scheduled_post_id
    ) = 1
);

-- One notice per failed post per reviewer, ever. A publish sweep runs on a
-- timer, and a post that failed stays failed — without this, every sweep would
-- re-announce every past failure, which is how an alert channel gets muted.
-- The same rule STORY-012 applied to the approval digest and STORY-021 to a
-- persisting breach.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_failed_post_reviewer
    ON notifications (scheduled_post_id, reviewer_id) WHERE scheduled_post_id IS NOT NULL;

COMMIT;
