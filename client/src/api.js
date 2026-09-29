/**
 * Session token (STORY-064).
 *
 * localStorage, sent as a Bearer header. Readable by any script running on the
 * page, which is a real limitation and a named gap — the trade was made because
 * an httpOnly cookie brings CSRF handling and a cookie jar in the HTTP tests
 * along with it, and this slice is deliberately thin.
 */
const TOKEN_KEY = 'ale.token';

export const session = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Notified when the server stops accepting the token, so the UI can fall back to login. */
let onSessionLost = () => {};
export const setSessionLostHandler = (fn) => {
  onSessionLost = fn;
};

async function request(path, options = {}) {
  const token = session.get();
  const response = await fetch(`/api${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    // An expired or rejected token should return the user to the login screen
    // rather than showing a wall of failed panels. Login itself is exempt: a
    // wrong password is a message, not a lost session.
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/accept-invite') {
      session.clear();
      onSessionLost();
    }
    // `??` only guards null and undefined. An empty-string error passed straight
    // through, and an empty message renders as no message at all — which is how
    // a dead database turned into a Sign in button that did nothing and said
    // nothing.
    const serverMessage = typeof payload?.error === 'string' ? payload.error.trim() : '';
    // Per-field problems from input validation (STORY-032) ride along, so a
    // page can point at the line that is wrong instead of printing the prose.
    throw Object.assign(new Error(serverMessage || `Request failed with ${response.status}`), {
      status: response.status,
      details: Array.isArray(payload?.details) ? payload.details : null,
    });
  }
  return payload;
}

export const api = {
  health: () => request('/health'),

  // STORY-064 — a session with a real identity behind it
  login: async (email, password) => {
    const result = await request('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    session.set(result.token);
    return result.user;
  },

  me: () => request('/auth/me').then((r) => r.user),

  logout: () => session.clear(),

  authors: () => request('/authors'),
  books: (authorId) => request(`/authors/${authorId}/books`),

  uploadBook: (authorId, book) =>
    request(`/authors/${authorId}/books`, { method: 'POST', body: book }),

  uploadHistory: (authorId, posts) =>
    request(`/authors/${authorId}/social-history`, { method: 'POST', body: { posts } }),

  generateDrafts: (authorId, bookId, body) =>
    request(`/authors/${authorId}/books/${bookId}/drafts`, { method: 'POST', body }),

  drafts: (params) => request(`/drafts?${new URLSearchParams(params)}`),
  weeklyCoverage: (authorId) => request(`/authors/${authorId}/weekly-coverage`),

  // STORY-009 — what a social draft is written from: the book's retrieved
  // themes, and the voice counted off the author's own previous posts.
  voiceGrounding: (authorId, bookId) =>
    request(`/authors/${authorId}/books/${bookId}/voice-grounding`),

  approve: (id, body) => request(`/drafts/${id}/approve`, { method: 'POST', body }),
  reject: (id, body) => request(`/drafts/${id}/reject`, { method: 'POST', body }),
  schedule: (id) => request(`/drafts/${id}/schedule`, { method: 'POST' }),

  scheduledPosts: (authorId) => request(`/scheduled-posts?authorId=${authorId}`),
  publishDue: (now) => request('/scheduled-posts/publish-due', { method: 'POST', body: { now } }),

  // A null authorId asks for every tenant. Allowed only for a session holding
  // tenant.read.all — the server refuses it otherwise, which is the point
  // (STORY-019).
  auditLog: (authorId, limit = 50) =>
    request(`/audit-log?${authorId === null ? '' : `authorId=${authorId}&`}limit=${limit}`),

  // STORY-002 — opportunities and outreach
  // `types` narrows the scan to one kind of engagement (STORY-010).
  scout: (authorId, bookId, types = null) =>
    request(`/authors/${authorId}/books/${bookId}/opportunities/scout`, {
      method: 'POST',
      body: types ? { types } : undefined,
    }),

  // STORY-010 — the leads the filter hid, and how close each came.
  opportunityRejections: (authorId) => request(`/authors/${authorId}/opportunity-rejections`),

  opportunities: (params) => request(`/opportunities?${new URLSearchParams(params)}`),
  monthlyOpportunities: (authorId) => request(`/authors/${authorId}/monthly-opportunities`),

  draftOutreach: (authorId, bookId, body = {}) =>
    request(`/authors/${authorId}/books/${bookId}/outreach/draft`, { method: 'POST', body }),

  outreachMessages: (params) => request(`/outreach-messages?${new URLSearchParams(params)}`),
  approveOutreach: (id, body) => request(`/outreach-messages/${id}/approve`, { method: 'POST', body }),
  rejectOutreach: (id, body) => request(`/outreach-messages/${id}/reject`, { method: 'POST', body }),
  sendOutreach: (id) => request(`/outreach-messages/${id}/send`, { method: 'POST' }),

  // STORY-003 — milestones and press materials
  milestones: (authorId) => request(`/authors/${authorId}/milestones`),

  createMilestone: (authorId, bookId, body) =>
    request(`/authors/${authorId}/books/${bookId}/milestones`, { method: 'POST', body }),

  draftPressKit: (milestoneId) => request(`/milestones/${milestoneId}/press-kit`, { method: 'POST' }),

  // STORY-018 — PR materials on request, with no milestone to wait for
  generatePrMaterials: (authorId, bookId, body = {}) =>
    request(`/authors/${authorId}/books/${bookId}/pr-materials`, { method: 'POST', body }),

  pressKits: (authorId) => request(`/press-kits?authorId=${authorId}`),
  pressContacts: () => request('/press-contacts'),

  approvePrMaterial: (id, body) => request(`/pr-materials/${id}/approve`, { method: 'POST', body }),
  rejectPrMaterial: (id, body) => request(`/pr-materials/${id}/reject`, { method: 'POST', body }),
  distributeKit: (id) => request(`/press-kits/${id}/distribute`, { method: 'POST' }),

  // STORY-004 — approaching milestones
  approachingMilestones: (authorId) => request(`/authors/${authorId}/milestones/approaching`),

  draftApproaching: (authorId, body = {}) =>
    request(`/authors/${authorId}/milestones/draft-approaching`, { method: 'POST', body }),

  // STORY-005 — award outcomes
  awardsAwaitingOutcome: (authorId) => request(`/authors/${authorId}/awards/awaiting-outcome`),

  recordAwardOutcome: (milestoneId, body) =>
    request(`/milestones/${milestoneId}/award-outcome`, { method: 'POST', body }),

  // STORY-006 — the grounding a press draft is written from
  bookThemes: (bookId) => request(`/books/${bookId}/themes`),

  // STORY-007 — human review, and telling a human there is something to review
  reviewers: (authorId) => request(`/authors/${authorId}/reviewers`),

  addReviewer: (authorId, body) =>
    request(`/authors/${authorId}/reviewers`, { method: 'POST', body }),

  setReviewerActive: (reviewerId, body) =>
    request(`/reviewers/${reviewerId}/active`, { method: 'POST', body }),

  pendingReview: (authorId) => request(`/authors/${authorId}/pending-review`),

  notifyPending: (authorId) =>
    request(`/authors/${authorId}/notify-pending`, { method: 'POST' }),

  notifications: (authorId) => request(`/notifications?authorId=${authorId}`),

  // STORY-021 — the score as a series, and how long each check has been failing
  trustHistory: (authorId, limit = 30) =>
    request(`/authors/${authorId}/trust-history?limit=${limit}`),

  // STORY-008 — what an independent check escalated, and why
  escalations: (authorId) => request(`/authors/${authorId}/escalations`),

  scanEscalations: (authorId) =>
    request(`/authors/${authorId}/escalations/scan`, { method: 'POST' }),

  // STORY-014 — one place to see whether the system is behaving
  trustDashboard: (authorId) => request(`/authors/${authorId}/trust-dashboard`),

  // STORY-013 — is the audit log still what it said it was?
  auditIntegrity: () => request('/audit-integrity'),
  verifyAuditIntegrity: () => request('/audit-integrity/verify', { method: 'POST' }),

  // STORY-012 — one queue across everything a human has to decide
  awaitingApproval: (authorId) => request(`/authors/${authorId}/awaiting-approval`),

  notifyAwaiting: (authorId) =>
    request(`/authors/${authorId}/awaiting-approval/notify`, { method: 'POST' }),

  // STORY-069 — meme vs text, and the mix proposals that follow from it
  formatPerformance: (authorId) => request(`/authors/${authorId}/format-performance`),

  // STORY-029 — every published post's series, and what the numbers can say
  contentPerformance: (authorId) => request(`/authors/${authorId}/content-performance`),

  collectEngagement: (authorId, formatEffect = 0) =>
    request(`/authors/${authorId}/engagement/collect`, { method: 'POST', body: { formatEffect } }),

  scanMixRecommendations: (authorId) =>
    request(`/authors/${authorId}/mix-recommendations/scan`, { method: 'POST' }),

  approveMix: (id, body) => request(`/mix-recommendations/${id}/approve`, { method: 'POST', body }),
  rejectMix: (id, body) => request(`/mix-recommendations/${id}/reject`, { method: 'POST', body }),

  // STORY-068 — the book's versioned visual identity
  visualIdentity: (authorId, bookId) =>
    request(`/authors/${authorId}/books/${bookId}/visual-identity`),

  reviseVisualIdentity: (authorId, bookId, body) =>
    request(`/authors/${authorId}/books/${bookId}/visual-identity`, { method: 'POST', body }),

  // STORY-067 — the meme template library
  memeTemplates: (bookId) =>
    request(`/meme-templates${bookId ? `?bookId=${bookId}` : ''}`),

  addMemeTemplate: (template) =>
    request('/meme-templates', { method: 'POST', body: template }),

  retireMemeTemplate: (key, reason) =>
    request(`/meme-templates/${key}/retire`, { method: 'POST', body: { reason } }),

  // STORY-027 — is the system up, from the checks that measured it
  systemHealth: () => request('/system/health'),
  runHealthCheck: () => request('/system/health-check', { method: 'POST' }),

  // STORY-042 — reviewed changes to who may do what
  // STORY-043: onboarding by invitation.
  tenants: () => request('/tenants'),
  onboardTenant: (body) => request('/tenants', { method: 'POST', body }),
  resendInvite: (authorId) => request(`/tenants/${authorId}/invite`, { method: 'POST' }),
  suspendTenant: (authorId, reason) => request(`/tenants/${authorId}/suspend`, { method: 'POST', body: { reason } }),
  restoreTenant: (authorId) => request(`/tenants/${authorId}/restore`, { method: 'POST' }),
  acceptInvite: async (token, password) => {
    const result = await request('/auth/accept-invite', { method: 'POST', body: { token, password } });
    session.set(result.token);
    return result.user;
  },
  access: () => request('/access'),
  proposeAccessChange: (body) => request('/access/changes', { method: 'POST', body }),
  approveAccessChange: (id, note = '') => request(`/access/changes/${id}/approve`, { method: 'POST', body: { note } }),
  rejectAccessChange: (id, note = '') => request(`/access/changes/${id}/reject`, { method: 'POST', body: { note } }),
  withdrawAccessChange: (id) => request(`/access/changes/${id}/withdraw`, { method: 'POST' }),

  // STORY-041 — the caller's own schema, and who this request ran as
  tenantSchema: (authorId) => request(`/authors/${authorId}/tenant-schema`),
  // STORY-057/058: what needs attention, and the governance score.
  attention: (authorId) => request(`/authors/${authorId}/attention`),
  governanceScore: (authorId, days = 30) => request(`/authors/${authorId}/governance-score?days=${days}`),
  // STORY-055: the search index.
  search: (authorId, params) =>
    request(`/authors/${authorId}/search?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`),
  searchStatus: (authorId) => request(`/authors/${authorId}/search/status`),
  // STORY-028: audit log reports.
  auditReport: (params = {}) =>
    request(`/audit-reports?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`),
  auditReportCsv: async (params = {}) => {
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v != null)), format: 'csv' });
    const r = await fetch(`/api/audit-reports?${q}`, { headers: { Authorization: `Bearer ${session.get()}` } });
    if (!r.ok) throw new Error(`Report download failed: ${r.status}`);
    return { text: await r.text(), filename: /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'audit-report.csv' };
  },
  // STORY-052: alerts to security officers.
  securityNotifications: () => request('/security/notifications'),
  acknowledgeNotification: (id, note = '') => request(`/security/notifications/${id}/acknowledge`, { method: 'POST', body: { note } }),
  // STORY-051: the security log.
  securityLog: (params = {}) =>
    request(`/security/audit-access?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`),
  // STORY-050: who may read and manage the audit logs.
  auditAccessPolicy: () => request('/security/audit-access-policy'),
  // STORY-048: the feedback loop.
  rateDraft: (draftId, body) => request(`/drafts/${draftId}/feedback`, { method: 'POST', body }),
  applyFeedback: (authorId, bookId) => request(`/authors/${authorId}/books/${bookId}/feedback/apply`, { method: 'POST' }),
  // STORY-047: a reviewer's third answer.
  requestChanges: (draftId, note) => request(`/drafts/${draftId}/request-changes`, { method: 'POST', body: { note } }),
  // STORY-046: the model fitted to each book.
  bookModel: (authorId, bookId) => request(`/authors/${authorId}/books/${bookId}/model`),
  addBookMaterial: (authorId, bookId, body) => request(`/authors/${authorId}/books/${bookId}/materials`, { method: 'POST', body }),
  // STORY-045: per-tenant API keys.
  apiKeys: (authorId) => request(`/authors/${authorId}/api-keys`),
  createApiKey: (authorId, body) => request(`/authors/${authorId}/api-keys`, { method: 'POST', body }),
  revokeApiKey: (authorId, id) => request(`/authors/${authorId}/api-keys/${id}/revoke`, { method: 'POST' }),
  // STORY-044: the access audit.
  accessEvents: (authorId) => request(`/authors/${authorId}/access-events`),
  accessReport: (params = {}) =>
    request(`/security/access?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null))}`),
  blockAccount: (userId, reason) => request(`/security/accounts/${userId}/block`, { method: 'POST', body: { reason } }),
  unblockAccount: (userId) => request(`/security/accounts/${userId}/unblock`, { method: 'POST' }),

  // STORY-039 — messages between agents
  messages: () => request('/messages'),
  redeliverMessage: (id) => request(`/messages/${id}/redeliver`, { method: 'POST' }),

  // STORY-065 — background worker run health
  jobs: () => request('/jobs'),
  runWorkerCycle: () => request('/jobs/tick', { method: 'POST' }),
  retryJob: (jobId) => request(`/jobs/${jobId}/retry`, { method: 'POST' }),
};
