import { router } from '../routes/index.js';

/**
 * Every route a tenant can read, derived from the router itself (STORY-024).
 *
 * STORY-017 built the cross-tenant walk that would have caught its own leak: it
 * signs in as one tenant, requests the list routes, and asserts no response
 * carries another tenant's id. It found two real leaks and it works.
 *
 * It also kept the routes in a hand-written array, and that array has not grown
 * since. Measured before writing this: **10 of 35 GET routes were in it.**
 * Everything added after STORY-017 — `/audit-log`, which STORY-019 gated and
 * STORY-022 re-gated, the trust history from STORY-021, the on-demand press
 * route from STORY-018 — was never walked. The walk's own Known-gaps entry says
 * "a new handler written the same careless way is caught only if someone adds
 * it to that test", and that is precisely what happened: six stories of new
 * routes, none of them added.
 *
 * This is STORY-020's finding in a different place. A check that verifies the
 * things on its list cannot see the thing that is missing from it, and the
 * answer is the same: derive the list, and make every omission declare itself.
 *
 * So the surface is read off `router.stack` rather than typed out. A route
 * added tomorrow is walked tomorrow, and one that genuinely cannot be walked
 * has to say why in `UNWALKABLE` below — where a reviewer can disagree with it.
 */

/**
 * Routes the walk cannot drive, and the reason each one is not a gap.
 *
 * Every entry is a claim somebody can check. An empty reason, or a reason that
 * amounts to "it was awkward", is the thing this file exists to prevent — an
 * exclusion nobody can see is indistinguishable from a check that never ran
 * (STORY-017's own lesson, applied to STORY-017's own test).
 */
export const UNWALKABLE = {
  '/health': 'Public by design — a load balancer has no session. Returns no tenant data.',
  '/ready': 'Public by design, same reason. Exposes migration state, not tenant rows.',
  '/auth/me': 'Returns the caller\'s own session. Another tenant\'s id appearing here would mean the token was forged, which is authenticate\'s job rather than this walk\'s.',
  '/tenants/isolation': 'Requires tenant.manage. Walking it as an ordinary author asserts the 403, which the RBAC suite already does; the response itself is an operator report about every tenant and is *meant* to name them all.',
  '/audit-integrity': 'Requires audit.verify. System-wide by definition — it verifies one log across every tenant, so tenant ids in it are the subject, not a leak.',
};

/** Path parameters the walk knows how to fill for the signed-in tenant. */
const FILLABLE = new Set(['authorId', 'bookId']);

/**
 * Enumerates every GET route Express actually has.
 *
 * Read from the live router rather than by grepping the source, because the
 * source is where a typo hides and the stack is what the server will really
 * serve.
 */
export function getRoutes() {
  return router.stack
    .filter((layer) => layer.route && layer.route.methods?.get)
    .map((layer) => layer.route.path);
}

/**
 * Splits the surface into what the walk can drive and what it cannot.
 *
 * `needsId` is the interesting third category: a route addressed by a row id
 * (`/pr-materials/:id/...`) cannot be walked generically, because the walk has
 * no id that belongs to the signed-in tenant. Those are listed rather than
 * dropped, so the count of "not covered by the generic walk" is visible instead
 * of being quietly absorbed.
 */
export function classifyRoutes({ routes = getRoutes() } = {}) {
  const walkable = [];
  const declared = [];
  const needsId = [];

  for (const path of routes) {
    if (path in UNWALKABLE) {
      declared.push({ path, why: UNWALKABLE[path] });
      continue;
    }
    const params = [...path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    if (params.length === 0 || params.every((p) => FILLABLE.has(p))) {
      walkable.push(path);
    } else {
      needsId.push({ path, params: params.filter((p) => !FILLABLE.has(p)) });
    }
  }

  return { walkable, declared, needsId, total: routes.length };
}

/** Fills `:authorId` and `:bookId` with the signed-in tenant's own values. */
export const fillPath = (path, { authorId, bookId }) =>
  path.replace(':authorId', String(authorId)).replace(':bookId', String(bookId));

/**
 * Every author_id appearing anywhere in a response, at any depth.
 *
 * Kept here rather than in the test because the demo reads it too, and because
 * the leak STORY-017 found was nested three levels inside a dashboard payload
 * nobody would have checked by hand.
 */
export function authorIdsIn(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) authorIdsIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if ((key === 'author_id' || key === 'authorId') && inner !== null && inner !== undefined) {
        found.add(Number(inner));
      } else {
        authorIdsIn(inner, found);
      }
    }
  }
  return found;
}

/** The coverage figure, for the governance check and the demo. */
export function surfaceCoverage() {
  const { walkable, declared, needsId, total } = classifyRoutes();
  return {
    total,
    walkable: walkable.length,
    declared: declared.length,
    needsId: needsId.length,
    // A route that is neither walkable nor declared nor row-addressed would be
    // an unexplained hole. There is no way to produce one today — the three
    // buckets are exhaustive — and the number is reported anyway so that stays
    // true if the classifier changes.
    unaccounted: total - walkable.length - declared.length - needsId.length,
  };
}
