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

import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';

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
  maxAttempts = config.apiMaxAttempts,
  timeoutMs = config.apiTimeoutMs,
  backoffMs = config.apiBackoffMs,
  sleep = wait,
}) {
  const callId = randomUUID();
  let lastError = null;

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
        status: result?.status ?? 200,
        durationMs: Date.now() - started,
        authorId,
      });

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
    throw new ExternalApiError(`HTTP ${response.status}: ${body.slice(0, 200)}`, {
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers),
    });
  }

  return response.json();
}

/** What each integration has been doing, for the trust dashboard and for incidents. */
export async function integrationHealth({ sinceHours = 24, authorId = null } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT service,
            COUNT(*)::int                                        AS attempts,
            COUNT(DISTINCT call_id)::int                         AS calls,
            COUNT(*) FILTER (WHERE outcome = 'ok')::int          AS ok,
            COUNT(*) FILTER (WHERE outcome = 'timed_out')::int   AS timed_out,
            COUNT(*) FILTER (WHERE outcome = 'retrying')::int    AS retried,
            COUNT(*) FILTER (WHERE outcome = 'failed')::int      AS failed,
            ROUND(AVG(duration_ms))::int                         AS avg_ms,
            MAX(duration_ms)::int                                AS slowest_ms
       FROM api_interactions
      WHERE created_at > now() - make_interval(hours => $1)
        AND ($2::bigint IS NULL OR author_id = $2 OR author_id IS NULL)
      GROUP BY service ORDER BY service`,
    [sinceHours, authorId],
  );
  return rows;
}
