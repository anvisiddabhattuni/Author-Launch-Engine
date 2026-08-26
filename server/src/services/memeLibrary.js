/**
 * The meme template library (STORY-067).
 *
 * STORY-066 kept five templates in a source file and filtered the unusable ones
 * out with `usableTemplates()`, silently. That is the shape of gap STORY-010
 * found in the opportunity scanner: a filter deciding what nobody would ever
 * see, keeping no record of having decided. This story's second acceptance
 * clause asks for the attempt to be logged, which is what turns "an unlicensed
 * image can never reach a draft" from a claim into something auditable.
 *
 * Selection is deliberately a service rather than a query. Choosing a template
 * is a decision with a reason, and the reason is worth writing down — including
 * when the decision is "no".
 */
import { pool } from '../db/pool.js';
import { recordAction } from './auditLog.js';
import { RIGHTS, checkImageRights } from './brandSafety.js';
import { scoreIdentity } from './visualIdentity.js';

/** The story names the AI Content Generation Agent as the owner. */
export const ACTOR = 'AIContentGenerationAgent';

/** Why a template was passed over. Named, because a queue is worth querying. */
export const REJECTIONS = {
  NO_LICENCE: 'no_licence_recorded',
  LICENCE_FORBIDS: 'licence_forbids_commercial_use',
  ATTRIBUTION_MISSING: 'attribution_required_but_absent',
  RETIRED: 'template_retired',
};

const rowToTemplate = (row) => ({
  id: Number(row.id),
  key: row.key,
  name: row.name,
  layout: row.layout,
  captionSlots: row.caption_slots,
  imageRef: row.image_ref,
  source: row.source,
  licence: row.licence,
  active: row.active,
  retiredAt: row.retired_at,
  retiredReason: row.retired_reason,
});

export async function listTemplates({ activeOnly = false } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM meme_templates ${activeOnly ? 'WHERE active' : ''} ORDER BY active DESC, key`,
  );
  return rows.map(rowToTemplate);
}

export const getTemplate = async (key, client = pool) => {
  const { rows } = await client.query('SELECT * FROM meme_templates WHERE key = $1', [key]);
  return rows[0] ? rowToTemplate(rows[0]) : null;
};

/**
 * Why this template may or may not be used, as a reason rather than a boolean.
 *
 * Reuses STORY-066's rights check rather than restating its rules: the licence
 * question is the same question whether it is asked of a finished draft or of a
 * template about to be chosen, and two copies of it would be free to disagree.
 */
export function assessTemplate(template) {
  if (!template.active) {
    return { usable: false, reason: REJECTIONS.RETIRED, rights: RIGHTS.NOT_APPLICABLE };
  }

  const verdict = checkImageRights({
    media: { provenance: { licence: template.licence, templateId: template.key } },
  });

  if (verdict.rights === RIGHTS.CLEARED) {
    return { usable: true, reason: null, rights: verdict.rights, detail: verdict.reason };
  }

  const reason = !template.licence
    ? REJECTIONS.NO_LICENCE
    : template.licence.commercial !== true
      ? REJECTIONS.LICENCE_FORBIDS
      : REJECTIONS.ATTRIBUTION_MISSING;

  return { usable: false, reason, rights: verdict.rights, detail: verdict.reason };
}

/**
 * Chooses a template, and records both halves of the choice.
 *
 * `seed` picks deterministically from whatever is usable, so the demo and the
 * tests keep producing the same meme twice.
 *
 * Every template that was reached for and refused is logged individually. A
 * single "3 rejected" count would be the thing STORY-010 spent a whole story
 * arguing against: the rejections are the half of a filter nobody can check.
 *
 * @returns {Promise<{template: object|null, rejected: Array<object>}>}
 */
export async function selectTemplate(
  { authorId = null, seed = 0, layout = null, identity = null },
  client = pool,
) {
  const all = await listTemplates({}, client);
  const candidates = layout ? all.filter((t) => t.layout === layout) : all;

  const usable = [];
  const rejected = [];

  for (const template of candidates) {
    const verdict = assessTemplate(template);
    if (verdict.usable) {
      usable.push(template);
      continue;
    }
    rejected.push({ key: template.key, name: template.name, ...verdict });
  }

  // Logged whether or not anything was ultimately chosen: "the generator
  // reached for a template it may not have" is the event, and it happened.
  for (const entry of rejected) {
    await recordAction(
      {
        actor: ACTOR,
        action: 'meme_template.rejected',
        entityType: 'meme_template',
        entityId: entry.key,
        authorId,
        metadata: {
          template: entry.key,
          name: entry.name,
          reason: entry.reason,
          rights: entry.rights,
          detail: entry.detail ?? '',
        },
      },
      client,
    );
  }

  if (usable.length === 0) {
    return { template: null, rejected };
  }

  // On-identity templates first (STORY-068). The guide shapes what gets *made*,
  // not only what gets caught — the same both-sides-of-generation pattern as
  // theme grounding in STORY-009. Without this the library's five off-accent
  // templates would send most memes to a human for a fault the system chose.
  let pool_ = usable;
  let onIdentity = [];
  if (identity) {
    onIdentity = usable.filter(
      (t) => scoreIdentity({ imageRef: t.imageRef, identity }).score >= 1,
    );
    if (onIdentity.length > 0) pool_ = onIdentity;
  }

  const template = pool_[Math.abs(seed) % pool_.length];

  await recordAction(
    {
      actor: ACTOR,
      action: 'meme_template.selected',
      entityType: 'meme_template',
      entityId: template.key,
      authorId,
      metadata: {
        template: template.key,
        layout: template.layout,
        licence: template.licence,
        source: template.source,
        consideredUsable: usable.length,
        onIdentity: identity ? onIdentity.length : null,
        identityVersion: identity?.version ?? null,
        rejected: rejected.length,
      },
    },
    client,
  );

  return { template, rejected };
}

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Greedy wrap, as in STORY-066. Legible preview, not typesetting. */
function wrap(text, perLine) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > perLine && line) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Shrink to fit rather than dropping lines — the STORY-066 render bug. */
const fitSize = (lines, max) => Math.max(18, Math.min(max, Math.floor((max * 3) / Math.max(3, lines))));

/**
 * Lays captions into a template's named slots and returns the finished image.
 *
 * The artwork is a stored asset the caption is drawn *over*, rather than
 * something composed from scratch per draft as in STORY-066. That is what lets
 * a template be previewed, licensed and retired on its own terms — and what
 * makes replacing the drawn artwork with a photograph a data change.
 *
 * @param {object} input
 * @param {object} input.template
 * @param {Record<string,string>} input.captions Keyed by slot name.
 */
export function composeFromTemplate({ template, captions }) {
  const artwork = Buffer.from(template.imageRef.split(',')[1], 'base64').toString('utf8');

  const overlays = [];
  for (const slot of template.captionSlots) {
    const text = captions[slot.name];
    if (!text) continue;

    const lines = wrap(text, slot.wrap ?? 28);
    const size = fitSize(lines.length, slot.size ?? 36);
    const step = Math.round(size * 1.35);
    // Centred on the slot's y, so a two-line caption and a five-line one both
    // sit where the artwork expects text to be.
    const startY = slot.y - ((lines.length - 1) * step) / 2;
    const fill = slot.fill ?? '#f4f6f8';

    lines.forEach((line, i) => {
      overlays.push(
        `<text x="${slot.x}" y="${Math.round(startY + i * step)}" ` +
          `text-anchor="${slot.anchor ?? 'start'}" font-family="Georgia,serif" ` +
          `font-size="${size}" fill="${fill}">${escape(line)}</text>`,
      );
    });
  }

  return `data:image/svg+xml;base64,${Buffer.from(
    artwork.replace('</svg>', `${overlays.join('')}</svg>`),
    'utf8',
  ).toString('base64')}`;
}

/**
 * Adds a template, refusing one nobody can licence.
 *
 * The refusal is at the door rather than at selection: a library that accepts
 * unusable templates and filters them later is a library whose count means
 * nothing. `force` exists for the seed, which deliberately plants two
 * unusable templates so the rejection path has something to reject.
 */
export async function addTemplate(template, { user = null, force = false } = {}, client = pool) {
  const verdict = assessTemplate({ ...template, active: true });
  if (!verdict.usable && !force) {
    throw Object.assign(
      new Error(
        `Template "${template.key}" cannot be added: ${verdict.detail ?? verdict.reason}. ` +
          'Record the image source and licence first.',
      ),
      { status: 400, reason: verdict.reason },
    );
  }

  const { rows } = await client.query(
    `INSERT INTO meme_templates (key, name, layout, caption_slots, image_ref, source, licence)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (key) DO UPDATE
       SET name = EXCLUDED.name, layout = EXCLUDED.layout,
           caption_slots = EXCLUDED.caption_slots, image_ref = EXCLUDED.image_ref,
           source = EXCLUDED.source, licence = EXCLUDED.licence
     RETURNING *`,
    [
      template.key,
      template.name,
      template.layout,
      JSON.stringify(template.caption_slots ?? template.captionSlots),
      template.image_ref ?? template.imageRef,
      template.source ?? '',
      template.licence ? JSON.stringify(template.licence) : null,
    ],
  );

  await recordAction(
    {
      actor: ACTOR,
      action: 'meme_template.added',
      entityType: 'meme_template',
      entityId: rows[0].key,
      metadata: {
        template: rows[0].key,
        source: rows[0].source,
        licence: rows[0].licence,
        slots: (rows[0].caption_slots ?? []).map((s) => s.name),
        usable: verdict.usable,
        addedBy: user?.name ?? null,
      },
    },
    client,
  );

  return rowToTemplate(rows[0]);
}

/**
 * Retires a template without deleting it.
 *
 * A meme drafted last month points at its template, and deleting the row would
 * strand the provenance on a post that has already gone out.
 */
export async function retireTemplate({ key, reason = '', user = null }, client = pool) {
  const { rows } = await client.query(
    `UPDATE meme_templates
        SET active = FALSE, retired_at = now(), retired_reason = $2
      WHERE key = $1 AND active
      RETURNING *`,
    [key, reason],
  );
  if (!rows[0]) {
    throw Object.assign(new Error(`No active template "${key}" to retire`), { status: 404 });
  }

  await recordAction(
    {
      actor: ACTOR,
      action: 'meme_template.retired',
      entityType: 'meme_template',
      entityId: key,
      metadata: { template: key, reason, retiredBy: user?.name ?? null },
    },
    client,
  );

  return rowToTemplate(rows[0]);
}
