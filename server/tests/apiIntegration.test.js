/**
 * STORY-016 acceptance tests.
 *
 * The clause — an agent needs external data, the API is called, the data comes
 * back — passed before this story existed. Adapters for the social platforms,
 * email and the directories were all written to the shape of a real client, and
 * the demo makes 48 outbound calls through them.
 *
 * What a mock cannot test is the ways a real provider fails, so the code around
 * it had never had to be right. Nothing had a timeout — a bare `fetch` in Node
 * has none, and against a provider that accepts a connection and never answers
 * it hangs indefinitely. Nothing distinguished a 429 from a 400. And the trust
 * clause asks that all API interactions be logged; none were.
 *
 * Requires a migrated database. Run:  npm run db:reset && npm test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  ACTOR,
  ExternalApiError,
  RETRYABLE_STATUS,
  callExternal,
  httpJson,
  integrationHealth,
  isRetryable,
  retryAfterMs,
} from '../src/agents/apiIntegrationAgent.js';
import { closePool, query } from '../src/db/pool.js';

/** No real waiting: backoff is policy, and sleeping proves nothing. */
const nosleep = () => Promise.resolve();
const SERVICE = `test-${Date.now()}`;

const attemptsFor = async (operation) => {
  const { rows } = await query(
    `SELECT attempt, outcome, status, retryable, duration_ms FROM api_interactions
      WHERE service = $1 AND operation = $2 ORDER BY attempt`,
    [SERVICE, operation],
  );
  return rows;
};

after(async () => {
  await query('DELETE FROM api_interactions WHERE service = $1', [SERVICE]);
  await closePool();
});

describe('STORY-016: external APIs are called, and the data comes back', () => {
  it('returns what the provider returned', async () => {
    const result = await callExternal({
      service: SERVICE,
      operation: 'happy',
      sleep: nosleep,
      fn: async () => ({ data: 'from the provider' }),
    });
    assert.deepEqual(result, { data: 'from the provider' });
  });

  it('records the interaction, which nothing did before this story', async () => {
    const rows = await attemptsFor('happy');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'ok');
    assert.ok(rows[0].duration_ms >= 0, 'and how long the provider took');
  });

  it('passes an abort signal the adapter is expected to honour', async () => {
    let sawSignal = false;
    await callExternal({
      service: SERVICE,
      operation: 'signal',
      sleep: nosleep,
      fn: async (signal) => {
        sawSignal = signal instanceof AbortSignal;
        return {};
      },
    });
    assert.equal(sawSignal, true);
  });
});

describe('Retrying the right failures, and not the wrong ones', () => {
  it('classifies a rate limit and a server error as worth another go', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      assert.equal(isRetryable({ status }), true, `${status} should retry`);
      assert.ok(RETRYABLE_STATUS.has(status));
    }
  });

  it('classifies a rejected request as an answer, not a fault', () => {
    // Asking again gets the same refusal more slowly.
    for (const status of [400, 401, 403, 404, 422]) {
      assert.equal(isRetryable({ status }), false, `${status} should not retry`);
    }
  });

  it('retries something that never reached a server', () => {
    // No status at all is DNS, a refused connection, a reset socket — nothing
    // was refused, the request simply did not complete.
    assert.equal(isRetryable(new Error('ECONNRESET')), true);
    assert.equal(isRetryable({ name: 'TimeoutError' }), true);
  });

  it('succeeds on a later attempt after a rate limit', async () => {
    let calls = 0;
    const result = await callExternal({
      service: SERVICE,
      operation: 'flaky',
      sleep: nosleep,
      fn: async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('rate limited'), { status: 429 });
        return { ok: true };
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);

    const rows = await attemptsFor('flaky');
    assert.deepEqual(rows.map((r) => r.outcome), ['retrying', 'retrying', 'ok']);
    assert.equal(rows[0].status, 429);
  });

  it('gives up immediately on a rejected request', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        callExternal({
          service: SERVICE,
          operation: 'rejected',
          sleep: nosleep,
          fn: async () => {
            calls += 1;
            throw Object.assign(new Error('malformed'), { status: 400 });
          },
        }),
      /malformed/,
    );
    assert.equal(calls, 1, 'one attempt, because the provider already answered');

    const rows = await attemptsFor('rejected');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'failed');
    assert.equal(rows[0].retryable, false);
  });

  it('stores whether a failure was retryable, rather than re-deriving it later', async () => {
    // The policy may change; a decision has to stay answerable in the terms it
    // was actually made under.
    const rows = await attemptsFor('flaky');
    assert.equal(rows[0].retryable, true);
  });

  it('honours a Retry-After the provider sends, over its own schedule', async () => {
    assert.equal(retryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs(new Headers({ 'retry-after': future }));
    assert.ok(ms > 3000 && ms <= 5000, `got ${ms}`);
    assert.equal(retryAfterMs(new Headers()), null);

    let waited = null;
    let calls = 0;
    await callExternal({
      service: SERVICE,
      operation: 'retry-after',
      sleep: async (ms_) => {
        waited = ms_;
      },
      fn: async () => {
        calls += 1;
        if (calls === 1) {
          throw new ExternalApiError('slow down', { status: 429, retryAfterMs: 7777 });
        }
        return {};
      },
    });
    assert.equal(waited, 7777, 'the provider knows better than our backoff');
  });

  it('backs off exponentially when the provider says nothing', async () => {
    const waits = [];
    let calls = 0;
    await assert.rejects(() =>
      callExternal({
        service: SERVICE,
        operation: 'backoff',
        backoffMs: 100,
        maxAttempts: 3,
        sleep: async (ms) => waits.push(ms),
        fn: async () => {
          calls += 1;
          throw Object.assign(new Error('unavailable'), { status: 503 });
        },
      }),
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [100, 200], 'doubling, and no sleep after the last attempt');
  });
});

describe('A provider that never answers', () => {
  it('is abandoned rather than waited on forever', async () => {
    // The bug this story exists to close. Verified against a real socket
    // elsewhere; here the adapter simply honours the signal it is handed.
    await assert.rejects(
      () =>
        callExternal({
          service: SERVICE,
          operation: 'hangs',
          timeoutMs: 200,
          maxAttempts: 2,
          sleep: nosleep,
          fn: (signal) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
            }),
        }),
      /did not respond within 200ms/,
    );

    const rows = await attemptsFor('hangs');
    assert.equal(rows.length, 2);
    // Distinguished from a failure: one is the provider being slow, the other
    // is this process deciding to stop waiting.
    assert.ok(rows.every((r) => r.outcome === 'timed_out'));
    assert.ok(rows.every((r) => r.status === null));
  });

  it('records giving up on the audit log, not only in the interactions table', async () => {
    const { rows } = await query(
      `SELECT actor, metadata FROM audit_log
        WHERE action = 'api.call_failed' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0].actor, ACTOR);
    assert.equal(rows[0].metadata.gaveUp, true);
    assert.ok(rows[0].metadata.service);
  });
});

describe('httpJson turns a provider response into something classifiable', () => {
  it('raises a non-2xx as an error carrying the status', async () => {
    const server = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '3', 'content-type': 'application/json' });
      res.end('{"error":"slow down"}');
    });
    await new Promise((r) => server.listen(0, r));
    const { port } = server.address();
    try {
      await assert.rejects(
        () => httpJson(`http://localhost:${port}/`, {}),
        (error) => {
          assert.equal(error.status, 429);
          assert.equal(error.retryAfterMs, 3000, 'and what the provider asked for');
          assert.equal(isRetryable(error), true);
          return true;
        },
      );
    } finally {
      server.close();
    }
  });

  it('returns parsed JSON on success', async () => {
    const server = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"content":[{"text":"hello"}]}');
    });
    await new Promise((r) => server.listen(0, r));
    const { port } = server.address();
    try {
      const body = await httpJson(`http://localhost:${port}/`, {});
      assert.equal(body.content[0].text, 'hello');
    } finally {
      server.close();
    }
  });
});

describe('Every adapter goes through the agent', () => {
  it('routes the social publishers', async () => {
    const { getSocialApi } = await import('../src/services/socialApis.js');
    const before = (await integrationHealth({ sinceHours: 1 })).find((s) => s.service === 'twitter');
    await getSocialApi('twitter').publish({ content: 'a short post', scheduledFor: null });
    const after_ = (await integrationHealth({ sinceHours: 1 })).find((s) => s.service === 'twitter');
    assert.ok(after_.calls > (before?.calls ?? 0), 'the call was recorded');
  });

  it('treats content the platform rejects as an answer, not a fault', async () => {
    const { getSocialApi } = await import('../src/services/socialApis.js');
    const tooLong = 'x'.repeat(400);
    await assert.rejects(
      () => getSocialApi('twitter').publish({ content: tooLong, scheduledFor: null }),
      /exceeds 280/,
    );
    const { rows } = await query(
      `SELECT attempt, retryable FROM api_interactions
        WHERE service = 'twitter' AND outcome = 'failed' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0].attempt, 1, 'not retried — the platform already answered');
    assert.equal(rows[0].retryable, false);
  });

  it('routes the email provider', async () => {
    const { emailApi } = await import('../src/services/emailApi.js');
    await emailApi.send({ to: 'someone@example.test', subject: 's', body: 'b' });
    const health = await integrationHealth({ sinceHours: 1 });
    assert.ok(health.some((s) => s.service === 'email'));
  });

  it('reports per-service health, with retries visible', async () => {
    const health = await integrationHealth({ sinceHours: 1 });
    const probe = health.find((s) => s.service === SERVICE);
    assert.ok(probe);
    // Attempts above calls is the early signal: the provider is still working,
    // and working harder than it should.
    assert.ok(probe.attempts >= probe.calls);
    assert.ok(probe.retried > 0, 'this suite deliberately caused retries');
  });
});
