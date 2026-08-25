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
    if (response.status === 401 && path !== '/auth/login') {
      session.clear();
      onSessionLost();
    }
    // `??` only guards null and undefined. An empty-string error passed straight
    // through, and an empty message renders as no message at all — which is how
    // a dead database turned into a Sign in button that did nothing and said
    // nothing.
    const serverMessage = typeof payload?.error === 'string' ? payload.error.trim() : '';
    throw new Error(serverMessage || `Request failed with ${response.status}`);
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

  auditLog: (authorId, limit = 50) => request(`/audit-log?authorId=${authorId}&limit=${limit}`),

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

  // STORY-008 — what an independent check escalated, and why
  escalations: (authorId) => request(`/authors/${authorId}/escalations`),

  scanEscalations: (authorId) =>
    request(`/authors/${authorId}/escalations/scan`, { method: 'POST' }),

  // STORY-067 — the meme template library
  memeTemplates: () => request('/meme-templates'),

  addMemeTemplate: (template) =>
    request('/meme-templates', { method: 'POST', body: template }),

  retireMemeTemplate: (key, reason) =>
    request(`/meme-templates/${key}/retire`, { method: 'POST', body: { reason } }),

  // STORY-065 — background worker run health
  jobs: () => request('/jobs'),
  runWorkerCycle: () => request('/jobs/tick', { method: 'POST' }),
  retryJob: (jobId) => request(`/jobs/${jobId}/retry`, { method: 'POST' }),
};
