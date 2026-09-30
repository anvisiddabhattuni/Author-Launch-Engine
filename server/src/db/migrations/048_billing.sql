-- Subscription payments through Stripe (STORY-036 / REQ-009, REQ-012).
--
-- What is stored is what Stripe said, not what a card is: no card number, no
-- expiry, no CVC — Stripe holds those, and a database that never had them
-- cannot leak them. A payment is its PaymentIntent id, amount, outcome and,
-- when it failed, Stripe's code and message.
--
-- Failed payments are flagged for a person (the story's escalation line) and
-- stay flagged until someone reviews them; `payments_reviewed_pair` keeps the
-- who and the when together.
BEGIN;

CREATE TABLE IF NOT EXISTS subscriptions (
    id                  BIGSERIAL   PRIMARY KEY,
    author_id           BIGINT      NOT NULL UNIQUE REFERENCES authors(id) ON DELETE CASCADE,
    plan                TEXT        NOT NULL DEFAULT 'author-monthly',
    amount_cents        INT         NOT NULL CHECK (amount_cents > 0),
    currency            TEXT        NOT NULL DEFAULT 'usd',
    status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
    stripe_customer_id  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
    id                  BIGSERIAL   PRIMARY KEY,
    author_id           BIGINT      NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    subscription_id     BIGINT      REFERENCES subscriptions(id) ON DELETE SET NULL,
    stripe_payment_intent_id TEXT   UNIQUE,
    amount_cents        INT         NOT NULL,
    currency            TEXT        NOT NULL,
    status              TEXT        NOT NULL
                        CHECK (status IN ('processing', 'succeeded', 'failed', 'requires_action')),
    failure_code        TEXT,
    failure_message     TEXT,
    needs_review        BOOLEAN     NOT NULL DEFAULT FALSE,
    reviewed_by         TEXT,
    reviewed_at         TIMESTAMPTZ,
    notified_at         TIMESTAMPTZ,
    requested_by        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payments_failure_named CHECK (status <> 'failed' OR failure_code IS NOT NULL),
    CONSTRAINT payments_reviewed_pair CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS payments_author_idx ON payments (author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_review_idx ON payments (created_at DESC) WHERE needs_review AND reviewed_at IS NULL;

-- Stripe delivers each webhook event at least once. The id is the guard that
-- makes a second delivery change nothing.
CREATE TABLE IF NOT EXISTS stripe_events (
    id           TEXT        PRIMARY KEY,
    type         TEXT        NOT NULL,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    outcome      TEXT        NOT NULL
);

GRANT SELECT, INSERT, UPDATE ON subscriptions, payments TO ale_app;
GRANT SELECT, INSERT ON stripe_events TO ale_app;
GRANT USAGE, SELECT ON SEQUENCE subscriptions_id_seq, payments_id_seq TO ale_app;

INSERT INTO tenant_shared_tables (table_name, readable, why) VALUES
  ('stripe_events', FALSE, 'Stripe webhook deliveries, for de-duplication (STORY-036). System state, no tenant column.')
ON CONFLICT (table_name) DO UPDATE SET readable = EXCLUDED.readable, why = EXCLUDED.why;

COMMIT;
