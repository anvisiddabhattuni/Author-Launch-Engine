import Joi from 'joi';

import { PLATFORMS } from '../config.js';
import { dateOnly, id, text, timestamp } from '../middleware/validate.js';
import { AWARD_OUTCOMES } from '../services/awards.js';
import { OPPORTUNITY_TYPES } from '../services/directories.js';

/**
 * What each route accepts (STORY-032).
 *
 * One entry per route that reads a body or a query string, keyed by what it
 * is rather than by its path so a route can be renamed without the schema
 * drifting off it. Every enum is imported from the module that owns it or
 * mirrors a CHECK constraint in the migrations — a schema that invented its
 * own list of statuses would be a second source of truth free to disagree
 * with the database, and the database would win at the worst moment.
 */

const email = Joi.string().trim().email({ tlds: false }).max(320);
const name = Joi.string().trim().min(1).max(200);
const limit = (max, def) => Joi.number().integer().min(1).max(max).default(def);

// Mirrors of CHECK constraints. The migration is the authority; these exist so
// a bad value is a 400 with a sentence instead of a 500 with a constraint name.
const DRAFT_STATUSES = ['pending_approval', 'escalated', 'approved', 'rejected', 'scheduled'];
const OUTREACH_STATUSES = ['pending_approval', 'escalated', 'approved', 'rejected', 'sent'];
const OPPORTUNITY_STATUSES = ['identified', 'dismissed'];
const MILESTONE_TYPES = ['launch', 'anniversary', 'award'];
const ROLES = ['author', 'admin', 'compliance'];
const hex = Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).message('{{#label}} must be a #rrggbb colour');

/** Approve / reject on any of the four approvable things. */
const decision = { body: { notes: text(), reviewer: text(200) } };

/** A list route filtered by tenant; `enforceTenant` then decides what that may mean. */
const byAuthor = { query: { authorId: id } };

export const SCHEMAS = {
  login: { body: { email: Joi.string().trim().max(320).required(), password: Joi.string().max(1000).required() } },

  integrations: { query: { authorId: id, sinceHours: Joi.number().integer().min(1).max(24 * 90).default(24) } },

  createAuthor: {
    body: {
      name: name.required(),
      email: email.required(),
      voiceProfile: Joi.object().unknown(true).default({}),
    },
  },

  createBook: {
    body: {
      title: name.required(),
      // A whole manuscript fits comfortably; the 5 MB body limit is the ceiling.
      content: Joi.string().min(1).max(4_000_000).required(),
      themes: Joi.array().items(Joi.string().trim().min(1).max(100)).max(50).default([]),
    },
  },

  socialHistory: {
    body: {
      posts: Joi.array()
        .items(
          Joi.object({
            platform: Joi.string().valid(...PLATFORMS).required(),
            content: Joi.string().min(1).max(10_000).required(),
            engagement: Joi.object().unknown(true).default({}),
            postedAt: timestamp.allow(null),
          }),
        )
        .min(1)
        .max(1000)
        .required(),
    },
  },

  draftPosts: {
    body: {
      count: Joi.number().integer().min(1).max(21),
      platforms: Joi.array().items(Joi.string().valid(...PLATFORMS)).min(1).unique(),
      weekOf: dateOnly,
    },
  },

  listDrafts: { query: { authorId: id, status: Joi.string().valid(...DRAFT_STATUSES), weekOf: dateOnly } },

  decision,

  listScheduled: byAuthor,

  publishDue: { body: { now: timestamp } },

  scout: {
    body: {
      // Unknown types keep the route's own error, which names the known ones;
      // the schema only insists it is a list of strings.
      types: Joi.array().items(Joi.string().max(40)).max(OPPORTUNITY_TYPES.length * 2).allow(null),
    },
  },

  listOpportunities: {
    query: {
      authorId: id,
      status: Joi.string().valid(...OPPORTUNITY_STATUSES),
      type: Joi.string().valid(...OPPORTUNITY_TYPES),
    },
  },

  draftOutreach: {
    body: { opportunityIds: Joi.array().items(id).max(100).allow(null), limit: Joi.number().integer().min(1).max(50) },
  },

  listOutreach: { query: { authorId: id, status: Joi.string().valid(...OUTREACH_STATUSES) } },

  awardOutcome: {
    body: {
      outcome: Joi.string().valid(...AWARD_OUTCOMES).required(),
      awardName: text(200).allow(null),
      actor: text(200),
      notes: text(),
    },
  },

  approaching: { query: { leadTimeDays: Joi.number().integer().min(1).max(365) } },

  draftApproaching: { body: { now: timestamp, leadTimeDays: Joi.number().integer().min(1).max(365) } },

  createMilestone: {
    body: {
      type: Joi.string().valid(...MILESTONE_TYPES).required(),
      title: name.required(),
      eventDate: dateOnly.required(),
      details: text(),
      location: text(300),
      awardName: text(200).allow(null),
    },
  },

  listPressKits: byAuthor,

  // STORY-037: an optional mobile number, in international form, for texts.
  addReviewer: { body: { name: name.required(), email: email.required(), role: text(100), phone: Joi.string().pattern(/^\+[1-9]\d{7,14}$/).allow('', null) } },

  reviewerActive: { body: { active: Joi.boolean() } },

  listNotifications: byAuthor,

  trustHistory: { query: { limit: limit(500, 30) } },

  // STORY-062: Alertmanager's webhook payload; its other fields pass through.
  prometheusAlerts: {
    body: Joi.object({
      alerts: Joi.array().max(500).items(Joi.object({
        status: Joi.string().valid('firing', 'resolved').required(),
        labels: Joi.object().unknown(true).required(),
        annotations: Joi.object().unknown(true),
        fingerprint: Joi.string().max(100),
      }).unknown(true)).required(),
    }).unknown(true),
  },

  // STORY-059: what was found or done, required to close an anomaly.
  anomalyAction: { body: { note: text(1000) } },

  // STORY-036: a Stripe event's envelope. Its other fields are Stripe's and pass through.
  stripeWebhook: {
    body: Joi.object({
      id: Joi.string().max(255).required(),
      type: Joi.string().max(255).required(),
      data: Joi.object({ object: Joi.object().unknown(true).required() }).unknown(true).required(),
    }).unknown(true),
  },

  // STORY-036: a Stripe PaymentMethod id — never card details.
  chargeSubscription: {
    body: { paymentMethod: Joi.string().pattern(/^pm_[A-Za-z0-9_]+$/).max(100).required() },
  },

  onboardTenant: {
    body: {
      name: name.required(),
      email: email.required(),
      // No password (STORY-043): the author sets their own from the emailed
      // link. One sent here is refused rather than stripped, so a client
      // built against the old API learns it has changed instead of silently
      // having its password ignored.
      password: Joi.any().forbidden().messages({ 'any.unknown': 'the author sets their own password from the invitation; do not send one' }),
      role: Joi.string().valid(...ROLES),
      voiceProfile: Joi.object().unknown(true),
    },
  },

  accessReport: {
    query: {
      authorId: id,
      tenant: id,
      user: id,
      outcome: Joi.string().valid('allowed', 'denied', 'not_found', 'invalid', 'unauthenticated', 'error', 'refused'),
      hours: Joi.number().integer().min(1).max(24 * 90).default(24),
    },
  },

  feedback: {
    body: Joi.object({
      rating: Joi.number().integer().min(1).max(5).allow(null),
      comment: Joi.string().trim().max(2000).allow('', null),
    }).or('rating', 'comment'),
  },

  requestChanges: {
    body: { note: Joi.string().trim().min(10).max(2000).required() },
  },

  addMaterial: {
    body: {
      kind: Joi.string().valid('synopsis', 'excerpt', 'author_note', 'press_quote', 'review').required(),
      content: Joi.string().trim().min(20).max(50_000).required(),
    },
  },

  createApiKey: {
    body: {
      name: Joi.string().trim().min(1).max(80).required(),
      access: Joi.string().valid('read', 'read_write').default('read'),
      expiresInDays: Joi.number().integer().min(1).max(365).default(90),
    },
  },

  governanceScore: {
    query: { authorId: id, days: Joi.number().integer().min(1).max(365).default(30) },
  },

  search: {
    query: {
      authorId: id,
      q: Joi.string().max(200).allow('').default(''),
      source: Joi.string().valid('audit', 'access').allow('').default(''),
      from: Joi.date().iso(),
      to: Joi.date().iso(),
      size: Joi.number().integer().min(1).max(200).default(50),
    },
  },

  auditReport: {
    query: {
      authorId: id,
      from: Joi.date().iso(),
      to: Joi.date().iso(),
      actor: Joi.string().trim().max(200),
      action: Joi.string().trim().max(100),
      format: Joi.string().valid('json', 'csv').default('json'),
    },
  },

  notifications: {
    query: { authorId: id, open: Joi.string().valid('true', 'false') },
  },

  acknowledge: {
    body: { note: Joi.string().trim().max(1000).allow('') },
  },

  securityLog: {
    query: {
      authorId: id,
      outcome: Joi.string().valid('allowed', 'denied', 'not_found', 'invalid', 'unauthenticated', 'error', 'refused'),
      hours: Joi.number().integer().min(1).max(24 * 90).default(24),
    },
  },

  blockAccount: {
    body: { reason: Joi.string().trim().min(10).max(1000).required() },
  },

  acceptInvite: {
    body: {
      token: Joi.string().max(200).required(),
      password: Joi.string().min(10).max(1000).required(),
    },
  },

  suspendTenant: { body: { reason: text(500) } },

  collectEngagement: { body: { formatEffect: Joi.number().min(-0.9).max(5) } },

  visualIdentity: {
    body: {
      palette: Joi.object({ ground: hex, ink: hex, accent: hex }),
      typography: Joi.object().unknown(true),
      toneWords: Joi.array().items(Joi.string().max(60)).max(30),
      doNotUse: Joi.array().items(Joi.string().max(200)).max(50),
      note: text(500),
    },
  },

  listTemplates: { query: { bookId: id } },

  addTemplate: {
    body: {
      key: Joi.string().pattern(/^[a-z0-9-]{2,60}$/).message('key must be 2–60 lowercase letters, digits or dashes').required(),
      name: name.required(),
      layout: Joi.string().max(40).required(),
      image_ref: Joi.string().max(2_000_000).required(),
      caption_slots: Joi.array().items(Joi.object().unknown(true)).min(1).max(10).required(),
      source: text(300),
      // The service decides whether a licence is usable (STORY-067); the schema
      // only insists it is the right shape to be asked.
      licence: Joi.object().unknown(true).allow(null),
    },
  },

  retireTemplate: { body: { reason: text(500) } },

  proposeAccessChange: {
    body: {
      kind: Joi.string().valid('grant_permission', 'revoke_permission', 'assign_role').required(),
      role: Joi.string().valid(...ROLES).when('kind', { is: 'assign_role', then: Joi.forbidden(), otherwise: Joi.required() }),
      permission: Joi.string().max(60).when('kind', { is: 'assign_role', then: Joi.forbidden(), otherwise: Joi.required() }),
      userId: id.when('kind', { is: 'assign_role', then: Joi.required(), otherwise: Joi.forbidden() }),
      newRole: Joi.string().valid(...ROLES).when('kind', { is: 'assign_role', then: Joi.required(), otherwise: Joi.forbidden() }),
      reason: Joi.string().trim().min(10).max(1000).required(),
    },
  },

  decideAccessChange: { body: { note: text(1000) } },

  auditLog: { query: { authorId: id, entityType: Joi.string().max(60), limit: limit(1000, 100) } },
};
