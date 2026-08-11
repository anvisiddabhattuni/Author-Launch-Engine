/**
 * Mocked external directories for speaking engagements, podcasts and events
 * (STORY-002 build step 1).
 *
 * Each adapter mirrors the shape of a real directory search API — take a
 * query, return listings — so swapping in a live client later is a change
 * confined to this file. Listings are fixed and deterministic so the monthly
 * cadence criterion can be demonstrated repeatably.
 *
 * The catalogue deliberately mixes strong matches with off-topic listings, so
 * relevance filtering has something real to reject.
 */

const PODCASTS = [
  {
    externalId: 'pod-001',
    name: 'The Long Game',
    host: 'Dana Whitfield',
    contactEmail: 'booking@thelonggame.test',
    url: 'https://thelonggame.test',
    description:
      'Interviews with writers and makers about sustaining deep work over years rather than weeks.',
    topics: ['deep work', 'craft', 'creative practice'],
    audienceSize: 42000,
    deadlineInDays: 24,
  },
  {
    externalId: 'pod-002',
    name: 'Attention Span',
    host: 'Ravi Menon',
    contactEmail: 'hello@attentionspan.test',
    url: 'https://attentionspan.test',
    description:
      'A show about attention, focus and what the modern information diet does to the mind.',
    topics: ['attention', 'focus', 'technology'],
    audienceSize: 118000,
    deadlineInDays: 12,
  },
  {
    externalId: 'pod-003',
    name: 'Makers at Work',
    host: 'Sofia Lindqvist',
    contactEmail: 'guests@makersatwork.test',
    url: 'https://makersatwork.test',
    description: 'Conversations with craftspeople about the unglamorous discipline behind good work.',
    topics: ['craft', 'discipline', 'making'],
    audienceSize: 26000,
    deadlineInDays: 40,
  },
  {
    externalId: 'pod-004',
    name: 'Series A Diaries',
    host: 'Tom Beck',
    contactEmail: 'tom@seriesa.test',
    url: 'https://seriesa.test',
    description: 'Founders break down fundraising rounds, cap tables and venture term sheets.',
    topics: ['fundraising', 'venture capital', 'startups'],
    audienceSize: 90000,
    deadlineInDays: 15,
  },
  {
    externalId: 'pod-005',
    name: 'The Resilient Hour',
    host: 'Grace Okonjo',
    contactEmail: 'booking@resilienthour.test',
    url: 'https://resilienthour.test',
    description:
      'Stories about resilience and finishing hard things long after the motivation runs out.',
    topics: ['resilience', 'persistence', 'psychology'],
    audienceSize: 55000,
    deadlineInDays: 30,
  },
  {
    externalId: 'pod-006',
    name: 'Kitchen Confidential Radio',
    host: 'Marco Duarte',
    contactEmail: 'marco@kcradio.test',
    url: 'https://kcradio.test',
    description: 'Restaurant chefs talk menus, sourcing and service.',
    topics: ['food', 'restaurants', 'cooking'],
    audienceSize: 31000,
    deadlineInDays: 20,
  },
];

const SPEAKING = [
  {
    externalId: 'spk-001',
    name: 'Craft & Practice Summit',
    host: 'Ines Aubert',
    contactEmail: 'program@craftpractice.test',
    url: 'https://craftpractice.test',
    description:
      'A one-day summit on craft, deliberate practice and the habits that carry long projects.',
    topics: ['craft', 'deliberate practice', 'deep work'],
    audienceSize: 600,
    deadlineInDays: 35,
  },
  {
    externalId: 'spk-002',
    name: 'Focus Forward Conference',
    host: 'Peter Nkemelu',
    contactEmail: 'speakers@focusforward.test',
    url: 'https://focusforward.test',
    description: 'Keynotes on attention, knowledge work and protecting focus inside organisations.',
    topics: ['attention', 'focus', 'knowledge work'],
    audienceSize: 1400,
    deadlineInDays: 18,
  },
  {
    externalId: 'spk-003',
    name: 'Regional Logistics Expo',
    host: 'Hannah Vogel',
    contactEmail: 'cfp@logisticsexpo.test',
    url: 'https://logisticsexpo.test',
    description: 'Freight, warehousing and supply chain operations for the midwest region.',
    topics: ['logistics', 'supply chain', 'warehousing'],
    audienceSize: 2200,
    deadlineInDays: 45,
  },
  {
    externalId: 'spk-004',
    name: 'Writers in Residence Series',
    host: 'Clara Boateng',
    contactEmail: 'residency@writersinresidence.test',
    url: 'https://writersinresidence.test',
    description:
      'A university lecture series inviting authors to speak on craft, attention and the writing life.',
    topics: ['craft', 'writing', 'attention'],
    audienceSize: 320,
    deadlineInDays: 50,
  },
];

const EVENTS = [
  {
    externalId: 'evt-001',
    name: 'Northside Book Festival',
    host: 'Yusuf Karim',
    contactEmail: 'panels@northsidebooks.test',
    url: 'https://northsidebooks.test',
    description: 'Author panels and readings, with a track on craft and the working writer.',
    topics: ['books', 'craft', 'author panels'],
    audienceSize: 5000,
    deadlineInDays: 28,
  },
  {
    externalId: 'evt-002',
    name: 'Quiet Work Retreat',
    host: 'Lena Fischer',
    contactEmail: 'apply@quietwork.test',
    url: 'https://quietwork.test',
    description: 'A weekend retreat on deep work, resilience and building an attention practice.',
    topics: ['deep work', 'resilience', 'attention'],
    audienceSize: 120,
    deadlineInDays: 22,
  },
  {
    externalId: 'evt-003',
    name: 'Crypto Builders Meetup',
    host: 'Dmitri Sokolov',
    contactEmail: 'organisers@cryptobuilders.test',
    url: 'https://cryptobuilders.test',
    description: 'Monthly meetup for protocol engineers and token designers.',
    topics: ['blockchain', 'protocols', 'tokens'],
    audienceSize: 400,
    deadlineInDays: 10,
  },
  {
    externalId: 'evt-004',
    name: 'Library Author Nights',
    host: 'Maureen Ellis',
    contactEmail: 'events@libraryauthornights.test',
    url: 'https://libraryauthornights.test',
    description: 'Evening talks where authors discuss their books with local reading groups.',
    topics: ['books', 'reading groups', 'author talks'],
    audienceSize: 90,
    deadlineInDays: 33,
  },
];

const withDeadline = (listing, type, source, from) => ({
  ...listing,
  type,
  source,
  deadline: new Date(from.getTime() + listing.deadlineInDays * 864e5).toISOString().slice(0, 10),
});

export const directories = {
  podcastIndex: {
    name: 'podcastIndex',
    type: 'podcast',
    async search({ from = new Date() } = {}) {
      return PODCASTS.map((l) => withDeadline(l, 'podcast', 'podcastIndex', from));
    },
  },
  speakerBureau: {
    name: 'speakerBureau',
    type: 'speaking',
    async search({ from = new Date() } = {}) {
      return SPEAKING.map((l) => withDeadline(l, 'speaking', 'speakerBureau', from));
    },
  },
  eventFinder: {
    name: 'eventFinder',
    type: 'event',
    async search({ from = new Date() } = {}) {
      return EVENTS.map((l) => withDeadline(l, 'event', 'eventFinder', from));
    },
  },
};

/** Queries every configured directory. Real adapters would run in parallel too. */
export async function searchAllDirectories({ from = new Date() } = {}) {
  const results = await Promise.all(Object.values(directories).map((d) => d.search({ from })));
  return results.flat();
}
