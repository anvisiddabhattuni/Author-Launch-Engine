import { closePool, query } from './pool.js';

// Posting windows are hours in UTC. Values reflect commonly cited engagement
// peaks per platform and are the "optimal times" the scheduler targets.
const WINDOWS = [
  { platform: 'twitter', bestHours: [13, 15, 17], bestDays: [1, 2, 3, 4, 5], maxChars: 280 },
  { platform: 'instagram', bestHours: [16, 18, 20], bestDays: [1, 2, 3, 4, 5, 6], maxChars: 2200 },
  { platform: 'facebook', bestHours: [14, 16, 19], bestDays: [2, 3, 4, 5], maxChars: 63206 },
  { platform: 'linkedin', bestHours: [12, 14, 16], bestDays: [2, 3, 4], maxChars: 3000 },
];

const BOOK_CONTENT = `
Every craft has a moment where technique stops being the point. The potter stops counting
revolutions. The writer stops counting words. What remains is attention, and attention is the
only real currency any of us spend. This book is about that shift, and about the ordinary
discipline that makes it possible.

Deep work is not a productivity trick. It is a way of refusing the terms the world offers you by
default. The world offers interruption as a baseline condition and calls it connection. Choosing
otherwise is quiet, unglamorous, and almost entirely invisible to everyone but you.

Craft is the slow accumulation of decisions nobody claps for. A carpenter planes a joint that will
be hidden inside a cabinet for a hundred years. That joint is where the work lives. Readers can
always tell when the hidden joints were done well, even when they cannot say why.

Attention is a muscle, and like any muscle it adapts to the load you give it. Give it fragments and
it becomes good at fragments. Give it long, difficult, unresolved problems and it becomes good at
those instead. Nothing about this is mystical; it is simply practice.

Resilience is what remains when motivation has gone home for the evening. The people who finish
things are rarely the most inspired people in the room. They are the ones who showed up on the
unremarkable Tuesday when nothing was working and the sentences were bad.

The hardest part of any long project is the middle, where the initial excitement has faded and the
end is not yet visible. Craft is mostly a set of habits for surviving the middle without quitting.
`.trim();

const HISTORY = [
  {
    platform: 'twitter',
    content:
      'Spent the morning reworking one paragraph. Attention is a muscle and mine was weak today. Showed up anyway.',
    engagement: { likes: 240, reposts: 31 },
    daysAgo: 21,
  },
  {
    platform: 'twitter',
    content:
      'Craft is the slow accumulation of decisions nobody claps for. Still the most useful thing I know about writing.',
    engagement: { likes: 512, reposts: 88 },
    daysAgo: 17,
  },
  {
    platform: 'instagram',
    content:
      'The desk at 6am. No inspiration in sight, just practice and a bad first sentence. Resilience looks boring from the outside.',
    engagement: { likes: 1320, comments: 46 },
    daysAgo: 14,
  },
  {
    platform: 'linkedin',
    content:
      'Deep work is not a productivity trick. It is a refusal of interruption as a default condition. That reframing changed how I run my week.',
    engagement: { likes: 410, comments: 37 },
    daysAgo: 10,
  },
  {
    platform: 'facebook',
    content:
      'A reader asked how I survive the middle of a long project. Honest answer: habits, not motivation. The middle is where craft actually lives.',
    engagement: { likes: 190, comments: 24 },
    daysAgo: 6,
  },
];

// Stand-in media list. Five cover beats that overlap the book's themes and two
// deliberately do not, so targeting has something to exclude.
const PRESS_CONTACTS = [
  {
    outlet: 'The Longform Review',
    name: 'Dana Whitfield',
    email: 'dana.whitfield@longformreview.test',
    beats: ['craft', 'writing', 'books'],
  },
  {
    outlet: 'Focus Quarterly',
    name: 'Sam Iyer',
    email: 's.iyer@focusquarterly.test',
    beats: ['deep work', 'attention', 'productivity'],
  },
  {
    outlet: 'The Bookshelf Desk',
    name: 'Priya Raman',
    email: 'priya@bookshelfdesk.test',
    beats: ['books', 'publishing', 'craft'],
  },
  {
    outlet: 'Working Life',
    name: 'Tomas Beck',
    email: 'tbeck@workinglife.test',
    beats: ['resilience', 'careers', 'work'],
  },
  {
    outlet: 'Culture Wire',
    name: 'Alina Duarte',
    email: 'alina@culturewire.test',
    beats: ['arts', 'culture', 'attention'],
  },
  {
    outlet: 'Fintech Daily',
    name: 'Greg Olsen',
    email: 'greg@fintechdaily.test',
    beats: ['fintech', 'markets', 'crypto'],
  },
  {
    outlet: 'Auto Trade Weekly',
    name: 'Marta Silva',
    email: 'marta@autotradeweekly.test',
    beats: ['automotive', 'logistics', 'freight'],
  },
];

// One of each milestone type REQ-003 names, so the drafting angle can be seen
// changing between them.
const MILESTONES = [
  {
    type: 'launch',
    title: 'The Quiet Craft — hardcover launch',
    inDays: 21,
    location: 'Ljubljana',
    details: 'New hardcover edition, print run of 8,000 copies, with a reading at the city library.',
  },
  // Deliberately a few days ago: the ceremony has happened and nobody has
  // recorded the result, which is the state STORY-005 exists to notice. The
  // shortlist is still news until a win or a loss is written down.
  {
    type: 'award',
    title: 'The Quiet Craft shortlisted for the Vermilion Prize for Nonfiction',
    inDays: -3,
    location: 'London',
    details: 'One of six titles shortlisted; the winner was announced at a ceremony in London.',
    awardName: 'Vermilion Prize for Nonfiction',
  },
  // Deliberately the *second* anniversary, and deliberately inside the default
  // 30-day lead-time window: it is what proves the copy counts anniversaries
  // instead of assuming the first, and it gives the STORY-004 watcher something
  // real to find.
  {
    type: 'anniversary',
    title: 'The Quiet Craft — two years in print',
    inDays: 24,
    location: '',
    details: 'Two years since publication, with a paperback edition to follow.',
  },
];

/** The anniversary above is the book's second, so publication is two years before it. */
const ANNIVERSARY = MILESTONES.find((m) => m.type === 'anniversary');

const isoDate = (inDays) =>
  new Date(Date.now() + inDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * Calendar-year arithmetic, not 365-day arithmetic: subtracting days would land
 * a day off across a leap year and turn the second anniversary into the first.
 */
function minusYears(iso, years) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(y - years).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const PUBLISHED_ON = minusYears(isoDate(ANNIVERSARY.inDays), 2);

async function seed() {
  for (const w of WINDOWS) {
    await query(
      `INSERT INTO platform_windows (platform, best_hours, best_days, max_chars)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (platform) DO UPDATE
         SET best_hours = EXCLUDED.best_hours,
             best_days  = EXCLUDED.best_days,
             max_chars  = EXCLUDED.max_chars`,
      [w.platform, w.bestHours, w.bestDays, w.maxChars],
    );
  }
  console.log(`seeded ${WINDOWS.length} platform windows`);

  const { rows: authorRows } = await query(
    `INSERT INTO authors (name, email, voice_profile)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, voice_profile = EXCLUDED.voice_profile
     RETURNING *`,
    [
      'Mira Kovač',
      'mira@example.test',
      JSON.stringify({
        tone: ['plain', 'unsentimental', 'warm'],
        habits: ['short declarative sentences', 'concrete images', 'no hype'],
        avoid: ['exclamation marks', 'growth-hacking language'],
      }),
    ],
  );
  const author = authorRows[0];
  console.log(`seeded author ${author.name} (id ${author.id})`);

  await query('DELETE FROM books WHERE author_id = $1', [author.id]);
  const { rows: bookRows } = await query(
    `INSERT INTO books (author_id, title, content, themes, published_on)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      author.id,
      'The Quiet Craft',
      BOOK_CONTENT,
      ['deep work', 'craft', 'attention', 'resilience'],
      PUBLISHED_ON,
    ],
  );
  console.log(`seeded book "${bookRows[0].title}" (id ${bookRows[0].id}), published ${PUBLISHED_ON}`);

  await query('DELETE FROM social_history WHERE author_id = $1', [author.id]);
  for (const h of HISTORY) {
    const postedAt = new Date(Date.now() - h.daysAgo * 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO social_history (author_id, platform, content, engagement, posted_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [author.id, h.platform, h.content, JSON.stringify(h.engagement), postedAt.toISOString()],
    );
  }
  console.log(`seeded ${HISTORY.length} prior posts`);

  for (const c of PRESS_CONTACTS) {
    await query(
      `INSERT INTO press_contacts (outlet, name, email, beats)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE
         SET outlet = EXCLUDED.outlet, name = EXCLUDED.name, beats = EXCLUDED.beats`,
      [c.outlet, c.name, c.email, c.beats],
    );
  }
  console.log(`seeded ${PRESS_CONTACTS.length} press contacts`);

  // Milestones hang off the book, which is recreated above, so they are gone
  // already; insert rather than upsert.
  for (const m of MILESTONES) {
    await query(
      `INSERT INTO milestones
         (author_id, book_id, type, title, event_date, location, details, award_name, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (book_id, type, event_date) DO NOTHING`,
      [
        author.id,
        bookRows[0].id,
        m.type,
        m.title,
        isoDate(m.inDays),
        m.location,
        m.details,
        m.awardName ?? null,
        m.type === 'award' ? 'shortlisted' : null,
      ],
    );
  }
  console.log(`seeded ${MILESTONES.length} milestones`);

  console.log(`\nseed complete — authorId=${author.id} bookId=${bookRows[0].id}`);
}

try {
  await seed();
} finally {
  await closePool();
}
