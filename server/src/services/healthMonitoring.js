/**
 * Health monitoring (STORY-027 / REQ-007) — Infrastructure and Deployment Agent.
 *
 * STORY-015 built `/health`, `/ready` and a release record, and none of it is
 * monitoring. Both endpoints answer when asked and the answer is discarded;
 * the `deployments` table calls an instance running until it writes a stop
 * row, which a process killed with SIGKILL cannot do; and the worker — the
 * process that runs every sweep — never recorded itself at all. So the system
 * could say "an instance started" and could never say "an instance died".
 *
 * Three things, each the smallest version that is real:
 *
 *   heartbeat — every process writes `last_seen_at` on a timer. Liveness is
 *     something a process *demonstrates*, not something it claimed at boot.
 *
 *   performHealthChecks — one function, run by the API on a timer, by the
 *     worker on its sweep, and by an operator on demand. It probes the
 *     database, reads every heartbeat, probes every API instance over HTTP,
 *     writes a `health_checks` row per target, and turns a component changing
 *     state into an `outages` row. The API checks so a dead worker is noticed;
 *     the worker checks so a dead API is. Neither notices itself — see the
 *     README for the probe that has to live outside both.
 *
 *   alertOnOutages — tells the accounts holding `system.operate`, once per
 *     outage. Not the tenant's reviewers, who are told about their content,
 *     and not on every sweep while it persists.
 *
 * The build note names Prometheus and PagerDuty. Neither is installed, neither
 * has an account, and a scrape config for a server that does not exist would
 * be the STORY-015 Dockerfile again. What is here is the part those tools sit
 * on top of: something that measures, something that remembers, something
 * that tells someone. Swapping the notifier for a pager is a change to one
 * call site, and the metrics endpoint they would scrape is the same row this
 * writes.
 */
import { hostname } from 'node:os';

import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

export const ACTOR = 'InfrastructureDeploymentAgent';

export const COMPONENTS = ['database', 'api', 'worker'];

/** This process, as the instance string `recordStart` wrote. */
export const thisInstance = () => `${hostname()}:${process.pid}`;

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * The row this process is beating on, once `startHeartbeat` has been called.
 * Module state for the same reason `draining` is in deployment.js: it is a
 * fact about this process, and the check that reads it runs in this process.
 */
let selfDeploymentId = null;

/** One beat: "still here, and here is what I have been doing." */
export async function heartbeat({ deploymentId, stats = null }, client = pool) {
  const { rows } = await client.query(
    `UPDATE deployments SET last_seen_at = now(), stats = COALESCE($2::jsonb, stats)
      WHERE id = $1 AND stopped_at IS NULL RETURNING id, last_seen_at`,
    [deploymentId, stats ? JSON.stringify(stats) : null],
  );
  return rows[0] ?? null;
}

/**
 * Beats on a timer until stopped. `unref` so the timer never holds a process
 * open that is otherwise finished — a heartbeat that prevents shutdown would
 * be the monitoring causing the outage.
 */
export function startHeartbeat({
  deploymentId,
  stats = null,
  everyMs = config.heartbeatSeconds * 1000,
  // Called when the row this instance was beating on is gone — `npm run
  // db:reset` under a running dev server does exactly that. Without it the
  // process keeps running, keeps answering, and is invisible to the monitor
  // for the rest of its life. Returns a fresh deployment row.
  reregister = null,
}) {
  let current = deploymentId;
  selfDeploymentId = current;
  const beat = async () => {
    try {
      const beaten = await heartbeat({ deploymentId: current, stats: stats ? stats() : null });
      if (!beaten && reregister) {
        const fresh = await reregister();
        console.error(`[health] deployment ${current} no longer exists — re-registered as ${fresh.id}`);
        current = fresh.id;
        selfDeploymentId = current;
      }
    } catch (error) {
      // Cannot reach the database to say we are alive. Say so on stderr —
      // the monitor will call this instance down, which is the right answer
      // from where it sits, and the log is the only place that can explain.
      console.error(`[health] heartbeat failed: ${error.message}`);
    }
  };
  const timer = setInterval(beat, everyMs);
  timer.unref();
  const stop = () => clearInterval(timer);
  stop.currentDeploymentId = () => current;
  return stop;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Probes an API instance from outside its own process.
 *
 * A heartbeat proves the event loop turns; it does not prove the instance can
 * answer a request. An instance wedged on a full connection pool still beats.
 * `/api/ready` is the question a load balancer asks, so it is the question
 * asked here, and a 503 is `degraded` rather than `down`: the process is
 * there and is saying, correctly, not to route to it.
 */
export async function defaultProbe(url) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${url}/api/ready`, {
      signal: AbortSignal.timeout(config.apiTimeoutMs),
    });
    const latencyMs = Date.now() - startedAt;
    if (response.ok) return { status: 'up', latencyMs, detail: `ready in ${latencyMs}ms` };
    let why = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      const failing = (body.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
      if (failing.length) why += ` — ${failing.join('; ')}`;
    } catch {
      /* body was not JSON; the status code is the finding */
    }
    return { status: response.status === 503 ? 'degraded' : 'down', latencyMs, detail: why };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - startedAt,
      detail: error.name === 'TimeoutError' ? `no answer in ${config.apiTimeoutMs}ms` : error.message,
    };
  }
}

const secondsBetween = (later, earlier) => Math.round((new Date(later) - new Date(earlier)) / 1000);

/**
 * Judges one instance from its heartbeat and, for an API, its probe.
 *
 * Heartbeat first: a process that has not spoken is down regardless of what
 * a probe says, because a probe that succeeds against a stale heartbeat means
 * the URL is answering and the row is not — two instances sharing a port, or
 * a row the process forgot. Either way the record is wrong, and "down" is the
 * answer that makes somebody look.
 */
async function judgeInstance(instance, { now, probe, selfId }) {
  // The checker can observe itself running — it is running this. Its own
  // heartbeat is refreshed rather than read, because the first real outage
  // this caught was the laptop it ran on going to sleep: on waking, the
  // monitor fired before the heartbeat did, read its own stale beat, and
  // paged the operators about the process that was paging them.
  if (selfId != null && Number(instance.id) === Number(selfId)) {
    await heartbeat({ deploymentId: instance.id });
    instance = { ...instance, last_seen_at: now };
  }
  const ageSeconds = instance.last_seen_at ? secondsBetween(now, instance.last_seen_at) : null;
  const stale = ageSeconds === null || ageSeconds > config.instanceStaleSeconds;

  if (stale) {
    return {
      status: 'down',
      latencyMs: null,
      detail:
        ageSeconds === null
          ? 'never sent a heartbeat'
          : `heartbeat ${ageSeconds}s old (limit ${config.instanceStaleSeconds}s)`,
      ageSeconds,
    };
  }

  if (instance.component === 'api' && instance.url && probe) {
    const probed = await probe(instance.url);
    return { ...probed, ageSeconds };
  }

  return { status: 'up', latencyMs: null, detail: `heartbeat ${ageSeconds}s ago`, ageSeconds };
}

/**
 * A component's status from its instances.
 *
 * `not_deployed` is its own answer, not a kind of down. A worker that has
 * never been started and a worker that died an hour ago look identical in a
 * count of live rows and are very different problems — the distinction the
 * trust dashboard has drawn since STORY-014, kept here for the same reason.
 */
function summarise(component, judged) {
  const mine = judged.filter((j) => j.component === component);
  if (mine.length === 0) return { status: 'not_deployed', up: 0, degraded: 0, down: 0, instances: 0 };
  const up = mine.filter((j) => j.status === 'up').length;
  const degraded = mine.filter((j) => j.status === 'degraded').length;
  const down = mine.filter((j) => j.status === 'down').length;
  const status = up > 0 ? (down + degraded > 0 ? 'degraded' : 'up') : degraded > 0 ? 'degraded' : 'down';
  return { status, up, degraded, down, instances: mine.length };
}

/**
 * Performs the checks, logs each one, and opens or resolves outages.
 *
 * Returns everything it decided so a caller — the worker's job result, the
 * demo, a test — can see the reasoning rather than only the verdict.
 */
export async function performHealthChecks({
  now = new Date(),
  probe = defaultProbe,
  checkedBy = thisInstance(),
  // The deployment row of the process running this check, if it has one.
  selfId = selfDeploymentId,
} = {}) {
  // The database first, and outside the transaction, because if this fails
  // there is no transaction to have. A database outage is detected by the
  // one process that cannot record it — the ceiling of self-monitoring, and
  // the reason an outside probe is still on the README's list.
  const dbStartedAt = Date.now();
  let database;
  try {
    await pool.query('SELECT 1');
    database = { status: 'up', latencyMs: Date.now() - dbStartedAt, detail: 'reachable' };
  } catch (error) {
    database = { status: 'down', latencyMs: Date.now() - dbStartedAt, detail: error.message };
    console.error(`[health] database unreachable: ${error.message}`);
    return {
      checkedAt: now,
      checkedBy,
      recorded: false,
      database,
      instances: [],
      components: { database, api: null, worker: null },
      started: [],
      resolved: [],
      retired: [],
    };
  }

  const { rows: live } = await pool.query(
    `SELECT * FROM deployments WHERE stopped_at IS NULL ORDER BY component, id`,
  );

  const judged = [];
  for (const instance of live) {
    const verdict = await judgeInstance(instance, { now, probe, selfId });
    judged.push({
      deploymentId: Number(instance.id),
      component: instance.component,
      instance: instance.instance,
      version: instance.version,
      url: instance.url,
      startedAt: instance.started_at,
      lastSeenAt: instance.last_seen_at,
      stats: instance.stats ?? {},
      ...verdict,
    });
  }

  const components = {
    database: { ...database, instances: 1, up: 1, degraded: 0, down: 0 },
    api: summarise('api', judged),
    worker: summarise('worker', judged),
  };

  return withTransaction(async (tx) => {
    // Log every check. The dashboard reads the latest per target; the history
    // is what answers "was it flapping or was it down".
    await tx.query(
      `INSERT INTO health_checks (checked_at, checked_by, component, target, status, latency_ms, detail)
       VALUES ($1,$2,'database','database',$3,$4,$5)`,
      [now, checkedBy, database.status, database.latencyMs, database.detail],
    );
    for (const j of judged) {
      await tx.query(
        `INSERT INTO health_checks
           (checked_at, checked_by, component, target, deployment_id, status, latency_ms, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        // Keyed on the deployment, not the instance string: `host:pid` is
        // reused across restarts — the demo data already had two rows
        // sharing one — and a test running the API and the worker in one
        // process shares it between components. The string is for reading.
        [now, checkedBy, j.component, `${j.component}:${j.instance}`, j.deploymentId, j.status, j.latencyMs, j.detail],
      );
    }

    // Retire the presumed dead. A row quiet for ten minutes is not coming
    // back — a process that was merely slow would have beaten forty times by
    // now — and leaving it in the live set means the component reads as down
    // forever after a replacement comes up. Closed with a reason that says
    // *presumed*, because nobody saw it die.
    const retired = [];
    for (const j of judged) {
      if (j.status !== 'down' || j.ageSeconds === null || j.ageSeconds <= config.instanceDeadSeconds) continue;
      const { rows } = await tx.query(
        `UPDATE deployments
            SET status = 'crashed', stopped_at = last_seen_at,
                stop_reason = $2
          WHERE id = $1 AND stopped_at IS NULL RETURNING *`,
        [j.deploymentId, `presumed dead: no heartbeat for ${j.ageSeconds}s`],
      );
      if (rows[0]) {
        retired.push(rows[0]);
        await recordAction(
          {
            actor: ACTOR,
            action: 'deployment.presumed_dead',
            entityType: 'deployment',
            entityId: j.deploymentId,
            metadata: {
              component: j.component,
              instance: j.instance,
              lastSeenAt: j.lastSeenAt,
              quietForSeconds: j.ageSeconds,
              checkedBy,
            },
          },
          tx,
        );
      }
    }

    // Transitions. Open where a component is down and no outage is open;
    // resolve where one is open and the component is answering again. A
    // component that is `not_deployed` neither opens nor resolves: it was
    // not expected, so it is not missing — unless an outage is already open
    // for it, in which case it was expected, is still gone, and stays open.
    const { rows: open } = await tx.query('SELECT * FROM outages WHERE resolved_at IS NULL');
    const openFor = new Map(open.map((o) => [o.component, o]));

    const started = [];
    const resolved = [];
    for (const component of COMPONENTS) {
      const summary = components[component];
      const existing = openFor.get(component);

      if (summary.status === 'down' && !existing) {
        // Down since the newest heartbeat any of its instances sent — the
        // honest start, as opposed to the moment somebody looked.
        const lastSeen = judged
          .filter((j) => j.component === component && j.lastSeenAt)
          .map((j) => new Date(j.lastSeenAt))
          .sort((a, b) => b - a)[0];
        const reasons = judged
          .filter((j) => j.component === component)
          .map((j) => `${j.instance}: ${j.detail}`)
          .join('; ');
        const { rows } = await tx.query(
          `INSERT INTO outages (component, down_since, detected_at, detected_by, reason)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT DO NOTHING RETURNING *`,
          [component, lastSeen ?? now, now, checkedBy, reasons],
        );
        // No row means another monitor opened it between our read and our
        // write. One outage, one episode — theirs.
        if (rows[0]) {
          started.push(rows[0]);
          await recordAction(
            {
              actor: ACTOR,
              action: 'outage.detected',
              entityType: 'outage',
              entityId: rows[0].id,
              after: { component, status: 'down' },
              metadata: {
                component,
                downSince: new Date(rows[0].down_since).toISOString(),
                // How long it took to notice. The number that grades the
                // monitoring rather than the system.
                detectionLagSeconds: secondsBetween(now, rows[0].down_since),
                reason: reasons,
                checkedBy,
              },
            },
            tx,
          );
        }
      } else if (existing && (summary.status === 'up' || summary.status === 'degraded')) {
        const { rows } = await tx.query(
          `UPDATE outages SET resolved_at = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
          [existing.id, now],
        );
        if (rows[0]) {
          resolved.push(rows[0]);
          await recordAction(
            {
              actor: ACTOR,
              action: 'outage.resolved',
              entityType: 'outage',
              entityId: existing.id,
              before: { component, status: 'down' },
              after: { component, status: summary.status },
              metadata: {
                component,
                downForSeconds: secondsBetween(now, existing.down_since),
                wasAlerted: existing.alerted_at !== null,
                checkedBy,
              },
            },
            tx,
          );
        }
      }
    }

    return {
      checkedAt: now,
      checkedBy,
      recorded: true,
      database,
      instances: judged,
      components,
      started,
      resolved,
      retired,
    };
  });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/** The infrastructure team: whoever holds the permission, not whoever has the title. */
export async function operators(client = pool) {
  const { rows } = await client.query(
    `SELECT u.id, u.email, u.name, u.role
       FROM users u
       JOIN role_permissions rp ON rp.role = u.role
      WHERE rp.permission = 'system.operate' AND u.active
      ORDER BY u.id`,
  );
  return rows;
}

/**
 * Tells the infrastructure team a component is down. Once per outage.
 *
 * Claims the outage before sending — `alerted_at` set in the same statement
 * that reads it — so two monitors that both detected the same outage do not
 * both page for it. Then, if nobody holds the permission, says so on the
 * record: an outage nobody could be told about is a second finding, not a
 * quiet one (STORY-012's rule for an unreachable queue).
 */
export async function alertOnOutages({ started, notifier = emailApi }) {
  if (!started || started.length === 0) return { alerted: [], reason: 'no new outage' };

  const { rows: claimed } = await pool.query(
    `UPDATE outages SET alerted_at = now()
      WHERE id = ANY($1::bigint[]) AND alerted_at IS NULL RETURNING *`,
    [started.map((o) => o.id)],
  );
  if (claimed.length === 0) return { alerted: [], reason: 'already alerted by another monitor' };

  const recipients = await operators();
  if (recipients.length === 0) {
    // Undo the claim: the outage was not alerted, and a later grant of the
    // permission should be able to hear about it if it is still open.
    await pool.query('UPDATE outages SET alerted_at = NULL WHERE id = ANY($1::bigint[])', [
      claimed.map((o) => o.id),
    ]);
    await recordAction({
      actor: ACTOR,
      action: 'outage.unreachable',
      entityType: 'outage',
      entityId: claimed.map((o) => o.id).join(','),
      metadata: {
        components: claimed.map((o) => o.component),
        reason: 'A component is down and no active account holds system.operate to be told.',
      },
    });
    return { alerted: [], reason: 'nobody holds system.operate' };
  }

  const subject = `Outage: ${claimed.map((o) => o.component).join(', ')} down`;
  const body = [
    'A component of the Author Launch Engine has stopped answering.',
    '',
    ...claimed.map(
      (o) =>
        `  ${o.component.padEnd(9)} down since ${new Date(o.down_since).toISOString()}` +
        ` (noticed ${new Date(o.detected_at).toISOString()} by ${o.detected_by})\n` +
        `            ${o.reason}`,
    ),
    '',
    'You will not be told again while this persists. Recovery is on the Trust',
    'tab and in the audit log as outage.resolved.',
  ].join('\n');

  const alerted = [];
  for (const person of recipients) {
    const sent = await notifier.send({
      to: person.email,
      subject,
      body,
      authorId: null,
      // A literal, not a constant: STORY-020's source scan reads this.
      via: 'system.alert_outage',
    });
    alerted.push({ operator: person.email, externalId: sent.externalId });
  }

  await recordAction({
    actor: ACTOR,
    action: 'outage.alerted',
    entityType: 'outage',
    entityId: claimed.map((o) => o.id).join(','),
    metadata: {
      components: claimed.map((o) => o.component),
      operators: alerted.map((a) => a.operator),
    },
  });

  return { alerted, reason: null };
}

/** Check, then tell. What the worker's sweep and the API's timer both do. */
export async function monitorAndAlert(options = {}) {
  const result = await performHealthChecks(options);
  const alert = result.recorded
    ? await alertOnOutages({ started: result.started, notifier: options.notifier })
    : { alerted: [], reason: 'database unreachable — nothing could be recorded or sent' };
  return { ...result, alert };
}

/**
 * Runs the monitor on a timer inside a process. Errors are logged and the
 * timer keeps going: a monitor that stops on its first failed check is a
 * monitor that stops exactly when it is needed.
 */
export function startMonitor({ everyMs = config.healthCheckSeconds * 1000 } = {}) {
  const run = async () => {
    try {
      const result = await monitorAndAlert({});
      for (const o of result.started) {
        console.error(`[health] OUTAGE ${o.component} — down since ${new Date(o.down_since).toISOString()}: ${o.reason}`);
      }
      for (const o of result.resolved) {
        console.log(`[health] recovered ${o.component} after ${secondsBetween(result.checkedAt, o.down_since)}s`);
      }
    } catch (error) {
      console.error(`[health] check failed: ${error.message}`);
    }
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Read-model
// ---------------------------------------------------------------------------

/**
 * What the dashboard shows. Assembled from rows the checks wrote, never
 * recomputed here — a status that a page derives for itself is a second
 * monitor, free to disagree with the first.
 */
export async function systemStatus({ limit = 20 } = {}, client = pool) {
  const { rows: latest } = await client.query(
    `SELECT DISTINCT ON (deployment_id) *
       FROM health_checks
      WHERE deployment_id IS NOT NULL
      ORDER BY deployment_id, checked_at DESC, id DESC`,
  );
  const { rows: databaseChecks } = await client.query(
    `SELECT * FROM health_checks WHERE target = 'database'
      ORDER BY checked_at DESC, id DESC LIMIT 1`,
  );
  const { rows: live } = await client.query(
    `SELECT id, component, instance, version, url, status, started_at, last_seen_at, stats
       FROM deployments WHERE stopped_at IS NULL ORDER BY component, id`,
  );
  const { rows: outages } = await client.query(
    `SELECT * FROM outages
      ORDER BY resolved_at IS NULL DESC, detected_at DESC LIMIT $1`,
    [limit],
  );
  const { rows: recent } = await client.query(
    `SELECT * FROM health_checks ORDER BY checked_at DESC, id DESC LIMIT $1`,
    [limit],
  );
  const { rows: lastCheck } = await client.query(
    'SELECT MAX(checked_at) AS at, COUNT(*)::int AS total FROM health_checks',
  );

  const latestFor = new Map(latest.map((c) => [Number(c.deployment_id), c]));
  const instances = live.map((d) => {
    const check = latestFor.get(Number(d.id));
    return {
      deploymentId: Number(d.id),
      component: d.component,
      instance: d.instance,
      version: d.version,
      url: d.url,
      startedAt: d.started_at,
      lastSeenAt: d.last_seen_at,
      stats: d.stats ?? {},
      // Null when no check has looked at it yet — which is different from
      // "up", and is said so.
      status: check?.status ?? null,
      latencyMs: check?.latency_ms ?? null,
      detail: check?.detail ?? 'not checked yet',
      checkedAt: check?.checked_at ?? null,
    };
  });

  const database = databaseChecks[0] ?? null;
  const openOutages = outages.filter((o) => o.resolved_at === null);
  const componentStatus = (component) => {
    if (openOutages.some((o) => o.component === component)) return 'down';
    const mine = instances.filter((i) => i.component === component);
    if (mine.length === 0) return 'not_deployed';
    if (mine.every((i) => i.status === null)) return 'unchecked';
    if (mine.some((i) => i.status === 'up') && mine.every((i) => i.status === 'up')) return 'up';
    if (mine.some((i) => i.status === 'up')) return 'degraded';
    return mine.some((i) => i.status === 'degraded') ? 'degraded' : 'down';
  };

  return {
    lastCheckAt: lastCheck[0].at,
    checksRecorded: lastCheck[0].total,
    components: {
      database: database
        ? { status: database.status, latencyMs: database.latency_ms, detail: database.detail, checkedAt: database.checked_at }
        : { status: 'unchecked', latencyMs: null, detail: 'not checked yet', checkedAt: null },
      api: { status: componentStatus('api'), instances: instances.filter((i) => i.component === 'api').length },
      worker: { status: componentStatus('worker'), instances: instances.filter((i) => i.component === 'worker').length },
    },
    instances,
    outages,
    openOutages: openOutages.length,
    recentChecks: recent,
    thresholds: {
      heartbeatSeconds: config.heartbeatSeconds,
      instanceStaleSeconds: config.instanceStaleSeconds,
      instanceDeadSeconds: config.instanceDeadSeconds,
      healthCheckSeconds: config.healthCheckSeconds,
    },
  };
}
