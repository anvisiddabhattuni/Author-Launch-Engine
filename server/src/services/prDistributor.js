import { withTransaction, query } from '../db/pool.js';

import { recordAction } from './auditLog.js';
import { emailApi } from './emailApi.js';

export const ACTOR = 'PROutreachAgent';

/** Order the kit is assembled in when it goes out as one email. */
const MATERIAL_ORDER = ['press_release', 'author_bio', 'fact_sheet'];

const LABELS = {
  press_release: 'PRESS RELEASE',
  author_bio: 'AUTHOR BIOGRAPHY',
  fact_sheet: 'FACT SHEET',
};

/**
 * Which journalists plausibly cover this book. A beat has to match a theme
 * exactly; a loose match would put the book in front of people who did not ask
 * for it, which is how a press list stops working.
 */
export function selectRecipients(contacts, bookThemes) {
  const themes = new Set(bookThemes.map((t) => t.toLowerCase()));
  return contacts
    .map((contact) => ({
      contact,
      matchedBeats: (contact.beats ?? []).filter((beat) => themes.has(beat.toLowerCase())),
    }))
    .filter((entry) => entry.matchedBeats.length > 0);
}

function assembleKitEmail(materials) {
  const ordered = [...materials].sort(
    (a, b) => MATERIAL_ORDER.indexOf(a.type) - MATERIAL_ORDER.indexOf(b.type),
  );
  const release = ordered.find((m) => m.type === 'press_release') ?? ordered[0];

  const body = ordered
    .map((m) => `${'='.repeat(60)}\n${LABELS[m.type] ?? m.type.toUpperCase()}\n${'='.repeat(60)}\n\n${m.body}`)
    .join('\n\n');

  return { subject: release.headline, body };
}

/**
 * Distributes an approved press kit to the matching press contacts.
 *
 * Refuses unless every material in the kit is approved. One rejected or
 * still-pending piece holds the whole kit, because a press kit is received as a
 * single package — a partially reviewed one has not really been reviewed.
 */
export async function distributePressKit({ kitId }) {
  let prepared;

  try {
    prepared = await withTransaction(async (client) => {
      const { rows: kitRows } = await client.query('SELECT * FROM pr_kits WHERE id = $1 FOR UPDATE', [
        kitId,
      ]);
      const kit = kitRows[0];
      if (!kit) throw Object.assign(new Error('Press kit not found'), { status: 404 });

      if (kit.status === 'distributed') {
        throw Object.assign(new Error(`Press kit ${kitId} has already been distributed`), {
          status: 409,
        });
      }

      // Withdrawn copy must not be sendable, however well reviewed it was. A
      // shortlist release approved before the book won is approved copy that now
      // states the wrong news (STORY-005).
      if (kit.status === 'superseded') {
        throw Object.assign(
          new Error(
            `Press kit ${kitId} was superseded and cannot be distributed` +
              (kit.superseded_reason ? `: ${kit.superseded_reason}` : ''),
          ),
          { status: 409 },
        );
      }

      const { rows: materials } = await client.query(
        'SELECT * FROM pr_materials WHERE kit_id = $1 ORDER BY id',
        [kitId],
      );

      const notApproved = materials.filter((m) => m.status !== 'approved');
      if (materials.length === 0 || notApproved.length > 0) {
        throw Object.assign(
          new Error(
            `Press kit ${kitId} cannot be distributed: ` +
              `${notApproved.length} of ${materials.length} materials are not approved ` +
              `(${notApproved.map((m) => `${m.type}="${m.status}"`).join(', ') || 'kit is empty'})`,
          ),
          {
            status: 409,
            blockedKit: kit,
            blockedMaterials: notApproved,
            totalMaterials: materials.length,
          },
        );
      }

      const { rows: bookRows } = await client.query('SELECT * FROM books WHERE id = $1', [
        kit.book_id,
      ]);
      const book = bookRows[0];

      const { rows: contacts } = await client.query('SELECT * FROM press_contacts ORDER BY id');
      const recipients = selectRecipients(contacts, book.themes);

      if (recipients.length === 0) {
        throw Object.assign(
          new Error('No press contacts cover this book\'s themes'),
          { status: 400 },
        );
      }

      // Claim every send inside the transaction so two concurrent callers
      // cannot both reach the email provider for the same kit.
      const queued = [];
      for (const { contact, matchedBeats } of recipients) {
        const { rows } = await client.query(
          `INSERT INTO pr_distributions (kit_id, author_id, contact_id, recipient, outlet)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [kitId, kit.author_id, contact.id, contact.email, contact.outlet],
        );
        queued.push({ row: rows[0], contact, matchedBeats });
      }

      return { kit, materials, queued };
    });
  } catch (error) {
    if (error.blockedKit) {
      // The transaction rolled back, so the refusal is recorded on its own
      // connection — a blocked action must still leave a trace.
      await recordAction({
        actor: ACTOR,
        action: 'pr_kit.distribute_blocked',
        entityType: 'pr_kit',
        entityId: kitId,
        authorId: error.blockedKit.author_id,
        before: error.blockedKit,
        metadata: {
          reason: 'approval gate: every material in the kit must be approved',
          totalMaterials: error.totalMaterials,
          blocking: error.blockedMaterials.map((m) => ({
            id: m.id,
            type: m.type,
            status: m.status,
          })),
        },
      });
    }
    throw error;
  }

  const { kit, materials, queued } = prepared;
  const { subject, body } = assembleKitEmail(materials);

  const sent = [];
  for (const { row, contact, matchedBeats } of queued) {
    try {
      const result = await emailApi.send({ to: contact.email, subject, body });

      const { rows } = await query(
        `UPDATE pr_distributions SET status = 'sent', external_id = $1, sent_at = now()
          WHERE id = $2 RETURNING *`,
        [result.externalId, row.id],
      );

      await recordAction({
        actor: ACTOR,
        action: 'pr_kit.distributed_to',
        entityType: 'pr_kit',
        entityId: kitId,
        authorId: kit.author_id,
        after: rows[0],
        metadata: {
          recipient: contact.email,
          outlet: contact.outlet,
          matchedBeats,
          externalId: result.externalId,
          mocked: true,
        },
      });

      sent.push(rows[0]);
    } catch (error) {
      const { rows } = await query(
        "UPDATE pr_distributions SET status = 'failed', error = $1 WHERE id = $2 RETURNING *",
        [error.message, row.id],
      );

      await recordAction({
        actor: ACTOR,
        action: 'pr_kit.distribution_failed',
        entityType: 'pr_kit',
        entityId: kitId,
        authorId: kit.author_id,
        metadata: { error: error.message, recipient: contact.email, outlet: contact.outlet },
      });

      sent.push(rows[0]);
    }
  }

  await query(
    "UPDATE pr_materials SET status = 'distributed', updated_at = now() WHERE kit_id = $1",
    [kitId],
  );
  const { rows: updatedKit } = await query(
    "UPDATE pr_kits SET status = 'distributed', updated_at = now() WHERE id = $1 RETURNING *",
    [kitId],
  );

  await recordAction({
    actor: ACTOR,
    action: 'pr_kit.distributed',
    entityType: 'pr_kit',
    entityId: kitId,
    authorId: kit.author_id,
    before: kit,
    after: updatedKit[0],
    metadata: {
      recipients: sent.length,
      delivered: sent.filter((s) => s.status === 'sent').length,
      materials: materials.map((m) => m.type),
    },
  });

  return { kit: updatedKit[0], distributions: sent };
}
