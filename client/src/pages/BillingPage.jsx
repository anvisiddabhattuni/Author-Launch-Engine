import { useCallback, useEffect, useState } from 'react';

import { api } from '../api.js';
import { localTime } from '../labels.js';

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
const PAY_LABEL = { succeeded: 'Paid', active: 'Active', failed: 'Failed', past_due: 'Overdue', processing: 'Processing', pending: 'Pending', requires_action: 'Needs action', canceled: 'Cancelled' };
const statusLabel = (s) => PAY_LABEL[s] ?? String(s).replace(/_/g, ' ');
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
        : { kind: 'error', message: `The payment didn’t go through: ${r.payment.failure_message ?? r.payment.failure_code}. ${r.notified ? 'The author has been emailed. ' : ''}An admin will look at it.` });
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
            <label htmlFor="billing-tenant">Author</label>
            <select id="billing-tenant" value={authorId} onChange={(e) => setAuthorId(Number(e.target.value))}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
        )}
        {!billing.configured ? (
          <div className="banner">Payments aren’t switched on yet. An administrator needs to connect the payment service (Stripe).</div>
        ) : (
          <div className="meta">
            <span className={`pill ${TONE[sub?.status ?? 'pending']}`}>{sub ? statusLabel(sub.status) : 'Not charged yet'}</span>
            <span className="pill neutral">{money(sub?.amount_cents ?? billing.price.amountCents, sub?.currency ?? billing.price.currency)} / month</span>
            {billing.testMode && <span className="pill pending_approval">Test mode — no real card is charged</span>}
          </div>
        )}

        {canManage && billing.configured && (
          <div className="row" style={{ marginTop: 12 }}>
            <label htmlFor="billing-method">Payment method</label>
            <select id="billing-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {billing.testPaymentMethods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <button type="button" disabled={busy} onClick={charge}>{busy ? 'Charging…' : 'Charge this month'}</button>
          </div>
        )}
        <p className="hint">
          Card details are kept by Stripe, the payment service — never by this app. If a payment fails, the author
          gets an email saying why and an admin is asked to look at it.
        </p>
      </div>

      <div className="card">
        <h2>Payments ({billing.payments.length})</h2>
        {billing.payments.length === 0 ? (
          <div className="empty">No payments yet.</div>
        ) : (
          <table>
            <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Why it failed</th><th>Author emailed</th></tr></thead>
            <tbody>
              {billing.payments.map((p) => (
                <tr key={p.id}>
                  <td>{localTime(p.created_at)}</td>
                  <td className="num">{money(p.amount_cents, p.currency)}</td>
                  <td><span className={`pill ${TONE[p.status]}`}>{statusLabel(p.status)}</span>{p.needs_review && !p.reviewed_at && <div className="hint">waiting for an admin to look</div>}</td>
                  <td>{p.failure_message ?? '—'}</td>
                  <td>{p.status === 'failed' ? (p.notified_at ? localTime(p.notified_at) : 'Not yet') : '—'}</td>
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
            <div className="empty">Nothing to look at — every failed payment has been checked.</div>
          ) : (
            <table>
              <thead><tr><th>Date</th><th>Author</th><th>Amount</th><th>Why it failed</th><th /></tr></thead>
              <tbody>
                {review.map((p) => (
                  <tr key={p.id}>
                    <td>{localTime(p.created_at)}</td>
                    <td>{p.author_name}</td>
                    <td className="num">{money(p.amount_cents, p.currency)}</td>
                    <td>{p.failure_message ?? p.failure_code}</td>
                    <td className="cell-action"><button type="button" disabled={busy} onClick={() => reviewed(p.id)}>Mark as looked at</button></td>
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
