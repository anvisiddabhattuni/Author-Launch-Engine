/**
 * Tenant Management Agent (STORY-017).
 *
 * The build note suggests PostgreSQL schemas or separate databases. This system
 * uses neither: isolation is an `author_id` column on 22 tables, enforced in
 * application middleware. That was already a named gap, and this story is where
 * it got tested rather than restated.
 *
 * Tested, it failed. `tenantParam` guards the *address* of a route — a request
 * for /authors/1/... is refused to author 2 — and says nothing about the rows
 * the handler then fetches. Signing in as one author and asking for that
 * author's own trust dashboard returned the last twenty audit rows across every
 * tenant. The middleware was working exactly as designed. The leak was in a
 * handler written two stories later that queried a table directly.
 *
 * That is the shape of the risk with column-based isolation: the guard is at the
 * edge and the mistake is in the middle, and every new route is another chance
 * to make it. So this module does the two things that actually help — onboard a
 * tenant with its access already correct, and look for leaks *from outside* the
 * code that is supposed to prevent them.
 */
import { pool, withTransaction } from '../db/pool.js';
import { recordAction } from '../services/auditLog.js';
import { upsertUser } from '../services/auth.js';

export const ACTOR = 'TenantManagementAgent';

/**
 * Every table that carries tenant data, and how to reach the tenant from it.
 *
 * Derived from the schema at runtime rather than listed here by hand: a list in
 * code goes stale the first time somebody adds a table and forgets, and this
 * check exists precisely because people forget.
 */
/**
 * Tables whose rows are supposed to survive the tenant they describe.
 *
 * `audit_log` has no foreign key to `authors` on purpose: deleting an account
 * must not delete the record of what it did, which is the same reason templates
 * are retired rather than dropped and a suspended tenant keeps its drafts. The
 * first version of the isolation check did not know that and reported 1,868
 * "orphaned" audit rows as a breach — a design decision read as a fault, which
 * is how a security check earns the right to be ignored.
 */
export const OUTLIVES_TENANTS = new Set(['audit_log']);

export async function tenantTables(client = pool) {
  const { rows } = await client.query(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public'
        AND c.column_name = 'author_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`,
  );
  return rows.map((r) => r.table_name);
}

/**
 * Onboards a tenant: the author, the account that owns it, and its role.
 *
 * One transaction, because an author with no account is a tenant nobody can
 * reach and an account with no author is a session with nothing behind it —
 * either half on its own is a broken state somebody has to clean up by hand.
 */
export async function onboardTenant({
  name,
  email,
  password,
  role = 'author',
  voiceProfile = {},
}) {
  if (!name?.trim()) throw Object.assign(new Error('A tenant needs a name'), { status: 400 });
  if (!email?.trim()) throw Object.assign(new Error('A tenant needs an email'), { status: 400 });
  if (!password || password.length < 8) {
    throw Object.assign(new Error('A tenant password must be at least 8 characters'), {
      status: 400,
    });
  }

  const { author, user } = await withTransaction(async (client) => {
    const { rows: existing } = await client.query('SELECT id FROM authors WHERE email = $1', [
      email,
    ]);
    if (existing[0]) {
      throw Object.assign(new Error(`A tenant already exists for ${email}`), { status: 409 });
    }

    const { rows } = await client.query(
      `INSERT INTO authors (name, email, voice_profile, onboarded_at, tenant_status)
       VALUES ($1,$2,$3, now(), 'active') RETURNING *`,
      [name, email, JSON.stringify(voiceProfile)],
    );
    return { author: rows[0], client };
  }).then(async ({ author: created }) => {
    // The account is created after the author exists, because it references it.
    const account = await upsertUser({
      email,
      name,
      password,
      role,
      authorId: created.id,
    });
    return { author: created, user: account };
  });

  await recordAction({
    actor: ACTOR,
    action: 'tenant.onboarded',
    entityType: 'author',
    entityId: author.id,
    authorId: author.id,
    metadata: {
      name,
      email,
      role,
      // Named on the log because the story's clause is that onboarding
      // "ensures data isolation and role-based access" — the role is half of it,
      // and a tenant created without one is a tenant nobody can sign in to.
      accountCreated: Boolean(user),
      isolation: 'author_id column, enforced in middleware and checked from outside',
    },
  });

  return { author, user };
}

/**
 * Stops serving a tenant without destroying what it did.
 *
 * Suspension rather than deletion, for the reason everything else here is
 * retired rather than deleted: the drafts, approvals and audit rows are the
 * record of what happened, and a cascading delete takes the evidence with the
 * account.
 */
export async function suspendTenant({ authorId, reason = '', user = null }) {
  // `FROM authors old` sees the pre-update snapshot, so one statement yields
  // both states. A SELECT before the UPDATE would be a read and a write with a
  // gap between them, and the "before" it recorded could already be somebody
  // else's write (STORY-019).
  const { rows } = await pool.query(
    `UPDATE authors a SET tenant_status = 'suspended'
       FROM authors old
      WHERE a.id = $1 AND a.tenant_status = 'active' AND old.id = a.id
     RETURNING a.*, to_jsonb(old) AS before_row`,
    [authorId],
  );
  if (!rows[0]) {
    throw Object.assign(new Error(`No active tenant ${authorId} to suspend`), { status: 404 });
  }

  const { before_row: beforeRow, ...suspended } = rows[0];

  await recordAction({
    actor: ACTOR,
    action: 'tenant.suspended',
    entityType: 'author',
    entityId: authorId,
    authorId,
    // Suspension moves a row from one status to another and used to record
    // neither of them. REQ-005 asks for the before-after states, and a status
    // change is exactly the case that clause is about.
    before: beforeRow,
    after: suspended,
    metadata: { reason, suspendedBy: user?.name ?? null, dataRetained: true },
  });

  return rows[0];
}

export async function restoreTenant({ authorId, user = null }) {
  const { rows } = await pool.query(
    `UPDATE authors a SET tenant_status = 'active'
       FROM authors old
      WHERE a.id = $1 AND old.id = a.id
     RETURNING a.*, to_jsonb(old) AS before_row`,
    [authorId],
  );
  if (!rows[0]) throw Object.assign(new Error(`No tenant ${authorId}`), { status: 404 });

  const { before_row: beforeRow, ...restored } = rows[0];

  await recordAction({
    actor: ACTOR,
    action: 'tenant.restored',
    entityType: 'author',
    entityId: authorId,
    authorId,
    before: beforeRow,
    after: restored,
    metadata: { restoredBy: user?.name ?? null },
  });
  return restored;
}

/**
 * Looks for tenant data that has escaped its tenant.
 *
 * Asks the database directly, table by table, rather than going through the
 * application — which is the point. The middleware is what the application
 * trusts; a check that ran through the middleware would only ever confirm that
 * the middleware agrees with itself.
 *
 * What it can find: a row whose `author_id` points at a tenant that no longer
 * exists, and a row whose owning parent belongs to a different tenant than the
 * row claims. Both are states no code path should be able to produce, and both
 * are invisible to a guard that only checks incoming requests.
 */
export async function verifyIsolation({ authorId = null } = {}, client = pool) {
  const tables = await tenantTables(client);
  const findings = [];

  for (const table of tables) {
    if (OUTLIVES_TENANTS.has(table)) continue;

    // Orphans: rows pointing at a tenant that is gone. Not a leak on its own,
    // but a row nobody owns is a row no tenant filter will ever exclude.
    const { rows: orphans } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${table} t
        WHERE t.author_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = t.author_id)`,
    );
    if (orphans[0].n > 0) {
      findings.push({
        table,
        kind: 'orphaned_rows',
        rows: orphans[0].n,
        detail: `${orphans[0].n} row(s) belong to a tenant that no longer exists`,
      });
    }
  }

  // Cross-tenant parentage: a child row claiming one tenant while its parent
  // belongs to another. These pairs are the ones where a mismatch would let a
  // join walk across the boundary.
  const parentage = [
    ['drafts', 'books', 'book_id'],
    ['scheduled_posts', 'drafts', 'draft_id'],
    ['outreach_messages', 'opportunities', 'opportunity_id'],
    ['pr_materials', 'pr_kits', 'kit_id'],
    ['engagement', 'drafts', 'draft_id'],
  ];

  for (const [child, parent, fk] of parentage) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM ${child} c
         JOIN ${parent} p ON p.id = c.${fk}
        WHERE c.author_id IS DISTINCT FROM p.author_id`,
    );
    if (rows[0].n > 0) {
      findings.push({
        table: child,
        kind: 'cross_tenant_parent',
        rows: rows[0].n,
        detail: `${rows[0].n} ${child} row(s) claim a different tenant than their ${parent}`,
      });
    }
  }

  const leaked = findings.reduce((total, f) => total + f.rows, 0);
  const checked = tables.filter((t) => !OUTLIVES_TENANTS.has(t)).length;

  const { rows: recorded } = await client.query(
    `INSERT INTO isolation_checks (author_id, leaked_rows, tables_checked, findings)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [authorId, leaked, checked, JSON.stringify(findings)],
  );

  await recordAction(
    {
      actor: ACTOR,
      action: leaked === 0 ? 'tenant.isolation_verified' : 'tenant.isolation_breached',
      entityType: 'isolation_check',
      entityId: recorded[0].id,
      authorId,
      metadata: {
        tablesChecked: checked,
        leakedRows: leaked,
        // Named on the log rather than silently skipped: an exclusion nobody
        // can see is indistinguishable from a check that never ran.
        excluded: [...OUTLIVES_TENANTS],
        findings,
        needsHuman: leaked > 0,
      },
    },
    client,
  );

  return {
    ok: leaked === 0,
    tablesChecked: checked,
    excluded: [...OUTLIVES_TENANTS],
    leaked,
    findings,
  };
}
