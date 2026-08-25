-- STORY-008 / REQ-003 — escalation of low-confidence PR drafts
--
-- Escalation itself already worked: a material below the confidence threshold or
-- the theme-alignment floor landed 'escalated' and waited for a human. What did
-- not exist was the agent the story names. The drafter decided its own fate —
-- the same object that produced the work also judged whether the work was good
-- enough — which is the "the model grades itself" problem one level up, at the
-- agent layer. If a producer's check were wrong, or missing, nothing noticed.
--
-- This table is the record of detections, and the read-model the story's slice
-- asks for: what was escalated, why, and — the part that could not be answered
-- before — whether the producer and an independent check agreed about it.

BEGIN;

CREATE TABLE IF NOT EXISTS escalations (
    id             BIGSERIAL PRIMARY KEY,
    author_id      BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    -- Same nullable-FK-plus-exactly-one shape as approvals and notifications.
    -- STORY-008 is scoped to press materials; adding social drafts or outreach
    -- later is one column and one name in the check.
    pr_material_id BIGINT      REFERENCES pr_materials(id) ON DELETE CASCADE,
    reasons        TEXT[]      NOT NULL DEFAULT '{}',
    -- The scores as they stood when this was detected. Kept on the row because
    -- a threshold change later must not silently rewrite the past: this is what
    -- the decision was actually made on.
    confidence      NUMERIC(4,3),
    theme_alignment NUMERIC(4,3),
    threshold_confidence      NUMERIC(4,3) NOT NULL,
    threshold_theme_alignment NUMERIC(4,3) NOT NULL,
    -- 'producer'  — the drafting agent escalated it itself, and the monitor agrees.
    -- 'monitor'   — the drafting agent let it through and the monitor caught it.
    detected_by    TEXT        NOT NULL,
    producer_status TEXT       NOT NULL,
    monitor_status  TEXT       NOT NULL,
    -- False when the two disagreed. A disagreement is the finding: it means a
    -- producer applied a different rule from the one now in force.
    agreed         BOOLEAN     NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT escalations_exactly_one_target CHECK (num_nonnulls(pr_material_id) = 1),
    CONSTRAINT escalations_detected_by_check CHECK (detected_by IN ('producer', 'monitor')),
    -- One record per material. The monitor re-runs on a schedule and must not
    -- pile up a row per sweep for the same finding.
    CONSTRAINT escalations_one_per_material UNIQUE (pr_material_id)
);

CREATE INDEX IF NOT EXISTS escalations_author_idx ON escalations (author_id);
CREATE INDEX IF NOT EXISTS escalations_disagreed_idx ON escalations (agreed) WHERE NOT agreed;

COMMENT ON TABLE escalations IS
    'Detections, not state. Whether an escalation is still open is read from the '
    'material''s own status, so the two can never drift out of sync.';

-- Third notification target. A reviewer being told "something is waiting" is
-- STORY-007; being told "the monitor caught something the drafter let through"
-- is different news, and only fires when the monitor actually disagreed.
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS escalation_id BIGINT REFERENCES escalations(id) ON DELETE CASCADE;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_exactly_one_target;
ALTER TABLE notifications
    ADD CONSTRAINT notifications_exactly_one_target
    CHECK (num_nonnulls(pr_kit_id, escalation_id) = 1);

-- The STORY-007 constraint only covered kits; escalations need their own.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_one_per_reviewer_per_kit;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_reviewer_per_kit
    ON notifications (pr_kit_id, reviewer_id) WHERE pr_kit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_one_per_reviewer_per_escalation
    ON notifications (escalation_id, reviewer_id) WHERE escalation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_escalation_idx ON notifications (escalation_id);

COMMIT;
