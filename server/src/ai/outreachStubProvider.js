/**
 * Deterministic outreach message provider.
 *
 * Composes a pitch from the opportunity's own details and a sentence from the
 * book, with no network call, so the demo and tests stay reproducible. Each
 * opportunity type gets a different framing because a podcast booking request
 * and a conference CFP are not the same ask.
 */

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = (items, seed) => items[Math.abs(seed) % items.length];

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 200);
}

const SUBJECTS = {
  podcast: (o, book) => `Guest pitch for ${o.name}: ${book.title}`,
  speaking: (o, book) => `Speaker proposal for ${o.name} — ${book.title}`,
  event: (o, book) => `${book.title} at ${o.name}?`,
};

const OPENERS = {
  podcast: (o, topic) =>
    `I have been listening to ${o.name}, and your episodes on ${topic} are the reason I am writing.`,
  speaking: (o, topic) =>
    `I saw that ${o.name} is programming sessions on ${topic}, and I would like to propose a talk.`,
  event: (o, topic) =>
    `I noticed ${o.name} covers ${topic}, and I would love to take part this year.`,
};

const ASKS = {
  podcast: (o) => `Would you be open to having me on ${o.name} this season?`,
  speaking: (o) => `Would a 30-minute talk fit what you are planning for ${o.name}?`,
  event: (o) => `Is there still room on the ${o.name} programme?`,
};

/**
 * What the book actually claims about a theme.
 *
 * The key message a human wrote if there is one, otherwise the sentence in the
 * retrieved evidence that mentions the theme. Null when nothing in the book
 * argues it — the pitch then says nothing about it rather than inventing a
 * claim, the same rule the press stub follows.
 */
function claimFor(entry) {
  if (!entry) return null;
  if (entry.keyMessage) return entry.keyMessage;
  const needle = entry.theme.toLowerCase();
  for (const passage of entry.passages ?? []) {
    const own = passage.content
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .find((sentence) => sentence.toLowerCase().includes(needle));
    if (own) return own;
  }
  return null;
}

export const outreachStubProvider = {
  name: 'stub',

  /**
   * @returns {{subject: string, body: string, personalization: string[]}}
   */
  async draftMessage({ opportunity, book, author, grounding = null }) {
    const seed = hash(`${opportunity.id}:${book.id}`);
    const topic = opportunity.matched_themes.length > 0
      ? pick(opportunity.matched_themes, seed)
      : pick(opportunity.topics.length > 0 ? opportunity.topics : ['your work'], seed);

    // STORY-023 changed where the words come from. The pitch used to quote a
    // sentence picked at random out of the whole book — which is not retrieval,
    // it is whatever happened to be in range. It now writes from the claims
    // retrieval found for the themes this opportunity is actually about, which
    // is the generation half of RAG and the reason alignment is now something
    // the drafter does rather than something done to the draft afterwards.
    const entries = (grounding?.themes ?? []).filter(
      (t) => opportunity.matched_themes.length === 0 || opportunity.matched_themes.includes(t.theme),
    );
    const claims = entries
      .map((entry) => ({ theme: entry.theme, claim: claimFor(entry) }))
      .filter((c) => c.claim)
      .slice(0, 2);

    const lines = sentences(book.content);
    const line = claims[0]?.claim ?? (lines.length > 0 ? pick(lines, seed >>> 5) : book.title);

    const subject = (SUBJECTS[opportunity.type] ?? SUBJECTS.event)(opportunity, book);
    const greeting = opportunity.host ? `Hi ${opportunity.host.split(' ')[0]},` : 'Hello,';

    const body = [
      greeting,
      '',
      (OPENERS[opportunity.type] ?? OPENERS.event)(opportunity, topic),
      '',
      `I wrote "${book.title}", which sits squarely on ${topic}.`,
      '',
      // The claims, stated as claims. A host reading this should be able to
      // tell what the book argues, not only what shelf it belongs on.
      claims.length > 0 ? 'What the book argues:' : null,
      ...claims.map(({ theme, claim }) => `On ${theme} — ${claim}`),
      claims.length > 0 ? '' : null,
      'One line that tends to start the best conversations:',
      '',
      `"${line}"`,
      '',
      `${(ASKS[opportunity.type] ?? ASKS.event)(opportunity)} I am happy to work around your schedule, and I can send notes or questions in advance if that helps.`,
      '',
      'Thanks for your time,',
      author.name,
    ]
      .filter((part) => part !== null)
      .join('\n');

    // Recorded so the confidence score can check the message actually used
    // these specifics rather than reading like a form letter.
    return {
      subject,
      body,
      personalization: [opportunity.name, opportunity.host, topic].filter(Boolean),
    };
  },
};
