/**
 * The unit tier (STORY-053): the decisions this product makes that need no
 * database, tested as pure functions — in milliseconds, before the integration
 * tier spends minutes on a real Postgres.
 *
 * No test here connects to anything. The rest of the suite is integration by
 * design (STORY-013: the append-only and tenant rules live in the database, so
 * a mock database would test a different product); these are the parts that
 * were always logic.
 *
 * Run alone:  npm run test:unit
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { weekStart, withoutTitle } from '../../src/agents/contentDraftingAgent.js';
import { learnLexicon, learnPreferences, quotedPassages, scoreWith } from '../../src/services/bookModel.js';
import { bookStyle, compareStyle } from '../../src/services/contentReview.js';
import { auditRouteFor, describeRequest } from '../../src/services/dataAccess.js';
import { assess } from '../../src/services/escalationPolicy.js';
import { measure } from '../../src/services/voiceProfile.js';

describe('Voice and style are counted, the same way on both sides (STORY-007, STORY-047)', () => {
  it('measure counts exclamations, hype and capitals per 100 words', () => {
    const m = measure('This is AMAZING! A must-read bestseller!');
    assert.ok(m.exclamationsPer100 > 20);
    assert.ok(m.hypePer100 > 0);
    assert.ok(m.shoutedPer100 > 0);
  });

  it('a draft in a register the book never uses misses on exactly those elements', () => {
    const style = bookStyle({ content: 'The field keeps its own time. We wait through the frost. The seed does its slow work.' });
    const misses = compareStyle('BUY NOW!!! An amazing, must-read bestseller!', style).filter((s) => !s.fits).map((s) => s.element);
    assert.deepEqual(misses.sort(), ['exclamations', 'hype', 'shouting']);
  });
});

describe('The book model learns from examples, bounded (STORY-046, STORY-048)', () => {
  it('learns terms over-represented in the examples, never the theme\'s own word, never generic words', () => {
    const lexicon = learnLexicon({
      themeLexemes: ['grief'],
      examples: [['grief', 'chair', 'coat'], ['grief', 'chair', 'coat', 'could'], ['grief', 'coat', 'could']],
      background: [['field', 'seed'], ['frost', 'seed'], ['could', 'field']],
    });
    const terms = lexicon.map((l) => l.term);
    assert.ok(terms.includes('chair') && terms.includes('coat'));
    assert.ok(!terms.includes('grief'));
    assert.ok(!terms.includes('could'), 'a generic word was learned');
  });

  it('scores a passage by the lexicon terms it contains', () => {
    const { score, hits } = scoreWith([{ term: 'chair', weight: 2 }, { term: 'coat', weight: 1 }], ['chair', 'table']);
    assert.deepEqual({ score, hits }, { score: 2, hits: 1 });
  });

  it('finds the passage a draft quotes, however the whitespace was wrapped', () => {
    const passages = [{ id: 1, content: 'His coat still hung on the hook by the door. Nobody moved it.' }, { id: 2, content: 'The frost went in April.' }];
    assert.deepEqual(quotedPassages('On loss:\n\nHis coat   still hung on the hook\nby the door.', passages).map((p) => p.id), [1]);
  });

  it('feedback needs two judgments, and themes stay between 0.5 and 1.5', () => {
    const one = learnPreferences([{ draftId: 1, label: -1, themes: ['grief'], passages: [9], notes: [] }]);
    assert.equal(one.passages[0].weight, 1);
    const many = learnPreferences(Array.from({ length: 30 }, (_, i) => ({ draftId: i, label: -1, themes: ['grief'], passages: [9], notes: [] })));
    assert.equal(many.themes[0].weight, 0.5);
    assert.ok(many.passages[0].weight < 0.1);
  });
});

describe('Escalation floors (STORY-008)', () => {
  it('a draft below any floor escalates, and says which', () => {
    const r = assess({ confidence: 0.9, themeAlignment: 0.1, voice: 0.9 });
    assert.equal(r.status, 'escalated');
    assert.ok(r.reasons.length > 0);
    assert.equal(assess({ confidence: 0.95, themeAlignment: 0.95, voice: 0.95 }).status, 'pending_approval');
  });
});

describe('The access log classifies requests (STORY-044, STORY-051)', () => {
  const req = (over = {}) => ({
    method: 'GET', originalUrl: '/api/authors/7/books', path: '/authors/7/books', params: {}, ip: '127.0.0.1',
    get: () => 'UnitTest', route: { path: '/authors/:authorId/books' }, ...over,
  });
  const res = (statusCode, reason) => ({ statusCode, locals: { accessReason: reason } });

  it('names the tenant from the path, and the outcome from the status', () => {
    const e = describeRequest(req({ user: { id: 3, email: 'a@x', role: 'author', authorId: 5, permissions: [] } }), res(403, 'no'), 1.23);
    assert.equal(e.authorId, 7);
    assert.equal(e.outcome, 'denied');
    assert.equal(e.reason, 'no');
    assert.equal(e.dbRole, null);
  });

  it('recognises an attempt on an audit log even when refused before routing', () => {
    assert.equal(auditRouteFor('GET', '/authors/12/trust-history'), 'GET /authors/:authorId/trust-history');
    assert.equal(auditRouteFor('GET', '/audit-log'), 'GET /audit-log');
    assert.equal(auditRouteFor('GET', '/authors/12/books'), null);
    assert.equal(auditRouteFor('POST', '/audit-log'), null);
  });
});

describe('Small things that were once bugs', () => {
  it('weeks start on Monday, in UTC', () => {
    assert.equal(weekStart(new Date('2026-09-27T23:30:00Z')), '2026-09-21');
    assert.equal(weekStart(new Date('2026-09-28T00:10:00Z')), '2026-09-28');
  });

  it('a draft that only repeats the title is not credited with the title\'s words', () => {
    assert.ok(!withoutTitle('The Long Field is out now', 'The Long Field').includes('Long Field'));
  });
});
