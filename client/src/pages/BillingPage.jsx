import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';

/**
 * Subscription payments through Stripe (STORY-036).
 *
 * An author sees their own subscription and every payment, including why one
 * failed. An admin (tenant.manage) can charge a tenant's subscription and sees
 * the failed payments waiting for a person to review. Cards are never typed
 * here: a payment names a Stripe PaymentMethod — in test mode, one of Stripe's
 * test methods; in production, one Stripe's own form collected.
 */
const money = (cents, currency) => `${(cents / 100).toFixed(2)} ${String(currency).toUpperCase()}`;
const when = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '—');
const TONE = { succeeded: 'approved', active: 'approved', failed: 'escalated', past_due: 'escalated', processing: 'pending_approval', pending: 'pending_approval', requires_action: 'pending_approval' };

export function BillingPage({ author, user }) {
  const canManage = Boolean(user.permissions?.includes('tenant.manage'));
  const [tenants, setTenants] = useState([]);
  const [authorId, setAuthorId] = useState(author.id);
  const [billing, setBilling] = useState(null);
  const [review, setReview] = useState([]);
  const [method, setMethod] = useState('pm_card_visa');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBilling(await api.billing(authorId));
    if (canManage) setReview((await api.paymentsToReview()).payments);
  }, [authorId, canManage]);

  useEffect(() => {
    if (canManage) api.tenants().then(setTenants).catch(() => {});
  }, [canManage]);
  useEffect(() => {
    refresh().catch((e) => setStatus({ kind: 'error', message: e.message }));
  }, [refresh]);

  const charge = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.chargeSubscription(authorId, method);
      setStatus(r.payment.status === 'succeeded'
        ? { kind: 'ok', message: `Charged ${money(r.payment.amount_cents, r.payment.currency)}. The subscription is active.` }
        : { kind: 'error', message: `Payment ${r.payment.status}: ${r.payment.failure_message ?? r.payment.failure_code}. ${r.notified ? 'The author has been emailed.' : ''} Flagged for review.` });
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  const reviewed = async (id) => {
    setBusy(true);
    try {
      await api.markPaymentReviewed(id);
      await refresh();
    } catch (e) {
      setStatus({ kind: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (!billing) return <div className="card"><div className="empty">Loading…</div></div>;
  const sub = billing.subscription;
  return (
    <>
      {status && <div className={`banner ${status.kind}`}>{status.message}</div>}

      <div className="card">
        <h2>Subscription</h2>
        {canManage && tenants.length > 0 && (
          <div className="row">
            <label htmlFor="billing-tenant">Tenant</label>
            <select id="billing-tenant" value={authorId} onChange={(e) => setAuthorId(Number(e.target.value))}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        {!billing.configured ? (
          <div className="banner">Payments aren't set up here: the server has no Stripe key (STRIPE_SECRET_KEY).</div>
        ) : (
          <div className="meta">
            <span className={`pill ${TONE[sub?.status ?? 'pending']}`}>{sub?.status ?? 'not charged yet'}</span>
            <span className="pill neutral">{money(sub?.amount_cents ?? billing.price.amountCents, sub?.currency ?? billing.price.currency)} / month</span>
            {billing.testMode && <span className="pill pending_approval">Stripe test mode — no real card is charged</span>}
          </div>
        )}

        {canManage && billing.configured && (
          <div className="row" style={{ marginTop: 12 }}>
            <label htmlFor="billing-method">Payment method</label>
            <select id="billing-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {billing.testPaymentMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={charge}>{busy ? 'Charging…' : 'Charge subscription'}</button>
          </div>
        )}
        <p className="hint">
          Card details never reach this system: Stripe holds them, and a payment here names only a Stripe payment
          method. Every payment is on the audit log; a failed one is flagged for review and the author is emailed why.
        </p>
      </div>

      <div className="card">
        <h2>Payments ({billing.payments.length})</h2>
        {billing.payments.length === 0 ? (
          <div className="empty">No payments yet.</div>
        ) : (
          <table>
            <thead><tr><th>When (UTC)</th><th>Amount</th><th>Status</th><th>Why it failed</th><th>Author told</th><th>Stripe</th></tr></thead>
            <tbody>
              {billing.payments.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{when(p.created_at)}</td>
                  <td className="mono">{money(p.amount_cents, p.currency)}</td>
                  <td><span className={`pill ${TONE[p.status]}`}>{p.status}</span>{p.needs_review && !p.reviewed_at && <div className="hint">flagged for review</div>}</td>
                  <td>{p.failure_message ?? '—'}{p.failure_code && <div className="hint mono">{p.failure_code}</div>}</td>
                  <td className="mono">{p.status === 'failed' ? (p.notified_at ? when(p.notified_at) : 'not yet') : '—'}</td>
                  <td className="mono">{p.stripe_payment_intent_id ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canManage && (
        <div className="card">
          <h2>Failed payments to review ({review.length})</h2>
          {review.length === 0 ? (
            <div className="empty">Nothing waiting — every failed payment has been looked at.</div>
          ) : (
            <table>
              <thead><tr><th>When (UTC)</th><th>Tenant</th><th>Amount</th><th>Reason</th><th /></tr></thead>
              <tbody>
                {review.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{when(p.created_at)}</td>
                    <td>{p.author_name}</td>
                    <td className="mono">{money(p.amount_cents, p.currency)}</td>
                    <td>{p.failure_message ?? p.failure_code}</td>
                    <td><button type="button" disabled={busy} onClick={() => reviewed(p.id)}>Mark reviewed</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </>
  );
}
