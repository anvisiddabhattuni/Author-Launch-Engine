-- STORY-040 / REQ-010 — tasks assigned by priority *and* availability, and
-- every assignment reviewable
--
-- STORY-011 built the coordinator: a priority per job kind and an exclusive
-- resource, recorded on each dispatch. Measured before this migration:
--
--   * Deferrals were never recorded. `recordDispatch` has a branch for "held
--     back because another agent holds its resource", documented as the
--     interesting half — and nothing calls it. A job passed over leaves no
--     trace, which makes a stalled queue indistinguishable from an empty one.
--   * Two job kinds had no declared priority and fell to the default, whose
--     recorded reason — "produces work other agents react to" — is false for
--     both. The review trail misdescribed them.
--   * Availability meant only "is the resource held". Nothing knew that an
--     agent's work needs an integration. With email's circuit open
--     (STORY-038), `approvals.notify_waiting` ran anyway: both sends were
--     refused by the gateway, the notifier recorded them as announced, and the
--     job reported "notified: 2". Those items are never announced — the
--     notifier deliberately does not re-announce a failed send.
--
-- So: every job carries the agent it is assigned to and the integrations it
-- needs; a job whose integration is down waits (without spending an attempt)
-- until the circuit will accept a trial; and every wait is recorded once, with
-- its reason.

BEGIN;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS agent TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requires TEXT[] NOT NULL DEFAULT '{}';
-- Why this job is waiting, if it is. Written when the reason changes, so a job
-- that waits for an hour is one audit row, not seven hundred.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deferred_reason TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ;

-- When an open circuit will let one call through (STORY-038). Stored so the
-- task manager can hold work until then — and release it then, because a job
-- held while the circuit is open is the only thing that would ever make the
-- trial call. Deferring past this would be a deadlock.
ALTER TABLE integration_circuits ADD COLUMN IF NOT EXISTS retry_at TIMESTAMPTZ;

COMMIT;
