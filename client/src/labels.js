/**
 * Display words shared by every page, so the same thing is called the same
 * thing everywhere — and in words people use, not the database's.
 */
export const platformName = (p) =>
  ({ twitter: 'X (Twitter)', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram' }[p] ?? p);

export const STATUS_LABEL = {
  pending_approval: 'Needs review',
  escalated: 'Flagged',
  approved: 'Approved',
  rejected: 'Rejected',
  scheduled: 'Scheduled',
  queued: 'Waiting to post',
  published: 'Posted',
  failed: 'Couldn’t post',
  sent: 'Sent',
  distributed: 'Sent out',
  drafting: 'Being written',
  superseded: 'Replaced',
  changes_requested: 'Changes asked for',
  won: 'Won',
};
export const statusLabel = (s) => STATUS_LABEL[s] ?? String(s).replace(/_/g, ' ');

/** A date and time in the reader's own time zone. */
export const localTime = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const localDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—';
