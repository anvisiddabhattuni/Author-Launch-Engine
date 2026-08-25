import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

function newsHook({ milestone, anniversaryYears, awardOutcome, awardName }) {
  if (milestone.type === 'launch') return 'the book is being published';
  if (milestone.type === 'award') {
    const prize = awardName ? `the ${awardName}` : 'a major nonfiction prize';
    // Understating a win is a disservice; overstating a shortlisting is a false
    // claim. Neither is left to the model to infer from the title.
    return awardOutcome === 'won'
      ? `the book has WON ${prize}`
      : `the book has been shortlisted for ${prize} and has not won it`;
  }
  if (milestone.type !== 'anniversary') return 'there is news about the book';
  // Never state a year the data does not support: an unknown count becomes a
  // vaguer hook rather than an invented "first anniversary".
  return anniversaryYears
    ? `the book has been in print for ${anniversaryYears} year${anniversaryYears === 1 ? '' : 's'}`
    : 'the book is marking an anniversary of its publication';
}

/**
 * The retrieved context block (STORY-006).
 *
 * Replaces the first 2,500 characters of the book, which was not retrieval — it
 * was whatever happened to be at the front. Each theme now arrives with what
 * the book claims about it and the passages that back the claim, so the model
 * is grounded in the part of the book that is relevant to the themes it has to
 * reflect.
 */
function groundedThemes(grounding) {
  const themes = grounding?.themes ?? [];
  if (themes.length === 0) return [];

  return [
    'THEMES, GROUNDED IN THE BOOK ITSELF. Use these passages as your source for what the',
    'book argues. Do not contradict them, and do not add claims they do not support.',
    '',
    ...themes.flatMap((entry) => [
      `THEME: ${entry.theme}`,
      entry.keyMessage ? `  Key message: ${entry.keyMessage}` : null,
      // A theme with nothing behind it is said so plainly. Left unmarked, the
      // model would fill the silence with a plausible-sounding claim.
      entry.passages.length === 0
        ? '  No passage in the book evidences this theme. Do not invent one.'
        : null,
      ...entry.passages.map((passage) => `  From the book: ${passage.content}`),
      '',
    ]),
  ].filter((line) => line !== null);
}

function buildPrompt({
  milestone, book, author, anniversaryYears, awardOutcome, awardName, grounding,
}) {
  return [
    `Write a press kit for the book "${book.title}" by ${author.name}.`,
    '',
    `Milestone type: ${milestone.type}`,
    `Milestone: ${milestone.title}`,
    `Date: ${milestone.event_date}`,
    `Location: ${milestone.location || 'not specified'}`,
    `Details: ${milestone.details}`,
    awardName ? `Award: ${awardName}` : null,
    `The news hook is that ${newsHook({ milestone, anniversaryYears, awardOutcome, awardName })}.`,
    awardOutcome === 'won'
      ? 'The book WON. Lead with the win. Do not describe it as a shortlisting or a nomination.'
      : null,
    awardOutcome === 'shortlisted'
      ? 'The book was shortlisted and has NOT won. Do not imply or state that it won.'
      : null,
    anniversaryYears
      ? `This is the book's anniversary number ${anniversaryYears}. Do not describe it as any ` +
        'other anniversary, and do not call it the first unless that number is 1.'
      : null,
    '',
    `Author voice: ${JSON.stringify(author.voice_profile)}`,
    `Author contact: ${author.email}`,
    '',
    ...groundedThemes(grounding),
    '',
    'Produce exactly three materials:',
    '1. press_release — standard release: FOR IMMEDIATE RELEASE, headline, dateline, lede,',
    '   supporting paragraphs, a quote attributed to the author, an ABOUT THE BOOK boilerplate,',
    '   and a MEDIA CONTACT line.',
    '2. author_bio — third person, roughly 100 words.',
    '3. fact_sheet — short labelled lines a journalist can lift verbatim.',
    '',
    'Every material must reference the themes above using those exact words, AND must carry the',
    'argument behind each one in the book\'s own language. Alignment is checked twice: once for',
    'the theme being named and once for its key message being reflected, and a material that',
    'only name-checks a theme scores as though it had missed it. Sound like the author, not',
    'like a marketer. No exclamation marks, no hype.',
    '',
    'Respond with JSON only, no prose, in exactly this shape:',
    '{"materials":[{"type":"press_release","headline":"...","body":"...","themesUsed":["..."]}]}',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const REQUIRED_TYPES = ['press_release', 'author_bio', 'fact_sheet'];

function parseKit(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Anthropic response contained no JSON object: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(raw.slice(start, end + 1));
  const materials = Array.isArray(parsed.materials) ? parsed.materials : [];

  const missing = REQUIRED_TYPES.filter(
    (type) => !materials.some((m) => m.type === type && m.headline && m.body),
  );
  if (missing.length > 0) {
    throw new Error(`Anthropic response is missing complete materials: ${missing.join(', ')}`);
  }

  return REQUIRED_TYPES.map((type) => {
    const material = materials.find((m) => m.type === type);
    return {
      type,
      headline: material.headline,
      body: material.body,
      themesUsed: Array.isArray(material.themesUsed) ? material.themesUsed : [],
    };
  });
}

export const prAnthropicProvider = {
  name: 'anthropic',

  async draftKit({
    milestone,
    book,
    author,
    anniversaryYears = null,
    awardOutcome = null,
    awardName = null,
    grounding = null,
  }) {
    if (!config.anthropicApiKey) {
      throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: buildPrompt({
              milestone,
              book,
              author,
              anniversaryYears,
              awardOutcome,
              awardName,
              grounding,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${await response.text()}`);
    }

    const body = await response.json();
    const text = (body.content ?? []).map((part) => part.text ?? '').join('');
    return parseKit(text);
  },
};
