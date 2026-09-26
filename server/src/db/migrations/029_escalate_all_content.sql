-- STORY-026 / REQ-006 — the independent re-check covers all three content types
--
-- STORY-008 built the Trust and Monitoring Agent on one objection, stated in its
-- own module comment: "an agent that both writes the material and decides
-- whether the material is good enough has no one checking the second half."
--
-- That objection was answered for one content type out of three.
-- `monitorPressMaterials` queries `FROM pr_materials` and nothing else, and it
-- could not have done otherwise: this table has a `pr_material_id` column and no
-- column for a draft or an outreach message. Recording an escalation for a
-- social post was not a missing feature, it was impossible. The same shape 018
-- found in `notifications` and 028 found again for scheduled posts.
--
-- What that costs is not hypothetical. Tighten the voice floor from 0.5 to 0.9 —
-- a reviewer deciding the copy should sound more like the author — and run the
-- monitor:
--
--   pr_materials   MONITORED      examined 2 · re-judged
--   drafts         NOT monitored  examined 0 · 8 would now escalate, and will not
--   outreach       NOT monitored  examined 0
--
-- Eight social posts would reach a human under the new floor and will not,
-- because the only thing that re-derives a decision looks at press. STORY-008's
-- whole argument — that a raised floor must re-judge work already waiting —
-- holds for a third of the system.
--
-- Grown one target at a time, the way `approvals` was in 002/003/017 and
-- `notifications` in 018/028.

BEGIN;

ALTER TABLE escalations ADD COLUMN IF NOT EXISTS draft_id BIGINT
    REFERENCES drafts(id) ON DELETE CASCADE;
ALTER TABLE escalations ADD COLUMN IF NOT EXISTS outreach_message_id BIGINT
    REFERENCES outreach_messages(id) ON DELETE CASCADE;

-- `pr_material_id` was NOT NULL when this table held one kind of thing. It has
-- to become nullable before it can hold three, and the exactly-one constraint
-- is what stops that relaxation from allowing a row about nothing.
ALTER TABLE escalations ALTER COLUMN pr_material_id DROP NOT NULL;

ALTER TABLE escalations DROP CONSTRAINT IF EXISTS escalations_exactly_one_target;
ALTER TABLE escalations ADD CONSTRAINT escalations_exactly_one_target CHECK (
    num_nonnulls(pr_material_id, draft_id, outreach_message_id) = 1
);

-- One escalation per item, whoever noticed first. The press version of this was
-- a UNIQUE on pr_material_id; the other two need their own, and a partial index
-- is what keeps "one per draft" from also meaning "one draft escalation in the
-- whole table" once the column is nullable.
CREATE UNIQUE INDEX IF NOT EXISTS escalations_one_per_draft
    ON escalations (draft_id) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS escalations_one_per_outreach
    ON escalations (outreach_message_id) WHERE outreach_message_id IS NOT NULL;

-- The voice floor in force when the decision was made.
--
-- `threshold_confidence` and `threshold_theme_alignment` are already stored, for
-- the reason STORY-008 gives: a later reader has to be able to see the policy
-- that applied at the time rather than the one that applies now. Voice became a
-- floor for press in STORY-018 and for outreach in STORY-023, and the column
-- recording it was never added — so an escalation raised on voice could not say
-- what the floor had been.
ALTER TABLE escalations ADD COLUMN IF NOT EXISTS threshold_voice NUMERIC(4,3);
ALTER TABLE escalations ADD COLUMN IF NOT EXISTS voice_score NUMERIC(4,3);

-- Which content type an escalation is about, for the read-model. Derived from
-- the three columns rather than trusted as a separate fact, so it cannot
-- disagree with them.
CREATE OR REPLACE VIEW escalation_targets AS
SELECT e.*,
       CASE
           WHEN e.pr_material_id       IS NOT NULL THEN 'pr_material'
           WHEN e.draft_id             IS NOT NULL THEN 'draft'
           WHEN e.outreach_message_id  IS NOT NULL THEN 'outreach_message'
       END AS target_type,
       COALESCE(e.pr_material_id, e.draft_id, e.outreach_message_id) AS target_id
  FROM escalations e;

COMMIT;
