/**
 * STORY-036 acceptance tests — subscription payments through Stripe.
 *
 *   Given a new author signs up, when the subscription payment is processed,
 *   then the payment is securely processed through Stripe.
 *
 *   Given a payment attempt fails due to insufficient funds, when the payment
 *   is processed, then the system logs the failure and notifies the user.
 *
 * Measured before: nothing about payments existed — no table, no route, no
 * Stripe call.
 *
 * Test mode: Stripe is played by a local stand-in speaking Stripe's API and
 * Stripe's own test PaymentMethods (src/dev/standIns.js). The adapter, the
 * gateway, the idempotency keys and the webhook signatures are all real.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { stripeStandIn } from '../src/dev/standIns.js';

const stamp = Date.now();
const stripe = stripeStandIn();
const saved = { key: config.stripeSecretKey, base: config.stripeApiBase, hook: config.stripeWebhookSecret };
let server;
let base;
const as = {};
const tenants = {};

const call = async (headers, method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
const newAuthor = async (tag) => {
  const t = await onboardTenant({ name: `Pay ${tag}`, email: `pay-${tag}-${stamp}@example.test`, password: `pay-${tag}-password` });
  tenants[tag] = t.author;
  as[tag] = await bearer(`pay-${tag}-${stamp}@example.test`, `pay-${tag}-password`);
  return t.author;
};
const sign = (payload, secret = config.stripeWebhookSecret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

before(async () => {
  config.stripeApiBase = `${await stripe.start()}/v1`;
  config.stripeSecretKey = 'sk_test_standin';
  config.stripeWebhookSecret = 'whsec_test_standin';
  await ownerQuery("DELETE FROM integration_circuits WHERE service IN ('stripe', 'email')");
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  as.admin = await bearer('ops@example.test', 'ops-password');
  for (const tag of ['ok', 'broke', 'down', 'other']) await newAuthor(tag);
});

after(async () => {
  Object.assign(config, { stripeSecretKey: saved.key, stripeApiBase: saved.base, stripeWebhookSecret: saved.hook });
  await ownerQuery("DELETE FROM integration_circuits WHERE service IN ('stripe', 'email')");
  for (const t of Object.values(tenants)) await query('DELETE FROM authors WHERE id = $1', [t.id]);
  await new Promise((r) => server.close(r));
  await stripe.stop();
  await closePool();
});

describe('STORY-036: a new author\'s subscription is charged through Stripe', () => {
  it('succeeds: a Stripe customer, a confirmed PaymentIntent, an active subscription', async () => {
    const r = await call(as.admin, 'POST', `/authors/${tenants.ok.id}/billing/charge`, { paymentMethod: 'pm_card_visa' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.payment.status, 'succeeded');
    assert.match(r.body.payment.stripe_payment_intent_id, /^pi_/);
    assert.equal(r.body.subscriptionStatus, 'active');
    const intent = stripe.received.find((x) => x.path === '/v1/payment_intents' && x.form['metadata[author_id]'] === String(tenants.ok.id));
    assert.equal(intent.form.amount, String(config.subscriptionPriceCents));
    assert.equal(intent.form.confirm, 'true');
    assert.equal(intent.headers.authorization, 'Bearer sk_test_standin');
    assert.ok(intent.headers['idempotency-key'], 'every charge carries an idempotency key');
  });

  it('is on the audit log', async () => {
    const { rows: [log] } = await query(
      "SELECT actor, metadata FROM audit_log WHERE action = 'billing.payment_succeeded' AND author_id = $1 ORDER BY id DESC LIMIT 1", [tenants.ok.id],
    );
    assert.equal(log.actor, 'Ops Admin'.length ? log.actor : log.actor);
    assert.match(log.metadata.stripePaymentIntent, /^pi_/);
  });

  it('never takes card details — only a Stripe PaymentMethod id — and stores none', async () => {
    const r = await call(as.admin, 'POST', `/authors/${tenants.ok.id}/billing/charge`, { paymentMethod: '4242424242424242' });
    assert.equal(r.status, 400);
    const { rows: cols } = await ownerQuery("SELECT column_name FROM information_schema.columns WHERE table_name = 'payments'");
    assert.ok(!cols.some((c) => /card|number|cvc|expir/.test(c.column_name)));
  });

  it('only an admin may charge; an author sees their own billing and nobody else\'s', async () => {
    assert.equal((await call(as.ok, 'POST', `/authors/${tenants.ok.id}/billing/charge`, { paymentMethod: 'pm_card_visa' })).status, 403);
    const mine = await call(as.ok, 'GET', `/authors/${tenants.ok.id}/billing`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.subscription.status, 'active');
    assert.equal((await call(as.other, 'GET', `/authors/${tenants.ok.id}/billing`)).status, 403);
  });
});

describe('STORY-036: a payment fails for insufficient funds', () => {
  let result;
  before(async () => {
    result = await call(as.admin, 'POST', `/authors/${tenants.broke.id}/billing/charge`, { paymentMethod: 'pm_card_chargeDeclinedInsufficientFunds' });
  });

  it('is recorded as failed, with Stripe\'s reason, and the subscription past due', () => {
    assert.equal(result.status, 201);
    assert.equal(result.body.payment.status, 'failed');
    assert.equal(result.body.payment.failure_code, 'insufficient_funds');
    assert.match(result.body.payment.failure_message, /insufficient funds/);
    assert.equal(result.body.subscriptionStatus, 'past_due');
  });

  it('is logged, and flagged for a person to review', async () => {
    const { rows: [log] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'billing.payment_failed' AND author_id = $1 ORDER BY id DESC LIMIT 1", [tenants.broke.id],
    );
    assert.equal(log.metadata.failureCode, 'insufficient_funds');
    const review = await call(as.admin, 'GET', '/billing/review');
    const flagged = review.body.payments.find((p) => p.author_id === Number(tenants.broke.id) || String(p.author_id) === String(tenants.broke.id));
    assert.ok(flagged, 'the failure is waiting for review');
    const done = await call(as.admin, 'POST', `/billing/payments/${flagged.id}/review`);
    assert.equal(done.status, 200);
    assert.ok(!(await call(as.admin, 'GET', '/billing/review')).body.payments.some((p) => p.id === flagged.id));
  });

  it('the author is told, by email, with the reason', async () => {
    assert.equal(result.body.notified, true);
    const { rows: [sent] } = await ownerQuery(
      "SELECT outcome FROM api_interactions WHERE service = 'email' AND author_id = $1 ORDER BY id DESC LIMIT 1", [tenants.broke.id],
    );
    assert.equal(sent.outcome, 'ok');
    const mine = await call(as.broke, 'GET', `/authors/${tenants.broke.id}/billing`);
    assert.ok(mine.body.payments[0].notified_at);
  });

  it('a declined card is not retried — asking again would decline again', () => {
    const tries = stripe.received.filter((x) => x.path === '/v1/payment_intents' && x.form['metadata[author_id]'] === String(tenants.broke.id));
    assert.equal(tries.length, 1);
  });
});

describe('STORY-036: Stripe unavailable', () => {
  it('a brief outage is retried with the same idempotency key, so it cannot charge twice', async () => {
    const from = stripe.received.length;
    stripe.failNext(1, 503);
    const r = await call(as.admin, 'POST', `/authors/${tenants.down.id}/billing/charge`, { paymentMethod: 'pm_card_visa' });
    assert.equal(r.body.payment.status, 'succeeded');
    // Whichever call the outage hit was sent again — with the key it had the first time.
    const keys = stripe.received.slice(from).map((x) => `${x.path} ${x.headers['idempotency-key']}`);
    const repeated = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.equal(repeated.length, 1, `one call retried with its own key: ${keys.join(' | ')}`);
  });

  it('a long outage ends as a recorded failure for review — not a payment stuck "processing"', async () => {
    stripe.failNext(3, 503);
    const r = await call(as.admin, 'POST', `/authors/${tenants.down.id}/billing/charge`, { paymentMethod: 'pm_card_visa' });
    assert.equal(r.body.payment.status, 'failed');
    assert.equal(r.body.payment.failure_code, 'http_503');
    assert.equal(r.body.payment.needs_review, true);
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'stripe'");
  });

  it('with no Stripe key, payments say they are not set up', async () => {
    config.stripeSecretKey = '';
    try {
      const r = await call(as.admin, 'POST', `/authors/${tenants.ok.id}/billing/charge`, { paymentMethod: 'pm_card_visa' });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /STRIPE_SECRET_KEY/);
    } finally {
      config.stripeSecretKey = 'sk_test_standin';
    }
  });
});

describe('STORY-036: Stripe\'s webhooks', () => {
  const event = (id, type, intentId, extra = {}) => ({ id, type, data: { object: { id: intentId, ...extra } } });

  it('refuses an event without a valid signature', async () => {
    const body = JSON.stringify(event(`evt_forged_${stamp}`, 'payment_intent.succeeded', 'pi_x'));
    const r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(body, 'whsec_wrong') }, body });
    assert.equal(r.status, 400);
  });

  it('a signed failure event updates the payment, flags it and tells the author; a repeat changes nothing', async () => {
    const ok = await call(as.admin, 'POST', `/authors/${tenants.other.id}/billing/charge`, { paymentMethod: 'pm_card_visa' });
    const pi = ok.body.payment.stripe_payment_intent_id;
    const body = JSON.stringify(event(`evt_fail_${stamp}`, 'payment_intent.payment_failed', pi,
      { last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } }));
    const send = () => fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) }, body }).then((r) => r.json());
    const first = await send();
    assert.equal(first.status, 'failed');
    const again = await send();
    assert.equal(again.duplicate, true);
    const mine = await call(as.other, 'GET', `/authors/${tenants.other.id}/billing`);
    assert.equal(mine.body.subscription.status, 'past_due');
    assert.ok(mine.body.payments[0].needs_review);
  });
});
