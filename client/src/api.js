async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with ${response.status}`);
  }
  return payload;
}

export const api = {
  health: () => request('/health'),
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

  approve: (id, body) => request(`/drafts/${id}/approve`, { method: 'POST', body }),
  reject: (id, body) => request(`/drafts/${id}/reject`, { method: 'POST', body }),
  schedule: (id) => request(`/drafts/${id}/schedule`, { method: 'POST' }),

  scheduledPosts: (authorId) => request(`/scheduled-posts?authorId=${authorId}`),
  publishDue: (now) => request('/scheduled-posts/publish-due', { method: 'POST', body: { now } }),

  auditLog: (authorId, limit = 50) => request(`/audit-log?authorId=${authorId}&limit=${limit}`),

  // STORY-002 — opportunities and outreach
  scout: (authorId, bookId) =>
    request(`/authors/${authorId}/books/${bookId}/opportunities/scout`, { method: 'POST' }),

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
};
