import { config } from '../config.js';
import { outsideTenantScope, pool } from '../db/pool.js';
import { CONFIDENCE, detectAnomalies } from './anomalies.js';
import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';
import { PERMISSIONS, holds } from './permissions.js';
import { securityOfficers } from './securityNotifications.js';

/**
 * Anomaly detection and escalation (STORY-059 / REQ-015, REQ-006) — Trust and
 * Monitoring Agent.
 *
 *   When an anomaly is detected, it is escalated to a human within 5 minutes,
 *   and shown prominently on the trust dashboard with details and status.
 *
 * Rule-based, on purpose: every detector says what it counted, over what
 * window, against what threshold — so a person told "anomaly" can check the
 * claim. The STORY-014 content detectors (rubber-stamping, never-rejects,
 * near-duplicates, drafter disagreement) are joined by five that watch what
 * the system *does*: refused requests, failed jobs, failed payments, a burst
 * of approvals no one could have read, and a tenant's activity far above its
 * own normal. A detector with too little history declines rather than guesses.
 *
 * The worker scans every ANOMALY_SCAN_SECONDS (60 by default). A new anomaly
 * is escalated in the scan that finds it — emailed to the security officers
 * and, for a tenant's anomaly, that tenant's reviewers — so detection to
 * escalation is one scan, well inside the five minutes. The governance check
 * `anomalies.escalated_in_time` counts any that were not.
 */
export const ACTOR = 'TrustMonitoringAgent';

/** The system-activity detectors. Each returns findings: { authorId, subject, severity, summary, details }. */
export const SYSTEM_DETECTORS = [
  {
    id: 'access.refused_burst',
    label: 'A burst of refused requests',
    async detect(now) {
      const { rows } = await pool.query(
        `SELECT author_id, COUNT(*)::int AS refused, COUNT(DISTINCT COALESCE(user_id::text, ip))::int AS sources
           FROM data_access_events
          WHERE outcome IN ('denied', 'unauthenticated') AND occurred_at > $1::timestamptz - make_interval(mins => $2)
          GROUP BY author_id HAVING COUNT(*) >= $3`,
        [now, config.anomalyWindowMinutes, config.anomalyRefusedThreshold],
      );
      return rows.map((r) => ({
        authorId: r.author_id, subject: `tenant:${r.author_id ?? 'none'}`, severity: 'high',
        summary: `${r.refused} refused requests in ${config.anomalyWindowMinutes} minutes`,
        details: { refused: r.refused, sources: r.sources, windowMinutes: config.anomalyWindowMinutes, threshold: config.anomalyRefusedThreshold },
      }));
    },
  },
  {
    id: 'jobs.failure_spike',
    label: 'Background work failing repeatedly',
    async detect(now) {
      const { rows } = await pool.query(
        `SELECT author_id, COUNT(*)::int AS dead, array_agg(DISTINCT kind) AS kinds
           FROM jobs WHERE status = 'dead_letter' AND finished_at > $1::timestamptz - make_interval(mins => $2)
          GROUP BY author_id HAVING COUNT(*) >= $3`,
        [now, config.anomalyWindowMinutes, config.anomalyJobFailures],
      );
      return rows.map((r) => ({
        authorId: r.author_id, subject: `tenant:${r.author_id ?? 'system'}`, severity: 'high',
        summary: `${r.dead} jobs gave up in ${config.anomalyWindowMinutes} minutes (${r.kinds.join(', ')})`,
        details: { deadLettered: r.dead, kinds: r.kinds, windowMinutes: config.anomalyWindowMinutes, threshold: config.anomalyJobFailures },
      }));
    },
  },
  {
    id: 'payments.failure_spike',
    label: 'Several payments failing',
    async detect(now) {
      const { rows: [r] } = await pool.query(
        `SELECT COUNT(*)::int AS failed, COUNT(DISTINCT author_id)::int AS tenants
           FROM payments WHERE status = 'failed' AND created_at > $1::timestamptz - interval '1 hour'`,
        [now],
      );
      return r.failed >= config.anomalyPaymentFailures ? [{
        authorId: null, subject: 'system', severity: 'medium',
        summary: `${r.failed} payments failed in the last hour, across ${r.tenants} tenant(s)`,
        details: { failed: r.failed, tenants: r.tenants, threshold: config.anomalyPaymentFailures },
      }] : [];
    },
  },
  {
    id: 'approvals.burst',
    label: 'More approvals in a minute than anyone could read',
    async detect(now) {
      const { rows } = await pool.query(
        `SELECT a.reviewer, COALESCE(d.author_id, o.author_id, p.author_id) AS author_id, COUNT(*)::int AS decisions,
                MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at
           FROM approvals a
           LEFT JOIN drafts d ON d.id = a.draft_id
           LEFT JOIN outreach_messages o ON o.id = a.outreach_message_id
           LEFT JOIN pr_materials p ON p.id = a.pr_material_id
          WHERE a.decision = 'approved' AND a.created_at > $1::timestamptz - interval '1 minute'
          GROUP BY a.reviewer, COALESCE(d.author_id, o.author_id, p.author_id)
         HAVING COUNT(*) >= $2`,
        [now, config.anomalyBulkApprovals],
      );
      return rows.map((r) => ({
        authorId: r.author_id, subject: `tenant:${r.author_id}:reviewer:${r.reviewer}`, severity: 'high',
        summary: `${r.reviewer} approved ${r.decisions} items within a minute`,
        details: { reviewer: r.reviewer, approvals: r.decisions, firstAt: r.first_at, lastAt: r.last_at, threshold: config.anomalyBulkApprovals },
      }));
    },
  },
  {
    id: 'activity.volume_spike',
    label: 'A tenant far busier than its own normal',
    async detect(now) {
      // Recent window against the tenant's own last 24 hours, per window of the
      // same length. Declines without a day of history: a new tenant's first
      // hour is not a spike, it is a start.
      const { rows } = await pool.query(
        `WITH t AS (
           SELECT tenant_id AS author_id,
                  COUNT(*) FILTER (WHERE created_at > $1::timestamptz - make_interval(mins => $2))::int AS recent,
                  COUNT(*) FILTER (WHERE created_at <= $1::timestamptz - make_interval(mins => $2)
                                     AND created_at > $1::timestamptz - interval '24 hours')::int AS before,
                  MIN(created_at) AS first_at
             FROM audit_rows_since($1::timestamptz - interval '24 hours')
            WHERE tenant_id IS NOT NULL GROUP BY tenant_id)
         SELECT * FROM t WHERE first_at < $1::timestamptz - interval '23 hours'`,
        [now, config.anomalyWindowMinutes],
      );
      const windows = (24 * 60) / config.anomalyWindowMinutes - 1;
      return rows
        .map((r) => ({ ...r, baseline: r.before / windows }))
        .filter((r) => r.recent >= config.anomalyVolumeMin && r.recent >= config.anomalyVolumeFactor * Math.max(r.baseline, 1))
        .map((r) => ({
          authorId: r.author_id, subject: `tenant:${r.author_id}`, severity: 'medium',
          summary: `${r.recent} actions in ${config.anomalyWindowMinutes} minutes — ${(r.recent / Math.max(r.baseline, 1)).toFixed(1)}× this tenant's usual ${r.baseline.toFixed(1)}`,
          details: { recent: r.recent, baselinePerWindow: Number(r.baseline.toFixed(2)), factor: config.anomalyVolumeFactor, minimum: config.anomalyVolumeMin },
        }));
    },
  },
];

/** STORY-014's content detectors, per active tenant, as findings of the same shape. */
async function contentFindings(now) {
  const { rows: tenants } = await pool.query(
    "SELECT DISTINCT author_id FROM drafts WHERE author_id IS NOT NULL AND created_at > $1::timestamptz - interval '7 days'",
    [now],
  );
  const out = [];
  for (const { author_id: authorId } of tenants) {
    const result = await detectAnomalies({ authorId });
    for (const d of result.detectors.filter((x) => x.confidence === CONFIDENCE.REPORTED)) {
      for (const f of d.findings) {
        const key = f.reviewer ?? (f.draftIds ? [...f.draftIds].sort().join(',') : null) ?? JSON.stringify(f).slice(0, 120);
        out.push({
          detector: d.id, authorId, subject: `tenant:${authorId}:${key}`, severity: 'medium',
          summary: `${d.label}${f.reviewer ? ` — ${f.reviewer}` : ''}`,
          details: { ...f, because: d.because },
        });
      }
    }
  }
  return out;
}

async function recipientsFor(event) {
  const officers = (await securityOfficers()).map((o) => o.email);
  // A resource alert is the operators' (STORY-062): whoever holds system.operate.
  if (event.detector.startsWith('prometheus.')) {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.email FROM users u JOIN role_permissions rp ON rp.role = u.role
        WHERE rp.permission = 'system.operate' AND u.active`,
    );
    return [...new Set([...rows.map((r) => r.email), ...officers])];
  }
  const reviewers = event.author_id
    ? (await pool.query('SELECT email FROM reviewers WHERE author_id = $1 AND active', [event.author_id])).rows.map((r) => r.email)
    : [];
  return [...new Set([...officers, ...reviewers])];
}

async function escalate(event) {
  const to = await recipientsFor(event);
  const delivered = [];
  const failed = [];
  const { rows: [author] } = event.author_id ? await pool.query('SELECT name FROM authors WHERE id = $1', [event.author_id]) : { rows: [] };
  for (const address of to) {
    try {
      await emailApi.send({
        to: address,
        via: 'trust.escalate_anomaly',
        authorId: event.author_id,
        subject: `Anomaly (${event.severity}): ${event.summary}`,
        body: [
          `Detected ${new Date(event.detected_at).toISOString().replace('T', ' ').slice(0, 19)} UTC${author ? ` for ${author.name}` : ' across the system'}.`,
          '',
          event.summary,
          `Detector: ${event.detector}`,
          ...Object.entries(event.details).map(([k, v]) => `  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`),
          '',
          `Review it on the Trust tab: ${config.appUrl}/trust`,
        ].join('\n'),
      });
      delivered.push(address);
    } catch (error) {
      failed.push(`${address}: ${error.message}`.slice(0, 200));
    }
  }
  // Escalated only if somebody was actually told. Otherwise the next scan tries again.
  const { rows: [updated] } = await pool.query(
    `UPDATE anomaly_events SET escalated_at = CASE WHEN $2::int > 0 THEN now() ELSE NULL END,
            escalated_to = $3, escalation_failed = $4 WHERE id = $1 RETURNING *`,
    [event.id, delivered.length, delivered, failed],
  );
  await recordAction({
    actor: ACTOR,
    action: delivered.length ? 'anomaly.escalated' : 'anomaly.escalation_failed',
    entityType: 'anomaly', entityId: String(event.id), authorId: event.author_id,
    metadata: { detector: event.detector, severity: event.severity, to: delivered, failed: failed.length,
      secondsToEscalate: delivered.length ? Math.round((new Date(updated.escalated_at) - new Date(event.detected_at)) / 1000) : null },
  });
  return updated;
}

/**
 * One scan: run every detector, record what is new (or seen again), and
 * escalate everything not yet escalated. Idempotent: a second scan over the
 * same state raises nothing new.
 */
export async function scanAndEscalate({ now = new Date() } = {}) {
  return outsideTenantScope(async () => {
    const findings = [];
    for (const d of SYSTEM_DETECTORS) {
      for (const f of await d.detect(now)) findings.push({ ...f, detector: d.id });
    }
    findings.push(...await contentFindings(now));

    // Logs outlive their tenants: a burst in the access log can name an author
    // deleted since. Nobody is left to tell, and storing it would fail the
    // whole scan — every other anomaly unescalated with it. Skipped, and counted.
    const { rows: live } = await pool.query('SELECT id FROM authors');
    const exists = new Set(live.map((a) => String(a.id)));
    const gone = findings.filter((f) => f.authorId != null && !exists.has(String(f.authorId)));
    const current = findings.filter((f) => !gone.includes(f));

    const raised = [];
    let deletedMidScan = 0;
    for (const f of current) {
      // The tenant can also be deleted between the check above and this insert.
      // One finding lost to that is skipped; it must not take the scan with it.
      const inserted = await pool.query(
        `INSERT INTO anomaly_events (author_id, detector, fingerprint, severity, summary, details, detected_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (fingerprint) WHERE status IN ('open', 'acknowledged')
         DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, occurrences = anomaly_events.occurrences + 1,
                       summary = EXCLUDED.summary, details = EXCLUDED.details
         RETURNING *, (xmax = 0) AS inserted`,
        [f.authorId, f.detector, `${f.detector}|${f.subject}`, f.severity, f.summary, f.details, now],
      ).catch((error) => {
        if (error.code === '23503') return null; // foreign key: the tenant is gone
        throw error;
      });
      if (!inserted) {
        deletedMidScan += 1;
        continue;
      }
      const [row] = inserted.rows;
      if (row.inserted) {
        raised.push(row);
        await recordAction({ actor: ACTOR, action: 'anomaly.detected', entityType: 'anomaly', entityId: String(row.id),
          authorId: row.author_id, metadata: { detector: row.detector, severity: row.severity, summary: row.summary } });
      }
    }
    const { rows: pending } = await pool.query("SELECT * FROM anomaly_events WHERE escalated_at IS NULL AND status IN ('open', 'acknowledged') ORDER BY id");
    const escalated = [];
    for (const e of pending) escalated.push(await escalate(e));
    return { findings: current.length, skippedDeletedTenants: gone.length + deletedMidScan, raised, escalated };
  });
}

/** Runs the scan on a timer inside the worker, like the health monitor. */
export function startAnomalyScan({ everyMs = config.anomalyScanSeconds * 1000 } = {}) {
  const run = async () => {
    try {
      const r = await scanAndEscalate({});
      for (const e of r.escalated) console.log(`[anomaly] ${e.severity} ${e.detector}: ${e.summary} → ${e.escalated_to.length} told`);
    } catch (error) {
      console.error(`[anomaly] scan failed: ${error.message}`);
    }
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** What the dashboard shows: a tenant's anomalies, and the system's to those who read across tenants. */
export async function listAnomalies({ authorId, user, limit = 50 }) {
  return outsideTenantScope(async () => {
    const all = holds(user, PERMISSIONS.TENANT_READ_ALL);
    const { rows } = await pool.query(
      `SELECT e.*, a.name AS author_name FROM anomaly_events e LEFT JOIN authors a ON a.id = e.author_id
        WHERE e.author_id = $1 ${all ? 'OR e.author_id IS NULL' : ''}
        ORDER BY (e.status IN ('open', 'acknowledged')) DESC, (e.severity = 'high') DESC, e.detected_at DESC LIMIT $2`,
      [Number(authorId), limit],
    );
    const live = rows.filter((r) => ['open', 'acknowledged'].includes(r.status));
    return {
      open: live.filter((r) => r.status === 'open').length,
      acknowledged: live.filter((r) => r.status === 'acknowledged').length,
      events: rows,
      scanEverySeconds: config.anomalyScanSeconds,
      escalateWithinMinutes: config.anomalyEscalateMinutes,
    };
  });
}

/** Acknowledge, resolve or dismiss. A tenant's own approver may; system-wide ones need audit.verify. */
export async function updateAnomaly({ id, action, note = '', user }) {
  return outsideTenantScope(async () => {
    const { rows: [e] } = await pool.query('SELECT * FROM anomaly_events WHERE id = $1', [id]);
    if (!e) throw Object.assign(new Error('No such anomaly'), { status: 404 });
    const staff = holds(user, PERMISSIONS.AUDIT_VERIFY) || holds(user, PERMISSIONS.TENANT_ACT_ALL);
    const own = e.author_id != null && Number(user.authorId) === Number(e.author_id) && holds(user, PERMISSIONS.CONTENT_APPROVE);
    if (!staff && !own) throw Object.assign(new Error('Not yours to act on'), { status: 403 });
    if (!['open', 'acknowledged'].includes(e.status)) throw Object.assign(new Error(`Already ${e.status}`), { status: 409 });
    if (action !== 'acknowledge' && !note.trim()) throw Object.assign(new Error('Say what was found or done'), { status: 400 });
    const who = user.name ?? user.email;
    const { rows: [u] } = await pool.query(
      action === 'acknowledge'
        ? "UPDATE anomaly_events SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 RETURNING *"
        : `UPDATE anomaly_events SET status = $3, resolved_by = $2, resolved_at = now(), resolution_note = $4,
                  acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, now())
            WHERE id = $1 RETURNING *`,
      action === 'acknowledge' ? [id, who] : [id, who, action === 'dismiss' ? 'dismissed' : 'resolved', note],
    );
    await recordAction({ actor: who, action: `anomaly.${u.status}`, entityType: 'anomaly', entityId: String(id), authorId: e.author_id,
      before: { status: e.status }, after: { status: u.status }, metadata: { note } });
    return u;
  });
}

/**
 * Alerts from Prometheus (STORY-062), delivered by Alertmanager's webhook.
 * A firing alert becomes an anomaly like any other — stored once, escalated
 * to people, shown on the Trust tab — and its `resolved` notice closes it.
 * One path for "something needs a person", whichever monitor noticed.
 */
export async function recordPrometheusAlerts(payload, { now = new Date() } = {}) {
  return outsideTenantScope(async () => {
    const out = [];
    for (const a of payload?.alerts ?? []) {
      const name = a.labels?.alertname ?? 'unnamed';
      const fingerprint = `prometheus.${name}|${a.fingerprint ?? JSON.stringify(a.labels ?? {})}`;
      if (a.status === 'resolved') {
        const { rows: [closed] } = await pool.query(
          `UPDATE anomaly_events SET status = 'resolved', resolved_by = 'Prometheus', resolved_at = now(),
                  resolution_note = 'The alert condition cleared.', acknowledged_by = COALESCE(acknowledged_by, 'Prometheus'),
                  acknowledged_at = COALESCE(acknowledged_at, now())
            WHERE fingerprint = $1 AND status IN ('open', 'acknowledged') RETURNING *`,
          [fingerprint],
        );
        if (closed) {
          await recordAction({ actor: 'Prometheus', action: 'anomaly.resolved', entityType: 'anomaly', entityId: String(closed.id), metadata: { alert: name } });
          out.push({ alert: name, status: 'resolved', id: closed.id });
        }
        continue;
      }
      const { rows: [row] } = await pool.query(
        `INSERT INTO anomaly_events (author_id, detector, fingerprint, severity, summary, details, detected_at, last_seen_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (fingerprint) WHERE status IN ('open', 'acknowledged')
         DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, occurrences = anomaly_events.occurrences + 1
         RETURNING *, (xmax = 0) AS inserted`,
        [`prometheus.${name}`, fingerprint, a.labels?.severity === 'critical' || a.labels?.severity === 'high' ? 'high' : 'medium',
          a.annotations?.summary ?? name,
          { description: a.annotations?.description ?? null, labels: a.labels ?? {}, startsAt: a.startsAt ?? null, source: 'prometheus' }, now],
      );
      if (row.inserted) {
        await recordAction({ actor: 'Prometheus', action: 'anomaly.detected', entityType: 'anomaly', entityId: String(row.id), metadata: { alert: name, severity: row.severity } });
        out.push({ alert: name, status: 'firing', id: row.id, escalated: (await escalate(row)).escalated_at != null });
      } else {
        out.push({ alert: name, status: 'firing', id: row.id, repeat: true });
      }
    }
    return { received: payload?.alerts?.length ?? 0, handled: out };
  });
}
