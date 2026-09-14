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
