/**
 * API Integration Agent (STORY-016).
 *
 * Every outbound call in this system goes through here: the social platforms,
 * the email provider, the directory search, and the Anthropic content API.
 *
 * The adapters already existed and already worked. What they had no notion of
 * is the ways a real provider fails, because a mock never fails that way:
 *
 *   Nothing had a timeout. A bare `fetch` in Node has none — against a provider
 *   that accepts the connection and never answers it hangs indefinitely, which
 *   is verifiable and was verified. Since STORY-015 that would hang the graceful
 *   drain as well, turning one slow provider into a failed deploy.
 *
 *   Nothing distinguished a 429 from a 400. Retrying a rejected request is
 *   pointless; not retrying a rate limit throws away work that would have
 *   succeeded a second later. They are opposite mistakes and neither was
 *   possible to make, because there was no retry at all.
 *
 *   And nothing was logged. The audit log records that a post was published;
 *   nothing recorded that a platform answered 200 in 1.2 seconds on the second
 *   attempt, which is the fact that tells you a provider is degrading before it
 *   fails outright.
 *
 * The policy lives here rather than in each adapter so that swapping a mock for
 * a real client does not mean reimplementing any of it — which is the whole
 * premise the adapters were written on.
 */
import { randomUUID } from 'node:crypto';

import { pool } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { routeFor } from '../services/integrationRoutes.js';

export const ACTOR = 'APIIntegrationAgent';

/** Failures worth trying again, and failures that are an answer. */
export const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * An error carrying what the provider said, so the caller and the classifier see
 * the same thing. A plain `Error` loses the status, and the status is the whole
 * basis on which retrying is or is not sensible.
 */
export class ExternalApiError extends Error {
  constructor(message, { status = null, service, operation, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ExternalApiError';
    this.status = status;
    this.service = service;
    this.operation = operation;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Should this be tried again?
 *
 * A network error or a timeout is retryable: nothing was refused, the request
 * simply did not complete. A 4xx that is not 408/425/429 is the provider
 * answering, and asking again gets the same answer more slowly.
 */
export function isRetryable(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  if (error?.status === null || error?.status === undefined) {
    // No status at all means it never reached a server — DNS, refused
    // connection, socket reset. Worth another go.
    return true;
  }
  return RETRYABLE_STATUS.has(Number(error.status));
}

/** A provider telling us when to come back knows better than our backoff does. */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function logAttempt(row, client = pool) {
  await client.query(
    `INSERT INTO api_interactions
       (service, operation, call_id, attempt, outcome, status, duration_ms, retryable, error, author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      row.service,
      row.operation,
      row.callId,
      row.attempt,
      row.outcome,
      row.status ?? null,
      row.durationMs,
      row.retryable ?? null,
      row.error ?? '',
      row.authorId ?? null,
    ],
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls an external service, with a timeout, a retry policy and a record.
 *
 * `fn` receives an AbortSignal and is expected to honour it. Adapters that do
 * not make HTTP calls still come through here: they get the logging and the
 * attempt accounting, and the day one of them becomes a real client the policy
 * is already around it.
 *
 * @param {object} input
 * @param {string} input.service   The integration — 'anthropic', 'twitter'.
 * @param {string} input.operation What is being asked of it.
 * @param {(signal: AbortSignal) => Promise<any>} input.fn
 */
export async function callExternal({
  service,
  operation,
  fn,
  authorId = null,
  // Per-integration policy (STORY-038). An explicit argument still wins, so a
  // test can shorten a timeout without redeclaring the route.
  maxAttempts,
  timeoutMs,
  backoffMs,
  sleep = wait,
  now = () => new Date(),
}) {
  // Refused before anything else if nobody declared this integration.
  const policy = routeFor(service);
  maxAttempts ??= policy.maxAttempts;
  timeoutMs ??= policy.timeoutMs;
  backoffMs ??= policy.backoffMs;

  const callId = randomUUID();
  let lastError = null;

  // The circuit. A provider that has stopped answering is not asked again
  // until its cooldown has passed — every call used to spend three attempts
  // and their backoff on it, for as long as it stayed down.
  const circuit = await admit({ service, policy, now: now() });
  if (!circuit.allowed) {
    await logAttempt({
      service,
      operation,
      callId,
      attempt: 0,
      outcome: 'short_circuited',
      status: 503,
      durationMs: 0,
      retryable: false,
      error: `circuit open since ${circuit.openedAt.toISOString()}; next trial after ${circuit.retryAt.toISOString()}`,
      authorId,
    });
    throw new ExternalApiError(
      `${service} is not being called: it failed ${circuit.failures} time(s) in a row and its circuit ` +
        `is open until ${circuit.retryAt.toISOString()}`,
      { status: 503, service, operation },
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await fn(controller.signal);
      clearTimeout(timer);

      await logAttempt({
        service,
        operation,
        callId,
        attempt,
        outcome: 'ok',
        // An HTTP status only if the result carries one. A provider's own
        // `status` field (a Stripe PaymentIntent's "succeeded") is not one —
        // logging it failed the insert, and the gateway then retried a call
        // that had succeeded (found by STORY-036).
        status: Number.isInteger(result?.status) ? result.status : 200,
        durationMs: Date.now() - started,
        authorId,
      });
      await recordSuccess({ service, now: now() });

      return result;
    } catch (error) {
      clearTimeout(timer);
      const durationMs = Date.now() - started;

      // An abort we caused is a timeout; the distinction matters to whoever
      // reads the row, because one is the provider being slow and the other is
      // this process deciding to stop waiting.
      const timedOut = controller.signal.aborted;
      const retryable = isRetryable(timedOut ? { name: 'TimeoutError' } : error);
      const isLast = attempt === maxAttempts;

      await logAttempt({
        service,
        operation,
        callId,
        attempt,
        outcome: timedOut ? 'timed_out' : isLast || !retryable ? 'failed' : 'retrying',
        status: error?.status ?? null,
        durationMs,
        retryable,
        error: timedOut ? `no response within ${timeoutMs}ms` : error.message,
        authorId,
      });

      lastError = timedOut
        ? new ExternalApiError(`${service}.${operation} did not respond within ${timeoutMs}ms`, {
            service,
            operation,
          })
        : error;

      if (!retryable || isLast) break;

      // The provider's own instruction wins over our schedule.
      const backoff = error?.retryAfterMs ?? backoffMs * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }

  // Only a failure that says the provider is unwell counts toward opening the
  // circuit. A 400 for a post that is too long is the provider answering
  // correctly; counting it would let one bad draft take a platform offline.
  if (isRetryable(lastError)) await recordFailure({ service, policy, error: lastError, now: now() });

  await recordAction({
    actor: ACTOR,
    action: 'api.call_failed',
    entityType: 'api_call',
    entityId: callId,
    authorId,
    metadata: {
      service,
      operation,
      attempts: maxAttempts,
      status: lastError?.status ?? null,
      error: lastError?.message ?? 'unknown',
      // Said plainly: this is the point at which the system stopped trying.
      gaveUp: true,
    },
  });

  throw lastError;
}

/**
 * A JSON HTTP call with the timeout wired to the signal.
 *
 * Separate from `callExternal` so an adapter that is not HTTP still gets the
 * retry and logging, and an adapter that is does not have to restate how a
 * non-2xx becomes an error.
 */
export async function httpJson(url, { signal, ...init } = {}) {
  const response = await fetch(url, { ...init, signal });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const error = new ExternalApiError(`HTTP ${response.status}: ${body.slice(0, 200)}`, {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers),
    });
    // The provider's own explanation, parsed, for callers that act on it — a
    // declined card's reason (STORY-036) is in the body, not the status.
    try {
      error.body = JSON.parse(body);
    } catch {
      error.body = null;
    }
    throw error;
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// The circuit (STORY-038)
// ---------------------------------------------------------------------------

/**
 * May a call go out? Closed: yes. Open and cooling down: no. Open and cooled:
 * one trial is let through as half-open — its result decides whether the
 * circuit closes or opens again.
 */
async function admit({ service, policy, now }) {
  const { rows } = await pool.query('SELECT * FROM integration_circuits WHERE service = $1', [service]);
  const c = rows[0];
  if (!c || c.state === 'closed') return { allowed: true, state: 'closed' };

  const retryAt = new Date(new Date(c.opened_at).getTime() + policy.cooldownMs);
  if (c.state === 'open' && now < retryAt) {
    return { allowed: false, openedAt: new Date(c.opened_at), retryAt, failures: c.consecutive_failures };
  }
  if (c.state === 'open') {
    await pool.query(
      "UPDATE integration_circuits SET state = 'half_open', updated_at = $2 WHERE service = $1 AND state = 'open'",
      [service, now],
    );
  }
  return { allowed: true, state: 'half_open' };
}

async function recordSuccess({ service, now }) {
  const { rows } = await pool.query(
    `UPDATE integration_circuits
        SET state = 'closed', consecutive_failures = 0, last_success_at = $2, updated_at = $2
      WHERE service = $1
      RETURNING opened_at`,
    [service, now],
  );
  // Only an opened circuit closing is news. A success on a healthy one is
  // just a success, and writing an audit row for it would bury the ones that
  // matter under every published post.
  const previous = rows[0];
  if (previous?.opened_at) {
    await pool.query('UPDATE integration_circuits SET opened_at = NULL, alerted_at = NULL WHERE service = $1', [service]);
    await recordAction({
      actor: ACTOR,
      action: 'integration.circuit_closed',
      entityType: 'integration',
      entityId: service,
      metadata: {
        service,
        downForSeconds: Math.round((now - new Date(previous.opened_at)) / 1000),
      },
    });
  }
}

async function recordFailure({ service, policy, error, now }) {
  const { rows } = await pool.query(
    `INSERT INTO integration_circuits (service, consecutive_failures, last_failure_at, last_error, updated_at)
     VALUES ($1, 1, $2, $3, $2)
     ON CONFLICT (service) DO UPDATE
       SET consecutive_failures = integration_circuits.consecutive_failures + 1,
           last_failure_at = $2, last_error = $3, updated_at = $2
     RETURNING *`,
    [service, now, String(error?.message ?? 'unknown').slice(0, 500)],
  );
  const c = rows[0];
  // A failed trial re-opens at once; otherwise the threshold decides.
  const opens = c.state === 'half_open' || (c.state === 'closed' && c.consecutive_failures >= policy.failureThreshold);
  if (!opens) return;

  await pool.query(
    `UPDATE integration_circuits SET state = 'open', opened_at = $2::timestamptz, updated_at = $2::timestamptz,
            retry_at = $2::timestamptz + make_interval(secs => $3::double precision)
      WHERE service = $1`,
    [service, now, policy.cooldownMs / 1000],
  );
  await recordAction({
    actor: ACTOR,
    action: 'integration.circuit_opened',
    entityType: 'integration',
    entityId: service,
    metadata: {
      service,
      consecutiveFailures: c.consecutive_failures,
      lastError: c.last_error,
      reopenedAfterTrial: c.state === 'half_open',
      cooldownSeconds: Math.round(policy.cooldownMs / 1000),
    },
  });
  // Told once per opening, and only on the first — a trial that fails
  // re-opens the circuit without paging anyone again.
  if (c.state === 'closed') await alertOperators({ service, policy, circuit: c });
}

/**
 * Tells the infrastructure team an integration has stopped answering — the
 * story's second clause, "logs the failure and alerts the administrator".
 *
 * The same recipients STORY-027 pages about outages: whoever holds
 * `system.operate`. Email is the one integration that cannot be alerted about
 * this way, and that is recorded rather than attempted.
 */
async function alertOperators({ service, policy, circuit }) {
  if (!policy.alertable) {
    await recordAction({
      actor: ACTOR,
      action: 'integration.alert_unreachable',
      entityType: 'integration',
      entityId: service,
      metadata: {
        service,
        reason: `${service} is the channel alerts are sent through, so its own outage cannot be announced by it. Visible on the Trust tab.`,
      },
    });
    return;
  }
  // Imported here, not at the top: healthMonitoring imports emailApi, which
  // imports this module.
  const { operators } = await import('../services/healthMonitoring.js');
  const { emailApi } = await import('../services/emailApi.js');
  const people = await operators();
  if (people.length === 0) {
    await recordAction({
      actor: ACTOR,
      action: 'integration.alert_unreachable',
      entityType: 'integration',
      entityId: service,
      metadata: { service, reason: 'No active account holds system.operate.' },
    });
    return;
  }
  const alerted = [];
  for (const person of people) {
    try {
      await emailApi.send({
        to: person.email,
        subject: `Integration down: ${service}`,
        body: [
          `The ${service} integration has failed ${circuit.consecutive_failures} calls in a row.`,
          `Last error: ${circuit.last_error}`,
          '',
          `The gateway has stopped calling it for ${Math.round(policy.cooldownMs / 1000)}s, then will let one`,
          'call through to test it. You will not be told again unless it recovers and fails again.',
          'Trust tab → External integrations.',
        ].join('\n'),
        via: 'system.alert_integration',
      });
      alerted.push(person.email);
    } catch (error) {
      // An alert that fails must not turn one broken integration into a
      // crashed request for the caller who happened to trip it.
      console.error(`[gateway] could not alert ${person.email}: ${error.message}`);
    }
  }
  await pool.query('UPDATE integration_circuits SET alerted_at = now() WHERE service = $1', [service]);
  await recordAction({
    actor: ACTOR,
    action: 'integration.alerted',
    entityType: 'integration',
    entityId: service,
    metadata: { service, operators: alerted },
  });
}

/** Every circuit that is not closed, for the dashboard and the governance check. */
export async function circuitStates(client = pool) {
  const { rows } = await client.query('SELECT * FROM integration_circuits ORDER BY service');
  return rows;
}

/** What each integration has been doing, for the trust dashboard and for incidents. */
export async function integrationHealth({ sinceHours = 24, authorId = null } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT service,
            -- A short-circuited call was never made. Counting it as a call and an
            -- attempt made an open circuit look like heavy traffic to a dead
            -- provider — the opposite of what happened (found in STORY-038's own
            -- screenshot).
            COUNT(*) FILTER (WHERE outcome <> 'short_circuited')::int                AS attempts,
            COUNT(DISTINCT call_id) FILTER (WHERE outcome <> 'short_circuited')::int AS calls,
            COUNT(*) FILTER (WHERE outcome = 'ok')::int            AS ok,
            COUNT(*) FILTER (WHERE outcome = 'timed_out')::int     AS timed_out,
            COUNT(*) FILTER (WHERE outcome = 'retrying')::int      AS retried,
            COUNT(*) FILTER (WHERE outcome = 'failed')::int        AS failed,
            COUNT(*) FILTER (WHERE outcome = 'short_circuited')::int AS short_circuited,
            ROUND(AVG(duration_ms) FILTER (WHERE outcome <> 'short_circuited'))::int AS avg_ms,
            MAX(duration_ms)::int                                  AS slowest_ms
       FROM api_interactions
      WHERE created_at > now() - make_interval(hours => $1)
        AND ($2::bigint IS NULL OR author_id = $2 OR author_id IS NULL)
      GROUP BY service ORDER BY service`,
    [sinceHours, authorId],
  );
  const circuits = new Map((await circuitStates(client)).map((c) => [c.service, c]));
  const { INTEGRATIONS } = await import('../services/integrationRoutes.js');

  // Every declared integration, not only the ones with traffic (STORY-038).
  // The directory search was absent from this panel for twenty stories because
  // the panel only listed what had been logged — and nothing was logging it.
  // A declared integration with no calls is shown as such, not left out.
  const byService = new Map(rows.map((r) => [r.service, r]));
  const services = [...new Set([...Object.keys(INTEGRATIONS), ...byService.keys()])].sort();
  return services.map((service) => {
    const r = byService.get(service) ?? {
      service, attempts: 0, calls: 0, ok: 0, timed_out: 0, retried: 0, failed: 0, short_circuited: 0,
      avg_ms: null, slowest_ms: null,
    };
    const route = INTEGRATIONS[service];
    const c = circuits.get(service);
    return {
      ...r,
      // Not in the registry: registered at runtime by the demo or a test.
      kind: route?.kind ?? 'registered at runtime (demo / tests)',
      policy: route
        ? { timeoutMs: route.timeoutMs, maxAttempts: route.maxAttempts, failureThreshold: route.failureThreshold, cooldownMs: route.cooldownMs }
        : null,
      circuit: c
        ? { state: c.state, consecutiveFailures: c.consecutive_failures, openedAt: c.opened_at, lastError: c.last_error, alertedAt: c.alerted_at }
        : { state: 'closed', consecutiveFailures: 0 },
    };
  });
}
