-- STORY-022 / REQ-005 + REQ-006 — the approval gate learns who may open it
--
-- STORY-019 built the RBAC this story asks for: a permissions table, five
-- permissions, `requirePermission` middleware, and audit-log access behind
-- `audit.read`. Both of this story's acceptance clauses passed before it
-- started. What it also asks for, in its fourth build step, is the part that
-- was not done: "Integrate RBAC checks with audit log access **and approval
-- processes**."
--
-- Measured first, and it is worse than a missing integration.
--
-- 1. Eight approve/reject routes, and not one permission check among them. The
--    approval gate — the control REQ-006 is entirely about — asked only
--    whether the caller was signed in and in the right tenant. Nothing ever
--    asked whether they were allowed to *approve*.
--
-- 2. The `compliance` role could approve content in any tenant. That role was
--    added by STORY-019 to read everything and change nothing, and there are
--    tests asserting it cannot suspend a tenant or retire a template. It
--    approved a press release for publication, in another author's tenant, on
--    the first try.
--
-- The second one is mine, and the mechanism is worth writing down. STORY-019
-- replaced `role === 'admin'` with `holds(user, 'tenant.read.all')` in three
-- places. Two of them — `enforceTenant` and `tenantParam` — guard which tenant
-- a request may *address*, and the substitution was right. The third,
-- `assertOwns`, guards whether a caller may *act on a row*, and there the
-- substitution silently turned a read permission into a write permission for
-- every row-addressed action in the system: approve, reject, send, schedule,
-- distribute.
--
-- It was invisible because, at the moment of the change, `tenant.read.all` was
-- held only by `admin` — for whom read and act had always been the same thing.
-- Adding a role that could read and must not act is what made the two come
-- apart, and nothing was watching the seam.
--
-- So: reading across tenants and acting across tenants become different
-- permissions, and approving becomes a permission at all.

BEGIN;

INSERT INTO permissions (name, description) VALUES
    ('content.approve',
     'Approve or reject outbound content — drafts, outreach, press materials, mix recommendations. The gate REQ-006 is about.'),
    ('tenant.act.all',
     'Act on any tenant''s rows, not merely read them. Separate from tenant.read.all because reading everything and changing everything are different powers.')
ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description;

-- An author approves their own tenant's work; tenant scoping still confines
-- them to it. This is the permission the product's whole promise rests on, so
-- it is granted deliberately rather than inherited from being signed in.
INSERT INTO role_permissions (role, permission) VALUES
    ('author', 'content.approve'),
    ('admin',  'content.approve'),
    ('admin',  'tenant.act.all')
ON CONFLICT DO NOTHING;

-- `compliance` gets neither, which is the point of it existing. It keeps
-- audit.read, audit.verify and tenant.read.all: it can see every tenant's work
-- and every tenant's trail, and can change none of it.
--
-- No DELETE is needed to take the power away — it was never granted, only
-- leaked through `assertOwns` reading the wrong permission. The fix is in the
-- middleware; this migration is what gives the middleware something correct to
-- ask for.

COMMIT;
