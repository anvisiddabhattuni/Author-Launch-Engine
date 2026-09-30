/**
 * STORY-037 acceptance tests — notifications by text through Twilio.
 *
 *   Given an approval is required for a generated content piece, when the
 *   system notifies the user, then the notification is delivered via Twilio.
 *
 *   Given Twilio is temporarily unavailable, when the system attempts to send,
 *   then it logs the failure and retries after a delay.
 *
 * Measured before: notifications were email only; reviewers had no phone
 * number and nothing could send a text.
 *
 * Test mode: Twilio is played by a local stand-in speaking Twilio's Messages
 * API (src/dev/standIns.js). The adapter, gateway, job queue and retries are real.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { notifyAwaitingApproval } from '../src/agents/approvalNotificationAgent.js';
import { onboardTenant } from '../src/agents/tenantManagementAgent.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { closePool, ownerQuery, query } from '../src/db/pool.js';
import { twilioStandIn } from '../src/dev/standIns.js';
import { runOnce } from '../src/jobs/queue.js';
import { sendSms } from '../src/services/sms.js';

const stamp = Date.now();
const twilio = twilioStandIn();
const saved = { sid: config.twilioAccountSid, token: config.twilioAuthToken, from: config.twilioFromNumber, base: config.twilioApiBase, max: config.smsMaxAttempts };
const PHONE = '+15555550123';
let server;
let base;
let tenant;
let other;
let as;

const call = async (headers, method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const bearer = async (email, password) => {
  const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { authorization: `Bearer ${(await r.json()).token}` };
};
const pendingDraft = async (authorId) => {
  const { rows: [b] } = await query("INSERT INTO books (author_id, title, content, themes) VALUES ($1,'T','x','{craft}') RETURNING id", [authorId]);
  await query(`INSERT INTO drafts (author_id, book_id, platform, content, status, confidence, week_of)
               VALUES ($1,$2,'twitter','a post waiting','pending_approval',0.9,CURRENT_DATE)`, [authorId, b.id]);
};
const latestSms = async () => (await ownerQuery('SELECT * FROM sms_messages WHERE author_id = $1 ORDER BY id DESC LIMIT 1', [tenant.author.id])).rows[0];

before(async () => {
  config.twilioApiBase = await twilio.start();
  Object.assign(config, { twilioAccountSid: 'ACtest', twilioAuthToken: 'test-token', twilioFromNumber: '+15005550006' });
  await ownerQuery("DELETE FROM integration_circuits WHERE service IN ('twilio', 'email')");
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  tenant = await onboardTenant({ name: 'Text Author', email: `text-${stamp}@example.test`, password: 'text-password-1' });
  other = await onboardTenant({ name: 'Text Other', email: `text-other-${stamp}@example.test`, password: 'text-password-2' });
  as = { me: await bearer(`text-${stamp}@example.test`, 'text-password-1'), other: await bearer(`text-other-${stamp}@example.test`, 'text-password-2') };
});

after(async () => {
  Object.assign(config, { twilioAccountSid: saved.sid, twilioAuthToken: saved.token, twilioFromNumber: saved.from, twilioApiBase: saved.base, smsMaxAttempts: saved.max });
  await ownerQuery("DELETE FROM integration_circuits WHERE service IN ('twilio', 'email')");
  for (const t of [tenant, other]) await query('DELETE FROM authors WHERE id = $1', [t.author.id]);
  await new Promise((r) => server.close(r));
  await twilio.stop();
  await closePool();
});

describe('STORY-037: an approval is waiting, and the reviewer is texted', () => {
  it('a reviewer can give a mobile number — in international form only', async () => {
    const bad = await call(as.me, 'POST', `/authors/${tenant.author.id}/reviewers`, { name: 'Rev', email: `rev-${stamp}@example.test`, phone: '555-0123' });
    assert.equal(bad.status, 400);
    const ok = await call(as.me, 'POST', `/authors/${tenant.author.id}/reviewers`, { name: 'Rev', email: `rev-${stamp}@example.test`, phone: PHONE });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.phone, PHONE);
  });

  it('the approval notice goes by text through Twilio, as well as by email', async () => {
    await pendingDraft(tenant.author.id);
    const r = await notifyAwaitingApproval({ authorId: tenant.author.id });
    assert.equal(r.notified.length, 1, 'the email still went');
    assert.deepEqual(r.texts.map((t) => t.status), ['sent']);
    const sent = twilio.received.at(-1);
    assert.equal(sent.path, '/2010-04-01/Accounts/ACtest/Messages.json');
    assert.equal(sent.form.To, PHONE);
    assert.equal(sent.form.From, '+15005550006');
    assert.match(sent.form.Body, /1 item waiting for your approval/);
    assert.equal(sent.headers.authorization, `Basic ${Buffer.from('ACtest:test-token').toString('base64')}`);
  });

  it('logged in PostgreSQL and on the audit log — the number masked in the log', async () => {
    const m = await latestSms();
    assert.equal(m.status, 'sent');
    assert.match(m.twilio_sid, /^SM/);
    const { rows: [log] } = await query(
      "SELECT metadata FROM audit_log WHERE action = 'sms.sent' AND entity_id = $1", [String(m.id)],
    );
    assert.equal(log.metadata.to, '…0123');
    assert.ok(!JSON.stringify(log.metadata).includes(PHONE));
    const mine = await call(as.me, 'GET', `/authors/${tenant.author.id}/sms`);
    assert.equal(mine.body.messages[0].to_number, '…0123');
    assert.equal((await call(as.other, 'GET', `/authors/${tenant.author.id}/sms`)).status, 403);
  });
});

describe('STORY-037: Twilio temporarily unavailable', () => {
  it('logs the failure and schedules a retry minutes later — the text is kept, not lost', async () => {
    twilio.failNext(2, 503); // both of the gateway's quick attempts
    const before = Date.now();
    const m = await sendSms({ to: PHONE, body: 'waiting for you', via: 'approval.notify_waiting_sms', purpose: 'approval.waiting', authorId: tenant.author.id });
    assert.equal(m.status, 'retrying');
    assert.match(m.last_error, /503/);
    assert.ok(new Date(m.next_attempt_at).getTime() >= before + config.smsRetrySeconds * 1000 - 1000, 'after a delay, not at once');
    const { rows: [job] } = await ownerQuery(
      "SELECT id, run_at FROM jobs WHERE kind = 'sms.send' AND payload->>'messageId' = $1", [String(m.id)],
    );
    assert.ok(job, 'a job will try again');
    const { rows: [log] } = await query("SELECT metadata FROM audit_log WHERE action = 'sms.retry_scheduled' AND entity_id = $1", [String(m.id)]);
    assert.match(log.metadata.error, /503/);

    // When the retry is due, the job sends it.
    await ownerQuery("DELETE FROM integration_circuits WHERE service = 'twilio'");
    await runOnce({ now: new Date(new Date(job.run_at).getTime() + 1000), jobId: job.id });
    const done = (await ownerQuery('SELECT * FROM sms_messages WHERE id = $1', [m.id])).rows[0];
    assert.equal(done.status, 'sent');
    assert.equal(done.attempts, 2);
  });

  it('gives up after SMS_MAX_ATTEMPTS and says so', async () => {
    config.smsMaxAttempts = 1;
    try {
      twilio.failNext(2, 503);
      const m = await sendSms({ to: PHONE, body: 'waiting', via: 'approval.notify_waiting_sms', purpose: 'approval.waiting', authorId: tenant.author.id });
      assert.equal(m.status, 'failed');
      const { rows: [log] } = await query("SELECT 1 FROM audit_log WHERE action = 'sms.failed' AND entity_id = $1", [String(m.id)]);
      assert.ok(log);
    } finally {
      config.smsMaxAttempts = saved.max;
      await ownerQuery("DELETE FROM integration_circuits WHERE service = 'twilio'");
    }
  });

  it('a malformed number is refused before any call; an undeclared purpose is refused too', async () => {
    const n = twilio.received.length;
    await assert.rejects(sendSms({ to: '12345', body: 'x', via: 'approval.notify_waiting_sms', purpose: 'p' }), /international form/);
    await assert.rejects(sendSms({ to: PHONE, body: 'x', via: 'newsletter.blast', purpose: 'p' }));
    assert.equal(twilio.received.length, n);
  });

  it('without Twilio set up, the email still goes and no text is attempted', async () => {
    const savedSid = config.twilioAccountSid;
    config.twilioAccountSid = '';
    try {
      await pendingDraft(tenant.author.id);
      const r = await notifyAwaitingApproval({ authorId: tenant.author.id });
      assert.equal(r.notified.length, 1);
      assert.deepEqual(r.texts, []);
    } finally {
      config.twilioAccountSid = savedSid;
    }
  });
});
