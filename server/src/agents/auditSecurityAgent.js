/**
 * Audit and Security Agent (STORY-013).
 *
 * The audit half of that name has worked since STORY-001: every agent calls
 * `recordAction`, and an inventory of what mutates state against what writes an
 * audit row comes back clean. The table refuses UPDATE, DELETE and TRUNCATE by
 * trigger.
 *
 * The security half had nothing behind it. Append-only is a *policy* here, and a
 * policy can be switched off — `ALTER TABLE audit_log DISABLE TRIGGER ALL`,
 * edit, re-enable — after which the log still refuses every ordinary mutation
 * and nothing can tell that history was rewritten. Prevention without detection.
 *
 * So this agent does the detection. It seals ranges of the log with a chained
 * digest and later recomputes those digests from the live rows. It cannot stop
 * anyone; it can make sure that afterwards somebody knows.
 */
import { createHash } from 'node:crypto';

import { pool } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';

export const ACTOR = 'AuditSecurityAgent';

/** The chain has to start somewhere. */
export const GENESIS = 'genesis';

/** What verification can conclude. */
export const INTEGRITY = {
  INTACT: 'intact',
  ALTERED: 'altered',
  UNSEALED: 'nothing_sealed_yet',
};

/**
 * Field separator for hashing.
 *
 * A character that cannot appear in the data, so two different rows cannot
 * serialise to the same string by moving a boundary — an actor of "a" with an
 * action of "bc" must not hash the same as "ab" with "c".
 */
const SEP = '';

/**
 * One row, serialised so the same row always produces the same bytes.
 *
 * Every field that carries meaning is in here. Leaving `metadata` out would let
 * someone rewrite the reason for a decision — the thresholds it was judged
 * against, who the session belonged to — while the digest still matched, which
 * would be a worse guarantee than none because it would be believed.
 *
 * JSON columns are stringified with sorted keys: Postgres does not promise to
 * return jsonb keys in any particular order, and a digest that depended on key
 * order would report tampering every time the planner felt different.
 */
export function canonicalise(row) {
  const json = (value) => {
    if (value === null || value === undefined) return '';
    const sort = (v) =>
      Array.isArray(v)
        ? v.map(sort)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]))
          : v;
    return JSON.stringify(sort(value));
  };

  return [
    row.id,
    row.actor,
    row.action,
    row.entity_type,
    row.entity_id ?? '',
    row.author_id ?? '',
    json(row.before),
    json(row.after),
    json(row.metadata),
    new Date(row.created_at).toISOString(),
  ].join(SEP);
}

/** SHA-256 over the previous digest and every row in range, in id order. */
export function digestOf({ prevDigest, rows }) {
  const hash = createHash('sha256');
  hash.update(prevDigest);
  for (const row of rows) {
    hash.update(SEP);
    hash.update(canonicalise(row));
  }
  return hash.digest('hex');
}

const lastCheckpoint = async (client) => {
  const { rows } = await client.query(
    'SELECT * FROM audit_checkpoints ORDER BY to_id DESC, id DESC LIMIT 1',
  );
  return rows[0] ?? null;
};

/**
 * Seals everything written since the last checkpoint.
 *
 * Deliberately writes nothing when nothing new has arrived: a checkpoint over an
 * empty range is a row that says nothing and lengthens the chain for no reason.
 */
export async function sealAuditLog({ now = new Date() } = {}, client = pool) {
  const previous = await lastCheckpoint(client);
  const fromId = previous ? Number(previous.to_id) + 1 : 0;
  const prevDigest = previous ? previous.digest : GENESIS;

  const { rows } = await client.query('SELECT * FROM audit_log WHERE id >= $1 ORDER BY id', [
    fromId,
  ]);

  if (rows.length === 0) {
    return { sealed: false, reason: 'nothing new to seal', checkpoint: previous };
  }

  // Sealing writes its own receipt into the log, so the next run always finds
  // something — and would seal a range containing nothing but the last run's
  // receipt, forever, one empty checkpoint per sweep. A range that is only this
  // agent's own bookkeeping is not worth a seal; those rows wait and are swept
  // into the next checkpoint that covers real activity.
  if (rows.every((row) => row.actor === ACTOR)) {
    return {
      sealed: false,
      reason: 'only this agent’s own bookkeeping is unsealed',
      unsealed: rows.length,
      checkpoint: previous,
    };
  }

  const toId = Number(rows[rows.length - 1].id);
  const digest = digestOf({ prevDigest, rows });

  const { rows: created } = await client.query(
    `INSERT INTO audit_checkpoints (from_id, to_id, row_count, digest, prev_digest, sealed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [Number(rows[0].id), toId, rows.length, digest, prevDigest, now.toISOString()],
  );

  // Recorded in the log it just sealed. Deliberately *after* the seal, so this
  // row belongs to the next range rather than changing the digest it describes.
  await recordAction(
    {
      actor: ACTOR,
      action: 'audit.sealed',
      entityType: 'audit_checkpoint',
      entityId: created[0].id,
      metadata: {
        fromId: Number(created[0].from_id),
        toId,
        rows: rows.length,
        digest: digest.slice(0, 16),
      },
    },
    client,
  );

  return { sealed: true, checkpoint: created[0], rows: rows.length };
}

/**
 * Recomputes every seal from the live rows and reports the first break.
 *
 * Reports the *first* rather than all of them on purpose: once a checkpoint
 * fails, every later one is chained to a digest that no longer describes what it
 * covered, so the rest would be noise. The first break is where to look.
 *
 * @returns {Promise<{status: string, checked: number, breaks: Array<object>}>}
 */
export async function verifyAuditLog({ authorId = null } = {}, client = pool) {
  const { rows: checkpoints } = await client.query(
    'SELECT * FROM audit_checkpoints ORDER BY id',
  );

  if (checkpoints.length === 0) {
    return { status: INTEGRITY.UNSEALED, checked: 0, breaks: [], sealedThrough: null };
  }

  const breaks = [];
  let expectedPrev = GENESIS;

  for (const checkpoint of checkpoints) {
    const { rows } = await client.query(
      'SELECT * FROM audit_log WHERE id BETWEEN $1 AND $2 ORDER BY id',
      [checkpoint.from_id, checkpoint.to_id],
    );

    const recomputed = digestOf({ prevDigest: checkpoint.prev_digest, rows });
    const countMatches = rows.length === checkpoint.row_count;
    const digestMatches = recomputed === checkpoint.digest;
    const chainMatches = checkpoint.prev_digest === expectedPrev;

    if (!countMatches || !digestMatches || !chainMatches) {
      breaks.push({
        checkpoint: Number(checkpoint.id),
        range: [Number(checkpoint.from_id), Number(checkpoint.to_id)],
        rowsSealed: checkpoint.row_count,
        rowsNow: rows.length,
        // What kind of tampering this looks like. A count that dropped is rows
        // removed; a count that held with a digest that moved is rows edited in
        // place; a broken chain is a whole checkpoint gone.
        finding: !chainMatches
          ? 'a checkpoint before this one is missing or was rewritten'
          : !countMatches
            ? rows.length < checkpoint.row_count
              ? `${checkpoint.row_count - rows.length} row(s) removed from this range`
              : `${rows.length - checkpoint.row_count} row(s) inserted into this range after sealing`
            : 'row contents changed after sealing',
        sealedAt: checkpoint.sealed_at,
      });
      break;
    }

    expectedPrev = checkpoint.digest;
  }

  const status = breaks.length === 0 ? INTEGRITY.INTACT : INTEGRITY.ALTERED;
  const sealedThrough = Number(checkpoints[checkpoints.length - 1].to_id);

  await recordAction(
    {
      actor: ACTOR,
      action: breaks.length === 0 ? 'audit.verified' : 'audit.tampering_detected',
      entityType: 'audit_log',
      entityId: sealedThrough,
      authorId,
      metadata: {
        status,
        checkpoints: checkpoints.length,
        sealedThrough,
        ...(breaks[0] ?? {}),
        // A detection is not a repair. Said plainly, because the natural reading
        // of "the agent checked the log" is that something was done about it.
        needsHuman: breaks.length > 0,
      },
    },
    client,
  );

  return { status, checked: checkpoints.length, breaks, sealedThrough };
}

/**
 * Seal what is new, then check what was sealed.
 *
 * The order matters: verifying first would leave the newest rows unsealed for
 * another whole interval, which is the window an attacker would aim for.
 */
export async function sealAndVerify({ now = new Date() } = {}) {
  const seal = await sealAuditLog({ now });
  const verification = await verifyAuditLog({});
  return { seal, verification };
}
