import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { ACTOR } from '../agents/tenantManagementAgent.js';
import { callExternal, httpJson } from '../agents/apiIntegrationAgent.js';
import { config } from '../config.js';
import { outsideTenantScope, pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

/**
 * Subscription payments through Stripe (STORY-036 / REQ-009, REQ-012) —
 * Tenant Management Agent.
 *
 *   Given a new author signs up, when the subscription payment is processed,
 *   then it is processed securely through Stripe.
 *   Given a payment fails for insufficient funds, then the failure is logged
 *   and the author is told.
 *
 * Secure means: the card never touches this system — a payment names a Stripe
 * PaymentMethod, never a number — the secret key lives in the server's
 * environment only, every call goes through the integration gateway with an
 * idempotency key (a retried charge is the same charge, not a second one),
 * and Stripe's webhooks are believed only when their signature checks out.
 *
 * Every payment is on the audit log; every failure is flagged for a person
 * (the story's escalation line) and emailed to the author.
 */
export class BillingUnavailable extends Error {
  constructor() {
    super('Payments are not set up here: STRIPE_SECRET_KEY is empty.');
    this.status = 503;
  }
}

/** Stripe's test PaymentMethods — real ids in Stripe's test mode, and what the stand-in understands. */
export const TEST_PAYMENT_METHODS = [
  { id: 'pm_card_visa', label: 'Visa — succeeds' },
  { id: 'pm_card_chargeDeclinedInsufficientFunds', label: 'Declined — insufficient funds' },
  { id: 'pm_card_chargeDeclined', label: 'Declined — generic' },
];
export const testMode = () => !config.stripeSecretKey.startsWith('sk_live_');

/** Stripe takes form encoding with bracketed keys: metadata[author_id]=7. */
export function formEncode(params, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') out.push(formEncode(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

function stripe(operation, path, params, { idempotencyKey = randomUUID(), authorId = null } = {}) {
  if (!config.stripeSecretKey) throw new BillingUnavailable();
  return callExternal({
    service: 'stripe',
    operation,
    authorId,
    fn: (signal) => httpJson(`${config.stripeApiBase}${path}`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Bearer ${config.stripeSecretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        // The same key on a retry: Stripe answers with the first result
        // instead of charging twice.
        'idempotency-key': idempotencyKey,
      },
      body: formEncode(params),
    }),
  });
}

async function ensureSubscription(authorId, client) {
  const { rows: [existing] } = await client.query('SELECT * FROM subscriptions WHERE author_id = $1', [authorId]);
  if (existing) return existing;
  const { rows: [created] } = await client.query(
    'INSERT INTO subscriptions (author_id, amount_cents, currency) VALUES ($1, $2, $3) RETURNING *',
    [authorId, config.subscriptionPriceCents, config.subscriptionCurrency],
  );
  return created;
}

/** Tells the author, by email, that their payment did not go through — and records whether that worked. */
async function notifyFailure({ author, payment }) {
  try {
    await emailApi.send({
      to: author.email,
      via: 'billing.notify_failure',
      authorId: author.id,
      subject: 'Your Author Launch Engine payment did not go through',
      body: [
        `Hello ${author.name},`,
        '',
        `We could not take your subscription payment of ${(payment.amount_cents / 100).toFixed(2)} ${payment.currency.toUpperCase()}.`,
        `The card issuer said: ${payment.failure_message ?? payment.failure_code}.`,
        '',
        'Nothing has been charged. Your drafts and settings are untouched. Please update your card or contact us.',
      ].join('\n'),
    });
    await pool.query('UPDATE payments SET notified_at = now() WHERE id = $1', [payment.id]);
    return true;
  } catch (error) {
    await recordAction({ actor: ACTOR, action: 'billing.notify_failed', entityType: 'payment', entityId: String(payment.id), authorId: author.id, metadata: { error: error.message } });
    return false;
  }
}

/**
 * Charges an author's subscription. `paymentMethod` is a Stripe PaymentMethod
 * id — in production, collected from the author by Stripe's own form; in test
 * mode, one of Stripe's test methods.
 */
export async function chargeSubscription({ authorId, paymentMethod, requestedBy }) {
  if (!config.stripeSecretKey) throw new BillingUnavailable();
  if (!/^pm_[A-Za-z0-9_]+$/.test(paymentMethod ?? '')) {
    throw Object.assign(new Error('paymentMethod must be a Stripe PaymentMethod id (pm_…) — never card details'), { status: 400 });
  }
  return outsideTenantScope(async () => {
    const { rows: [author] } = await pool.query('SELECT id, name, email FROM authors WHERE id = $1', [authorId]);
    if (!author) throw Object.assign(new Error('No such author'), { status: 404 });
    let sub = await withTransaction((client) => ensureSubscription(author.id, client));

    if (!sub.stripe_customer_id) {
      const customer = await stripe('customers.create', '/customers',
        { email: author.email, name: author.name, metadata: { author_id: author.id } },
        { idempotencyKey: `customer-${author.id}`, authorId: author.id });
      ({ rows: [sub] } = await pool.query(
        'UPDATE subscriptions SET stripe_customer_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [sub.id, customer.id],
      ));
    }

    const { rows: [payment] } = await pool.query(
      `INSERT INTO payments (author_id, subscription_id, amount_cents, currency, status, requested_by)
       VALUES ($1,$2,$3,$4,'processing',$5) RETURNING *`,
      [author.id, sub.id, sub.amount_cents, sub.currency, requestedBy ?? null],
    );

    let intent = null;
    let failure = null;
    try {
      intent = await stripe('payment_intents.create', '/payment_intents', {
        amount: sub.amount_cents,
        currency: sub.currency,
        customer: sub.stripe_customer_id,
        payment_method: paymentMethod,
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: `Author Launch Engine — ${sub.plan}`,
        metadata: { author_id: author.id, subscription_id: sub.id, payment_id: payment.id },
      }, { idempotencyKey: `payment-${payment.id}`, authorId: author.id });
    } catch (error) {
      // A declined card is a 402 with the reason in the body. Anything else —
      // Stripe down after the retries, a bad request — is a failure too, and
      // is recorded as one rather than left "processing".
      const e = error.body?.error;
      failure = {
        code: e?.decline_code ?? e?.code ?? (error.status ? `http_${error.status}` : 'unreachable'),
        message: e?.message ?? error.message,
        intentId: e?.payment_intent?.id ?? null,
      };
    }

    const ok = intent && intent.status === 'succeeded';
    const status = ok ? 'succeeded' : intent?.status === 'requires_action' ? 'requires_action' : failure ? 'failed' : 'processing';
    const { rows: [done] } = await pool.query(
      `UPDATE payments SET status = $2, stripe_payment_intent_id = $3, failure_code = $4, failure_message = $5,
              needs_review = $6, updated_at = now() WHERE id = $1 RETURNING *`,
      [payment.id, status, intent?.id ?? failure?.intentId ?? null, failure?.code ?? null, failure?.message ?? null, status === 'failed'],
    );
    await pool.query('UPDATE subscriptions SET status = $2, updated_at = now() WHERE id = $1',
      [sub.id, ok ? 'active' : status === 'failed' ? 'past_due' : sub.status]);

    await recordAction({
      actor: requestedBy ?? ACTOR,
      action: ok ? 'billing.payment_succeeded' : status === 'failed' ? 'billing.payment_failed' : 'billing.payment_pending',
      entityType: 'payment',
      entityId: String(done.id),
      authorId: author.id,
      after: { status, amount_cents: done.amount_cents, currency: done.currency },
      metadata: { stripePaymentIntent: done.stripe_payment_intent_id, failureCode: done.failure_code, testMode: testMode() },
    });

    const notified = status === 'failed' ? await notifyFailure({ author, payment: done }) : null;
    return { payment: { ...done, notified_at: notified ? new Date().toISOString() : done.notified_at }, subscriptionStatus: ok ? 'active' : status === 'failed' ? 'past_due' : sub.status, notified };
  });
}

/** Verifies a Stripe-Signature header: `t=<unix>,v1=<hex hmac of "t.payload">`, within five minutes. */
export function verifyStripeSignature(rawBody, header, secret = config.stripeWebhookSecret, now = Date.now()) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set' };
  const parts = Object.fromEntries(String(header ?? '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2));
  const t = Number(parts.t);
  if (!t || !parts.v1) return { ok: false, reason: 'no signature' };
  if (Math.abs(now / 1000 - t) > 300) return { ok: false, reason: 'signature too old' };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature does not match' };
  return { ok: true };
}

/**
 * A Stripe webhook: payment outcomes Stripe reports after the fact (a payment
 * that needed the customer's bank, a later failure). Idempotent by event id.
 */
export async function handleStripeEvent(event) {
  return outsideTenantScope(async () => {
    const seen = await pool.query(
      'INSERT INTO stripe_events (id, type, outcome) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING RETURNING id',
      [event.id, event.type, 'received'],
    );
    if (!seen.rowCount) return { duplicate: true };
    const intent = event.data?.object ?? {};
    if (!['payment_intent.succeeded', 'payment_intent.payment_failed'].includes(event.type)) return { ignored: event.type };
    const ok = event.type === 'payment_intent.succeeded';
    const err = intent.last_payment_error ?? {};
    const { rows: [payment] } = await pool.query(
      `UPDATE payments SET status = $2, failure_code = $3, failure_message = $4, needs_review = $5, updated_at = now()
        WHERE stripe_payment_intent_id = $1 RETURNING *`,
      [intent.id, ok ? 'succeeded' : 'failed', ok ? null : err.decline_code ?? err.code ?? 'payment_failed', ok ? null : err.message ?? null, !ok],
    );
    if (!payment) return { unknownIntent: intent.id };
    await pool.query('UPDATE subscriptions SET status = $2, updated_at = now() WHERE id = $1', [payment.subscription_id, ok ? 'active' : 'past_due']);
    await recordAction({
      actor: 'Stripe', action: ok ? 'billing.payment_succeeded' : 'billing.payment_failed',
      entityType: 'payment', entityId: String(payment.id), authorId: payment.author_id,
      after: { status: payment.status }, metadata: { stripeEvent: event.id, source: 'webhook' },
    });
    if (!ok && !payment.notified_at) {
      const { rows: [author] } = await pool.query('SELECT id, name, email FROM authors WHERE id = $1', [payment.author_id]);
      await notifyFailure({ author, payment });
    }
    return { payment: payment.id, status: payment.status };
  });
}

/** An author's subscription and payments, newest first. */
export async function billingFor(authorId) {
  const { rows: [subscription] } = await pool.query('SELECT * FROM subscriptions WHERE author_id = $1', [authorId]);
  const { rows: payments } = await pool.query(
    `SELECT id, amount_cents, currency, status, failure_code, failure_message, needs_review, reviewed_by, reviewed_at,
            notified_at, requested_by, stripe_payment_intent_id, created_at
       FROM payments WHERE author_id = $1 ORDER BY id DESC LIMIT 50`,
    [authorId],
  );
  return {
    configured: Boolean(config.stripeSecretKey),
    testMode: testMode(),
    testPaymentMethods: testMode() ? TEST_PAYMENT_METHODS : [],
    price: { amountCents: config.subscriptionPriceCents, currency: config.subscriptionCurrency },
    subscription: subscription ?? null,
    payments,
  };
}

/** Failed payments no person has looked at yet, across tenants. */
export async function paymentsToReview() {
  return outsideTenantScope(async () => (await pool.query(
    `SELECT p.*, a.name AS author_name FROM payments p JOIN authors a ON a.id = p.author_id
      WHERE p.needs_review AND p.reviewed_at IS NULL ORDER BY p.created_at DESC`,
  )).rows);
}

export async function markReviewed({ paymentId, reviewer }) {
  return outsideTenantScope(async () => {
    const { rows: [p] } = await pool.query(
      `UPDATE payments SET reviewed_by = $2, reviewed_at = now(), updated_at = now()
        WHERE id = $1 AND needs_review AND reviewed_at IS NULL RETURNING *`,
      [paymentId, reviewer],
    );
    if (!p) throw Object.assign(new Error('No failed payment waiting for review with that id'), { status: 404 });
    await recordAction({ actor: reviewer, action: 'billing.failure_reviewed', entityType: 'payment', entityId: String(p.id), authorId: p.author_id });
    return p;
  });
}
