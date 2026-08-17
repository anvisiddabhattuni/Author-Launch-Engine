import { config } from '../config.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

function newsHook({ milestone, anniversaryYears }) {
  if (milestone.type === 'launch') return 'the book is being published';
  if (milestone.type === 'award') return 'the book has been shortlisted for a prize';
  if (milestone.type !== 'anniversary') return 'there is news about the book';
  // Never state a year the data does not support: an unknown count becomes a
  // vaguer hook rather than an invented "first anniversary".
  return anniversaryYears
    ? `the book has been in print for ${anniversaryYears} year${anniversaryYears === 1 ? '' : 's'}`
    : 'the book is marking an anniversary of its publication';
}

function buildPrompt({ milestone, book, author, anniversaryYears }) {
  return [
    `Write a press kit for the book "${book.title}" by ${author.name}.`,
    '',
    `Milestone type: ${milestone.type}`,
    `Milestone: ${milestone.title}`,
    `Date: ${milestone.event_date}`,
    `Location: ${milestone.location || 'not specified'}`,
    `Details: ${milestone.details}`,
    `The news hook is that ${newsHook({ milestone, anniversaryYears })}.`,
    anniversaryYears
      ? `This is the book's anniversary number ${anniversaryYears}. Do not describe it as any ` +
        'other anniversary, and do not call it the first unless that number is 1.'
      : null,
    '',
    `Book themes: ${book.themes.join(', ')}`,
    `Author voice: ${JSON.stringify(author.voice_profile)}`,
    `Author contact: ${author.email}`,
    `Book excerpt:\n${book.content.slice(0, 2500)}`,
    '',
    'Produce exactly three materials:',
    '1. press_release — standard release: FOR IMMEDIATE RELEASE, headline, dateline, lede,',
    '   supporting paragraphs, a quote attributed to the author, an ABOUT THE BOOK boilerplate,',
    '   and a MEDIA CONTACT line.',
    '2. author_bio — third person, roughly 100 words.',
    '3. fact_sheet — short labelled lines a journalist can lift verbatim.',
    '',
    'Every material must explicitly reference the book themes listed above using those exact',
    'words, because alignment with the book themes is checked and a material that ignores them',
    'is rejected. Sound like the author, not like a marketer. No exclamation marks, no hype.',
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

  async draftKit({ milestone, book, author, anniversaryYears = null }) {
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
          { role: 'user', content: buildPrompt({ milestone, book, author, anniversaryYears }) },
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
