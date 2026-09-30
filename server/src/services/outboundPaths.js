/**
 * Every way content can leave this system, and what stands in front of it
 * (STORY-020).
 *
 * REQ-006 says no content is published or sent without explicit human approval,
 * and three governance invariants have checked that since STORY-013 —
 * `gate.posts`, `gate.outreach`, `gate.press`. Each of them joins one table that
 * records a send: `scheduled_posts`, `outreach_sends`, `pr_distributions`. They
 * are good checks and they share a blind spot: **they verify the gates that
 * exist.** A seventh send path added next month, writing to no table any of them
 * joins, is unguarded and invisible to all three, and nothing anywhere would
 * say so.
 *
 * So the question this file answers is not "was that message approved" — the
 * three invariants already answer that — but "is there a way out of this system
 * that nobody put a gate on". It is answered the way the approval gate itself is
 * answered: at the choke point rather than by convention. `emailApi.send` and
 * every social publisher refuse to send for a path that is not declared here, so
 * a new outbound path cannot ship silently. It can ship *exempt*, deliberately
 * and with a reason on the record — which is a different thing from shipping
 * unnoticed.
 *
 * Adding a path here is not a rubber stamp. An entry either names the gate it
 * sits behind or states why it has none, and `EXEMPT` entries are listed on the
 * trust dashboard rather than hidden, for the reason STORY-017 learned the hard
 * way: an exclusion nobody can see is indistinguishable from a check that never
 * ran.
 */

/** A path that carries tenant content to the outside world needs a gate. */
export const GATED = 'gated';

/**
 * A path that does not. Every exemption here is a notification *about* work
 * awaiting a decision, sent to addresses the tenant configured.
 */
export const EXEMPT = 'exempt';

export const OUTBOUND_PATHS = [
  {
    id: 'social.publish',
    kind: GATED,
    module: 'services/scheduler.js',
    sends: 'an approved post to a social platform',
    gate: "drafts.status = 'approved'",
    enforcedIn: 'scheduleDraft() refuses any draft not already approved',
    invariant: 'gate.posts',
  },
  {
    id: 'outreach.send',
    kind: GATED,
    module: 'services/outreachSender.js',
    sends: 'an approved pitch to a podcast, event or venue',
    gate: "outreach_messages.status = 'approved'",
    enforcedIn: 'sendOutreachMessage() refuses anything not approved',
    invariant: 'gate.outreach',
  },
  {
    id: 'press.distribute',
    kind: GATED,
    module: 'services/prDistributor.js',
    sends: 'a complete press kit to matching press contacts',
    gate: "every pr_materials row in the kit is 'approved'",
    enforcedIn: 'distributePressKit() refuses a kit with any unapproved material',
    invariant: 'gate.press',
  },
  {
    id: 'review.notify_pending',
    kind: EXEMPT,
    module: 'services/reviewNotifier.js',
    sends: 'a digest of press materials awaiting review, to this author\'s reviewers',
    why:
      'The email that asks for approval cannot itself require approval — that is circular, and the ' +
      'queue would never be announced. It carries this tenant\'s own content to addresses this ' +
      'tenant configured, and moves no status.',
  },
  {
    id: 'review.notify_escalation',
    kind: EXEMPT,
    module: 'services/reviewNotifier.js',
    sends: 'notice that the monitor raised an escalation, to this author\'s reviewers',
    why:
      'Same reason, and more so: an escalation is the system asking for a human precisely because ' +
      'it is unsure. Holding that request behind a human is the deadlock it exists to prevent.',
  },
  {
    id: 'trust.alert_breach',
    kind: EXEMPT,
    module: 'services/trustHistory.js',
    sends: 'notice that a governance invariant has started failing, to this author\'s reviewers',
    why:
      'An alert that an invariant broke cannot wait for approval of the alert — the thing being ' +
      'reported is that a promise the product makes is currently untrue, and holding that behind a ' +
      'review is the deadlock the alert exists to break. Sent once per episode, never re-sent while ' +
      'the breach persists (STORY-021).',
  },
  {
    id: 'social.notify_failure',
    kind: EXEMPT,
    module: 'services/publishFailureNotifier.js',
    sends: 'notice that an approved post failed to reach the platform, to this author\'s reviewers',
    why:
      'Reporting that something did NOT go out cannot itself require approval to go out. The post ' +
      'in question already passed the gate — the failure happened at the platform, after it — so ' +
      'this announces an absence rather than publishing content. Sent once per post per reviewer, ' +
      'ever (STORY-025).',
  },
  {
    id: 'system.alert_outage',
    kind: EXEMPT,
    module: 'services/healthMonitoring.js',
    sends: 'notice that a component has stopped answering, to accounts holding system.operate',
    why:
      'An outage notice carries no tenant content — it names a component and a time. Holding it ' +
      'behind approval would mean the system asks a human for permission to say it is down, ' +
      'which it may not be able to ask. Once per outage, never re-sent while it persists (STORY-027).',
  },
  {
    id: 'system.alert_integration',
    kind: EXEMPT,
    module: 'agents/apiIntegrationAgent.js',
    sends: 'notice that an external integration stopped answering, to accounts holding system.operate',
    why:
      'Names a provider and its last error; carries no tenant content. Sent once when a circuit opens, ' +
      'never while it stays open (STORY-038). Not sent for email, which cannot announce its own outage.',
  },
  {
    id: 'security.alert_access',
    kind: EXEMPT,
    module: 'services/dataAccess.js',
    sends: 'notice that one account or address keeps being refused tenant data, to accounts holding access.manage',
    why:
      'Names an account, a count and the routes it tried; carries no tenant content. Held for approval, ' +
      'the warning that someone is trying doors would wait on the people it is meant to warn. Once per ' +
      'account per window (STORY-044).',
  },
  {
    id: 'security.alert_audit_access',
    kind: EXEMPT,
    module: 'services/securityNotifications.js',
    sends: 'notice of a refused attempt on the audit logs, to accounts holding audit.verify',
    why:
      'Names who tried, what, when, from where and why it was refused; carries no tenant content. Held for ' +
      'approval, the warning would wait on the people it warns. Once per person or address per ten minutes; ' +
      'later attempts join the open alert (STORY-052).',
  },
  {
    id: 'trust.escalate_anomaly',
    kind: EXEMPT,
    module: 'services/anomalyEscalation.js',
    sends: 'an email telling security officers and the tenant\'s reviewers that an anomaly was detected, with its details',
    why:
      'Not publishing anything: it announces a finding to the people who must look at it. Holding an escalation ' +
      'for approval would be circular — the escalation is how a human gets involved (STORY-059).',
  },
  {
    id: 'approval.notify_waiting_sms',
    kind: EXEMPT,
    module: 'agents/approvalNotificationAgent.js',
    sends: 'a short text to a reviewer saying how many items wait for their approval, with a link',
    why:
      'Not publishing anything: it announces work awaiting a decision to a reviewer the tenant named, and ' +
      'gating it on approval would be circular — the text exists to get the approval (STORY-037).',
  },
  {
    id: 'billing.notify_failure',
    kind: EXEMPT,
    module: 'services/billing.js',
    sends: 'an email telling an author their own subscription payment failed, and why',
    why:
      'Not publishing anything: it carries no tenant content — an amount and the card issuer\'s reason — to the ' +
      'author it is about. Holding it for approval would hide a failed payment from the one person who can fix it (STORY-036).',
  },
  {
    id: 'tenant.welcome',
    kind: EXEMPT,
    module: 'services/invites.js',
    sends: 'a one-time link for a new author to set their own password',
    why:
      'Carries no tenant content — a greeting and a link — to the address the tenant is being created for. ' +
      'Holding it for approval would hold the account shut; onboarding is itself an admin action, recorded ' +
      'with the admin who took it (STORY-043).',
  },
  {
    id: 'approval.notify_waiting',
    kind: EXEMPT,
    module: 'agents/approvalNotificationAgent.js',
    sends: 'the digest of everything waiting on a human, to this author\'s reviewers',
    why:
      'STORY-012\'s digest. Announcing that work is waiting is not publishing the work; the digest ' +
      'carries a 90-character excerpt so a reviewer knows what they are being asked about.',
  },
];

const BY_ID = new Map(OUTBOUND_PATHS.map((p) => [p.id, p]));

/** Every declared id, for tests and the dashboard. */
export const declaredPaths = () => [...BY_ID.keys()].sort();

/**
 * Refuses a send for a path nobody declared.
 *
 * Called by the adapters themselves, so this cannot be routed around by a
 * caller that forgets — the same reasoning that puts the approval check inside
 * `scheduleDraft` rather than in the route that calls it. A new send path now
 * fails loudly at its first call instead of shipping quietly ungated.
 */
export function assertDeclaredPath(via) {
  if (!via) {
    throw Object.assign(
      new Error(
        'Outbound send refused: no `via` given. Every way out of this system must be declared ' +
          `in services/outboundPaths.js (REQ-006 / STORY-020). Declared: ${declaredPaths().join(', ')}`,
      ),
      { status: 500 },
    );
  }
  const path = BY_ID.get(via);
  if (!path) {
    throw Object.assign(
      new Error(
        `Outbound send refused: "${via}" is not a declared outbound path. Add it to ` +
          `services/outboundPaths.js with either the gate it sits behind or why it has none. ` +
          `Declared: ${declaredPaths().join(', ')}`,
      ),
      { status: 500 },
    );
  }
  return path;
}

/**
 * The inventory, for the trust dashboard and the demo.
 *
 * Exemptions are returned alongside the gated paths rather than filtered out.
 * A reviewer should be able to read "three ways out are gated, three are
 * exempt and here is why" in one place — the alternative is an exemption that
 * only exists in a source comment nobody opens.
 */
export function outboundInventory() {
  const gated = OUTBOUND_PATHS.filter((p) => p.kind === GATED);
  const exempt = OUTBOUND_PATHS.filter((p) => p.kind === EXEMPT);
  return {
    total: OUTBOUND_PATHS.length,
    gated: gated.length,
    exempt: exempt.length,
    paths: OUTBOUND_PATHS,
    // Every gated path names an invariant that checks it from outside. A gated
    // path with no invariant is a gate nobody verifies, which is the state
    // REQ-006 was in before STORY-013.
    unverified: gated.filter((p) => !p.invariant).map((p) => p.id),
  };
}
