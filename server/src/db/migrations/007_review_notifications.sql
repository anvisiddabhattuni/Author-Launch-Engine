-- STORY-007 / REQ-003 + REQ-006 — human review of PR drafts
--
-- STORY-003 built the review itself: the interface, the approve/reject actions,
-- the decisions in Postgres, the audit trail. Four of this story's five build
-- steps were already done, and its Gherkin already passed. The fifth was never
-- started — `grep -ri notif` over the repo returned nothing — and it is half of
-- REQ-006's acceptance criteria: "the approval process includes notifications to
-- relevant stakeholders and is logged for traceability."
--
-- The obstacle was that the system had no one to notify. There is no login and
-- no RBAC, so a "reviewer" was a name typed into a text box at the moment of
-- deciding — the system learned who reviewed something only after they had
-- already done it. You cannot alert a person you do not know exists yet.
--
-- So the reviewer becomes data. This is an address book, not an authorization
-- list: knowing who to *tell* is a different fact from knowing who someone *is*,
-- and only the first is needed to stop a draft sitting unread. RBAC stays a
-- named gap rather than being smuggled in here.

BEGIN;

-- Who to tell when work is waiting. Deliberately not a users table: no
-- password, no session, no permissions. Nothing here decides what anyone is
-- allowed to do — `approvals.reviewer` still records who actually decided, and
-- it is still free text, because a notification list that quietly became an
-- access list would be a security control nobody designed.
CREATE TABLE IF NOT EXISTS reviewers (
    id         BIGSERIAL PRIMARY KEY,
    author_id  BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    email      TEXT        NOT NULL,
    -- Free text: "publisher", "publicist", "the author". REQ-006 says "relevant
    -- stakeholders", and which stakeholders are relevant is the author's call.
    role       TEXT        NOT NULL DEFAULT 'reviewer',
    -- Someone who has left the project stops being notified without losing the
    -- notifications already sent to them, which the audit log still points at.
    active     BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reviewers_one_email_per_author UNIQUE (author_id, email)
);

CREATE INDEX IF NOT EXISTS reviewers_author_idx ON reviewers (author_id);

-- One notification, to one reviewer, about one thing waiting.
--
-- The nullable-FK-plus-exactly-one pattern is the same one `approvals` uses,
-- and for the same reason: a polymorphic entity_id would lose referential
-- integrity, and adding the next target (social drafts, outreach batches) costs
-- one column and one name in the check. STORY-007 is scoped to PR drafts, so
-- pr_kit_id is the only target that exists yet.
CREATE TABLE IF NOT EXISTS notifications (
    id          BIGSERIAL PRIMARY KEY,
    author_id   BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    reviewer_id BIGINT      NOT NULL REFERENCES reviewers(id) ON DELETE CASCADE,
    pr_kit_id   BIGINT      REFERENCES pr_kits(id) ON DELETE CASCADE,
    channel     TEXT        NOT NULL DEFAULT 'email',
    subject     TEXT        NOT NULL,
    body        TEXT        NOT NULL,
    -- How many materials were waiting when the alert went out. Kept on the row
    -- so a reviewer opening a week-old notification can see it described a
    -- different pile than the one they are looking at now.
    pending_count INT       NOT NULL DEFAULT 0,
    status      TEXT        NOT NULL DEFAULT 'queued',
    external_id TEXT,
    sent_at     TIMESTAMPTZ,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT notifications_exactly_one_target CHECK (num_nonnulls(pr_kit_id) = 1),
    CONSTRAINT notifications_status_check CHECK (status IN ('queued', 'sent', 'failed')),
    CONSTRAINT notifications_channel_check CHECK (channel IN ('email')),
    -- One nudge per reviewer per kit. Re-running the notifier must not re-mail
    -- a reviewer who has simply not got to it yet: an alert that arrives every
    -- time a cron fires is an alert people learn to ignore, which costs exactly
    -- the attention the approval gate is spending.
    CONSTRAINT notifications_one_per_reviewer_per_kit UNIQUE (pr_kit_id, reviewer_id)
);

CREATE INDEX IF NOT EXISTS notifications_author_idx ON notifications (author_id);
CREATE INDEX IF NOT EXISTS notifications_kit_idx ON notifications (pr_kit_id);

COMMIT;
