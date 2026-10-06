import { PLATFORMS, config } from '../config.js';

/**
 * Every external integration, and the policy the gateway applies to it
 * (STORY-038 / REQ-009, REQ-014).
 *
 * The build note asks for "routes and policies for each integrated external
 * API" and "all API interactions routed through the gateway". STORY-016's
 * gateway had one policy for everything and no list of what it was supposed
 * to cover — so the directory search bypassed it for twenty stories without
 * anything noticing, and a 10-second timeout that suits email applied equally
 * to an AI generation that takes twenty.
 *
 * A service not declared here is refused by `callExternal`, the way an
 * undeclared outbound path is refused by `assertDeclaredPath` (STORY-020):
 * adding an integration is a decision with a policy attached, not a string
 * somebody typed.
 *
 *   timeoutMs         how long one attempt may take
 *   maxAttempts       attempts in total, not retries
 *   backoffMs         first retry's wait, doubled each time
 *   failureThreshold  failed *calls* in a row (after their retries) that open the circuit
 *   cooldownMs        how long an open circuit refuses before letting one call try
 *   alertable         whether an operator can be told about it by email — false
 *                     for email itself, which cannot carry news of its own outage
 */
// The STORY-016 settings remain the defaults, so API_TIMEOUT_MS and friends
// still mean what the README says; a route overrides only what differs.
const DEFAULTS = {
  timeoutMs: config.apiTimeoutMs,
  maxAttempts: config.apiMaxAttempts,
  backoffMs: config.apiBackoffMs,
  failureThreshold: 3,
  cooldownMs: 120_000,
  alertable: true,
};

const route = (service, kind, overrides = {}, why = '') => ({ service, kind, ...DEFAULTS, ...overrides, why });

export const INTEGRATIONS = Object.fromEntries(
  [
    route('anthropic', 'content', { timeoutMs: 180_000, maxAttempts: 2, backoffMs: 2_000 },
      'Generation takes tens of seconds, longer when the model thinks first; the shared 10s timeout abandoned calls that would have succeeded, and 60s cut off long batches. Two attempts, because a retry is a second paid generation.'),
    route('email', 'notification', { failureThreshold: 5, cooldownMs: 60_000, alertable: false },
      'Every alert in this system is an email, so an email outage cannot be announced by email. It is shown on the Trust tab and in the audit log instead.'),
    route('openai', 'content', { timeoutMs: 60_000, maxAttempts: 3, backoffMs: 2_000 },
      'Content generation (STORY-035). Retried after a delay on a 429 or 5xx — the acceptance asks for exactly that — and every attempt is on the record.'),
    route('stripe', 'payments', { timeoutMs: 20_000, maxAttempts: 3, backoffMs: 1_000 },
      'Subscription payments (STORY-036). Retried only on a 429 or 5xx, and always with the same idempotency key, so a retry can never charge twice; a declined card is a 402 and is not retried.'),
    route('twilio', 'notification', { timeoutMs: 10_000, maxAttempts: 2, backoffMs: 1_000, failureThreshold: 5, cooldownMs: 60_000 },
      'Text messages (STORY-037). Two quick attempts here; a text still undelivered is kept and retried minutes later by a job, so an outage delays a text rather than losing it.'),
    route('elasticsearch', 'infrastructure', { timeoutMs: 15_000, maxAttempts: 3, backoffMs: 1_000, cooldownMs: 60_000 },
      'The search index (STORY-055). A copy, never the record: when it is down, searching says so and indexing resumes from its mark.'),
    ...PLATFORMS.map((p) => route(p, 'social', {}, 'Publishes human-approved posts (STORY-001). A failure here is a late post, never an unapproved one.')),
    ...['podcastIndex', 'speakerBureau', 'eventFinder'].map((d) =>
      route(d, 'directory', { timeoutMs: 8_000, maxAttempts: 2, cooldownMs: 300_000 },
        'Opportunity scouting (STORY-002). Called directly, with no timeout and no record, until STORY-038.')),
  ].map((r) => [r.service, r]),
);

/**
 * Registered at runtime rather than declared above. For the test suite and the
 * demo, which exercise the gateway against providers that do not exist. The
 * integration coverage test fails if production code calls this.
 */
const registered = new Map();
export function registerIntegration(service, overrides = {}) {
  registered.set(service, route(service, 'test', overrides, 'registered at runtime'));
  return registered.get(service);
}

/** The route for a service, or a refusal that says how to add one. */
export function routeFor(service) {
  const found = INTEGRATIONS[service] ?? registered.get(service);
  if (!found) {
    throw Object.assign(
      new Error(
        `Outbound call refused: "${service}" is not a declared integration. Add it to ` +
          `services/integrationRoutes.js with its timeout, retries and circuit policy. ` +
          `Declared: ${Object.keys(INTEGRATIONS).join(', ')}`,
      ),
      { status: 500 },
    );
  }
  return found;
}

export const declaredIntegrations = () => Object.keys(INTEGRATIONS).sort();
